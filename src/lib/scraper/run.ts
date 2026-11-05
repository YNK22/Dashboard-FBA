import dns from "node:dns/promises";
import net from "node:net";
import zlib from "node:zlib";
import { getDb } from "../db";
import { extractLinks, extractProduct, normalizeUrl, parseRobots, parseSitemap, robotsAllows, sameSite, type Robots } from "./extract";

/**
 * Moteur de scraping : une source à la fois (file d'attente), en arrière-plan sur le serveur.
 * Respecte robots.txt et un délai entre deux pages ; refuse les adresses du réseau local.
 */

export interface ScrapeSource {
  id: number;
  name: string;
  base_url: string;
  mode: "sitemap" | "crawl" | "hybrid";
  start_urls: string | null;
  url_pattern: string | null;
  interval_days: number;
  auto: number;
  max_pages: number;
  delay_ms: number;
  next_run_at: string | null;
  created_at: string;
}

export interface Progress {
  runId: number;
  sourceId: number;
  startedAt: string;
  pages: number;
  offers: number;
  newProducts: number;
  newOffers: number;
  errors: number;
  queued: number; // pages restant à visiter (estimation)
  phase: string;
  cancel: boolean;
}

const UA = "Mozilla/5.0 (compatible; DashboardFBA/1.0; scraping produits)";
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_SITEMAPS = 300;

const state = ((globalThis as { __scraper?: { current: Progress | null; queue: number[]; working: boolean } }).__scraper ??= {
  current: null,
  queue: [],
  working: false,
});

export const scrapeState = () => ({ current: state.current, queue: [...state.queue] });

/* ---------- Téléchargement sécurisé ---------- */

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

const hostChecks = new Map<string, boolean>();
async function assertPublicHost(hostname: string): Promise<void> {
  if (process.env.SCRAPER_ALLOW_PRIVATE === "1") return;
  let ok = hostChecks.get(hostname);
  if (ok === undefined) {
    const addrs = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
    hostChecks.set(hostname, ok);
  }
  if (!ok) throw new Error(`adresse interdite (réseau local) : ${hostname}`);
}

/** GET avec délai max, redirections vérifiées une à une, taille limitée. */
async function fetchText(url: string, accept = "text/html,application/xhtml+xml"): Promise<{ status: number; url: string; text: string; type: string }> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocole non autorisé");
    await assertPublicHost(u.hostname);
    const res = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: `${accept};q=0.9,*/*;q=0.5`, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6" },
      signal: AbortSignal.timeout(25_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("page trop volumineuse");
    const body = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf; // sitemap .xml.gz
    return { status: res.status, url: current, text: body.toString("utf8"), type: res.headers.get("content-type") ?? "" };
  }
  throw new Error("trop de redirections");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- Filtre d'URL produit ---------- */

/** Le filtre accepte un texte simple (« /produit/ ») ou une expression régulière (« \.html$ »). */
export function urlFilter(pattern: string | null): (url: string) => boolean {
  const p = pattern?.trim();
  if (!p) return () => true;
  try {
    const re = new RegExp(p, "i");
    return (u) => re.test(u);
  } catch {
    const low = p.toLowerCase();
    return (u) => u.toLowerCase().includes(low);
  }
}

/* ---------- File d'attente ---------- */

/** Ajoute une source à la file. Renvoie false si elle y est déjà ou tourne déjà. */
export function enqueueScrape(sourceId: number): boolean {
  if (state.current?.sourceId === sourceId || state.queue.includes(sourceId)) return false;
  state.queue.push(sourceId);
  void work();
  return true;
}

/** Arrête le run en cours de cette source, ou la retire de la file. */
export function cancelScrape(sourceId: number): boolean {
  if (state.current?.sourceId === sourceId) {
    state.current.cancel = true;
    return true;
  }
  const i = state.queue.indexOf(sourceId);
  if (i >= 0) state.queue.splice(i, 1);
  return i >= 0;
}

async function work() {
  if (state.working) return;
  state.working = true;
  try {
    while (state.queue.length) {
      const id = state.queue.shift()!;
      const src = getDb().prepare("SELECT * FROM scrape_sources WHERE id = ?").get(id) as ScrapeSource | undefined;
      if (src) await runSource(src).catch((e) => console.error("[scraping]", src.name, e));
    }
  } finally {
    state.working = false;
    state.current = null;
  }
}

