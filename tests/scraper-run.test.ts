import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Base de test jetable et serveur local (adresse privée autorisée pour le test)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-run-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
process.env.SCRAPER_ALLOW_PRIVATE = "1";

let server: http.Server;
let origin = "";
const hits: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url?.startsWith("/flux.csv")) {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end("title;gtin;price;link\nPerceuse 18V;5060134334285;89,90;/p/perceuse\nScie;;12;/p/scie\n");
      return;
    }
    // Comme un site derrière Cloudflare qui refuse les robots : 403 partout
    res.writeHead(403, { server: "cloudflare", "cf-ray": "8a1b2c3d-CDG", "content-type": "text/html" });
    res.end("<html><title>Attention Required! | Cloudflare</title>Sorry, you have been blocked</html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function runAndWait(sourceId: number) {
  const { enqueueScrape, scrapeState } = await import("../src/lib/scraper/run");
  enqueueScrape(sourceId);
  for (let i = 0; i < 200 && (scrapeState().current || scrapeState().queue.length); i++) await new Promise((r) => setTimeout(r, 25));
  const { getDb } = await import("../src/lib/db");
  return getDb().prepare("SELECT * FROM scrape_runs WHERE source_id = ? ORDER BY id DESC LIMIT 1").get(sourceId) as Record<string, unknown>;
}

function addSource(mode: string, start_urls: string | null) {
  return import("../src/lib/db").then(({ getDb }) =>
    Number(
      getDb()
        .prepare(
          "INSERT INTO scrape_sources(name, base_url, mode, start_urls, interval_days, auto, max_pages, delay_ms, created_at) VALUES(?, ?, ?, ?, 21, 0, 50, 200, ?)",
        )
        .run("test", `${origin}/`, mode, start_urls, new Date().toISOString()).lastInsertRowid,
    ),
  );
}

test("site qui refuse les robots : arrêt immédiat, protection et étapes nommées", async () => {
  const id = await addSource("hybrid", null);
  hits.length = 0;
  const run = await runAndWait(id);
  assert.equal(run.status, "error");
  assert.match(String(run.message), /refuse l'accès aux robots \(HTTP 403, protection Cloudflare\) dès robots\.txt, sitemap/);
  assert.match(String(run.message), /mode FLUX/);
  assert.ok(hits.length <= 3, `pas d'insistance : ${hits.length} requêtes`);
  const details = JSON.parse(String(run.error_details));
  assert.deepEqual(details[0], { step: "robots.txt", url: `${origin}/robots.txt`, error: "HTTP 403 (Cloudflare)" });
});

test("mode FLUX : produits lus depuis un flux CSV, liens relatifs résolus", async () => {
  const id = await addSource("feed", `${origin}/flux.csv`);
  const run = await runAndWait(id);
  assert.equal(run.status, "success");
  assert.equal(run.offers_seen, 2);
  const { getDb } = await import("../src/lib/db");
  const rows = getDb().prepare("SELECT title, ean, price, url FROM scrape_products WHERE source_id = ? ORDER BY title").all(id);
  assert.deepEqual(rows, [
    { title: "Perceuse 18V", ean: "5060134334285", price: 89.9, url: `${origin}/p/perceuse` },
    { title: "Scie", ean: null, price: 12, url: `${origin}/p/scie` },
  ]);
});

test("import d'un fichier flux : enregistré comme un run", async () => {
  const id = await addSource("feed", null);
  const { importFeedFile } = await import("../src/lib/scraper/run");
  const r = importFeedFile(id, `<products><product><name>Niveau laser</name><ean>3148511238257</ean><price>45.00</price></product></products>`, "catalogue.xml");
  assert.equal(r.ok, true);
  assert.equal(r.newOffers, 1);
  assert.equal(importFeedFile(id, "a,b\n1,2\n", "vide.csv").ok, false);
});