/** Au démarrage : les runs restés « en cours » (conteneur redémarré) sont marqués interrompus. */
export function markInterruptedRuns(): void {
  getDb()
    .prepare("UPDATE scrape_runs SET status = 'interrupted', finished_at = COALESCE(finished_at, ?), message = 'Serveur redémarré pendant le run' WHERE status = 'running'")
    .run(new Date().toISOString());
}

/** Lance les sources automatiques arrivées à échéance. */
export function scheduleDueScrapes(now = new Date()): void {
  const due = getDb()
    .prepare("SELECT id FROM scrape_sources WHERE auto = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
    .all(now.toISOString()) as { id: number }[];
  for (const s of due) enqueueScrape(s.id);
}

/* ---------- Un run ---------- */

async function runSource(src: ScrapeSource): Promise<void> {
  const db = getDb();
  const startedAt = new Date().toISOString();
  const runId = Number(db.prepare("INSERT INTO scrape_runs(source_id, started_at, status) VALUES(?, ?, 'running')").run(src.id, startedAt).lastInsertRowid);
  const p: Progress = { runId, sourceId: src.id, startedAt, pages: 0, offers: 0, newProducts: 0, newOffers: 0, errors: 0, queued: 0, phase: "Préparation", cancel: false };
  state.current = p;

  const saveProgress = db.prepare(
    "UPDATE scrape_runs SET pages_seen = ?, offers_seen = ?, new_products = ?, new_offers = ?, errors = ?, message = ? WHERE id = ?",
  );
  const flush = (message: string | null = null) => saveProgress.run(p.pages, p.offers, p.newProducts, p.newOffers, p.errors, message, runId);

  const findOffer = db.prepare("SELECT id FROM scrape_products WHERE source_id = ? AND url = ?");
  const eanKnown = db.prepare("SELECT 1 FROM scrape_products WHERE ean = ? LIMIT 1");
  const insertOffer = db.prepare(
    "INSERT INTO scrape_products(source_id, url, title, ean, price, currency, first_seen, last_seen) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const updateOffer = db.prepare(
    "UPDATE scrape_products SET title = ?, ean = COALESCE(?, ean), price = ?, currency = ?, last_seen = ? WHERE id = ?",
  );

  let status: "success" | "error" | "cancelled" = "success";
  let message: string | null = null;
  try {
    const base = new URL(src.base_url);
    const host = base.hostname;
    const starts = (src.start_urls ?? "")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => new URL(s, base).toString());
    const isProductUrl = urlFilter(src.url_pattern);

    // robots.txt
    p.phase = "robots.txt";
    let robots: Robots = { rules: [], sitemaps: [], crawlDelay: null };
    try {
      const r = await fetchText(new URL("/robots.txt", base).toString(), "text/plain");
      if (r.status === 200) robots = parseRobots(r.text);
    } catch {
      // pas de robots.txt : tout est autorisé
    }
    const delay = Math.max(src.delay_ms, Math.min((robots.crawlDelay ?? 0) * 1000, 10_000));

    const visited = new Set<string>();
    const productQueue: string[] = []; // URLs qui ressemblent à des fiches produit : prioritaires
    const pageQueue: string[] = []; // autres pages à explorer (mode crawl)
    const push = (u: string) => {
      let n: string;
      try {
        n = normalizeUrl(u);
      } catch {
        return;
      }
      if (visited.has(n) || !sameSite(new URL(n).hostname, host)) return;
      visited.add(n);
      if (src.url_pattern?.trim() ? isProductUrl(n) : false) productQueue.push(n);
      else pageQueue.push(n);
    };

    // 1. Sitemaps
    if (src.mode !== "crawl") {
      p.phase = "Lecture du sitemap";
      const sitemapStarts = starts.filter((s) => /sitemap|\.xml(\.gz)?$/i.test(s));
      const queue = sitemapStarts.length ? sitemapStarts : robots.sitemaps.length ? robots.sitemaps : [new URL("/sitemap.xml", base).toString()];
      const seen = new Set<string>();
      while (queue.length && seen.size < MAX_SITEMAPS && !p.cancel) {
        const sm = queue.shift()!;
        if (seen.has(sm)) continue;
        seen.add(sm);
        try {
          const r = await fetchText(sm, "application/xml,text/xml");
          if (r.status !== 200) {
            p.errors++;
            continue;
          }
          const parsed = parseSitemap(r.text);
          queue.push(...parsed.sitemaps);
          for (const u of parsed.urls) {
            // Sans filtre, toutes les pages du sitemap sont candidates ; avec filtre, seulement les fiches produit
            if (!src.url_pattern?.trim() || isProductUrl(u)) {
              let n: string;
              try {
                n = normalizeUrl(u);
              } catch {
                continue;
              }
              if (!visited.has(n) && sameSite(new URL(n).hostname, host)) {
                visited.add(n);
                productQueue.push(n);
              }
            }
          }
        } catch (e) {
          p.errors++;
          message = `sitemap ${sm} : ${(e as Error).message}`;
        }
        p.queued = productQueue.length;
        await sleep(Math.min(delay, 1000));
      }
    }

    // 2. Pages de départ (crawl)
    if (src.mode !== "sitemap") {
      const pageStarts = starts.filter((s) => !/sitemap|\.xml(\.gz)?$/i.test(s));
      for (const s of pageStarts.length ? pageStarts : [base.toString()]) {
        const n = normalizeUrl(s);
        if (!visited.has(n)) {
          visited.add(n);
          pageQueue.unshift(n);
        }
      }
    }

    // 3. Visite des pages
    p.phase = "Lecture des pages";
    const crawl = src.mode !== "sitemap";
    while (p.pages < src.max_pages && !p.cancel) {
      const url = productQueue.shift() ?? (crawl ? pageQueue.shift() : undefined);
      if (!url) break;
      p.queued = productQueue.length + (crawl ? pageQueue.length : 0);
      if (!robotsAllows(robots, url)) continue;
      p.pages++;
      try {
        const r = await fetchText(url);
        if (r.status >= 400) {
          p.errors++;
          if (r.status === 403 || r.status === 429 || r.status === 503) message = `Le site refuse l'accès (HTTP ${r.status}) : protection anti-robots ?`;
        } else if (/html|xml/i.test(r.type) || r.text.trimStart().startsWith("<")) {
          const prod = extractProduct(r.text, r.url);
          if (prod) {
            p.offers++;
            const now = new Date().toISOString();
            const offerUrl = (() => {
              try {
                return normalizeUrl(prod.url);
              } catch {
                return url;
              }
            })();
            const existing = findOffer.get(src.id, offerUrl) as { id: number } | undefined;
            if (prod.ean && !eanKnown.get(prod.ean)) p.newProducts++;
            if (existing) updateOffer.run(prod.title, prod.ean, prod.price, prod.currency, now, existing.id);
            else {
              insertOffer.run(src.id, offerUrl, prod.title, prod.ean, prod.price, prod.currency, now, now);
              p.newOffers++;
            }
          }
          if (crawl) for (const l of extractLinks(r.text, r.url)) push(l);
        }
      } catch (e) {
        p.errors++;
        message = (e as Error).message;
      }
      // Bloqué par le site : on arrête plutôt que d'insister
      if (p.pages >= 20 && p.errors / p.pages > 0.6) {
        status = "error";
        message = message ?? "Trop d'erreurs : le site bloque probablement les robots.";
        break;
      }
      if (p.pages % 10 === 0) flush(message);
      await sleep(delay);
    }
    if (p.cancel) {
      status = "cancelled";
      message = "Arrêté manuellement";
    } else if (status === "success") {
      if (p.pages === 0) {
        status = "error";
        message = message ?? "Aucune page trouvée (sitemap vide ou introuvable ?)";
      } else if (p.offers === 0 && p.errors >= p.pages) {
        status = "error"; // aucune page n'a pu être lue
      } else if (p.offers === 0) message = message ?? "Aucune fiche produit reconnue sur les pages lues.";
      else if (p.pages >= src.max_pages) message = `Limite de ${src.max_pages} pages atteinte.`;
    }
  } catch (e) {
    status = "error";
    message = (e as Error).message;
  }

  const finishedAt = new Date().toISOString();
  db.prepare(
    "UPDATE scrape_runs SET status = ?, finished_at = ?, pages_seen = ?, offers_seen = ?, new_products = ?, new_offers = ?, errors = ?, message = ? WHERE id = ?",
  ).run(status, finishedAt, p.pages, p.offers, p.newProducts, p.newOffers, p.errors, message, runId);
  const fresh = db.prepare("SELECT auto, interval_days FROM scrape_sources WHERE id = ?").get(src.id) as { auto: number; interval_days: number } | undefined;
  if (fresh) {
    const next = fresh.auto ? new Date(Date.now() + fresh.interval_days * 86_400_000).toISOString() : null;
    db.prepare("UPDATE scrape_sources SET next_run_at = ? WHERE id = ?").run(next, src.id);
  }
  state.current = null;
}
