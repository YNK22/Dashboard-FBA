import dns from "node:dns/promises";
import net from "node:net";
import zlib from "node:zlib";
import { getDb } from "../db";
import { extractLinks, extractProduct, isBotChallenge, normalizeUrl, parseRobots, parseSitemap, robotsAllows, sameSite, type Robots } from "./extract";
import { detectProtection, parseFeed, type FeedItem } from "./feed";

/**
 * Moteur de scraping : une source à la fois (file d'attente), en arrière-plan sur le serveur.
 * Respecte robots.txt et un délai entre deux pages ; refuse les adresses du réseau local.
 */

export interface ScrapeSource {
  id: number;
  name: string;
  base_url: string;
  mode: "sitemap" | "crawl" | "hybrid" | "feed";
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
const MAX_FEED_BYTES = 200 * 1024 * 1024; // flux produits : catalogue complet
const MAX_ERROR_DETAILS = 30;

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
async function fetchText(
  url: string,
  accept = "text/html,application/xhtml+xml",
  maxBytes = MAX_BYTES,
): Promise<{ status: number; url: string; text: string; type: string; headers: Headers }> {
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
    if (buf.length > maxBytes) throw new Error(`fichier trop volumineux (plus de ${Math.round(maxBytes / 1024 / 1024)} Mo)`);
    const body = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf; // sitemap .xml.gz
    return { status: res.status, url: current, text: body.toString("utf8"), type: res.headers.get("content-type") ?? "", headers: res.headers };
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

/* ---------- Enregistrement des offres ---------- */

interface Counters {
  offers: number;
  newProducts: number;
  newOffers: number;
}

/** Enregistre une offre (ajout ou mise à jour) et met à jour les compteurs du run. */
function offerSaver(sourceId: number, c: Counters) {
  const db = getDb();
  const findOffer = db.prepare("SELECT id FROM scrape_products WHERE source_id = ? AND url = ?");
  const eanKnown = db.prepare("SELECT 1 FROM scrape_products WHERE ean = ? LIMIT 1");
  const insertOffer = db.prepare(
    "INSERT INTO scrape_products(source_id, url, title, ean, price, currency, first_seen, last_seen) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const updateOffer = db.prepare(
    "UPDATE scrape_products SET title = ?, ean = COALESCE(?, ean), price = ?, currency = ?, last_seen = ? WHERE id = ?",
  );
  return (prod: { title: string; ean: string | null; price: number | null; currency: string | null }, url: string) => {
    c.offers++;
    const now = new Date().toISOString();
    const existing = findOffer.get(sourceId, url) as { id: number } | undefined;
    if (prod.ean && !eanKnown.get(prod.ean)) c.newProducts++;
    if (existing) updateOffer.run(prod.title, prod.ean, prod.price, prod.currency, now, existing.id);
    else {
      insertOffer.run(sourceId, url, prod.title, prod.ean, prod.price, prod.currency, now, now);
      c.newOffers++;
    }
  };
}

/** URL d'une ligne de flux : son lien, sinon un identifiant stable (EAN, ou titre) rattaché au site. */
function feedItemUrl(item: FeedItem, base: string): string {
  if (item.url) {
    try {
      const u = new URL(item.url, base);
      if (u.protocol === "http:" || u.protocol === "https:") return normalizeUrl(u.toString());
    } catch {
      // lien invalide : identifiant de repli
    }
  }
  return `${base}#${item.ean ? `ean=${item.ean}` : `titre=${encodeURIComponent(item.title.slice(0, 200))}`}`;
}

/** Enregistre les lignes d'un flux en une transaction. */
function saveFeed(sourceId: number, base: string, items: FeedItem[], c: Counters): void {
  const save = offerSaver(sourceId, c);
  getDb().transaction(() => {
    for (const it of items) save(it, feedItemUrl(it, base));
  })();
}

/**
 * Import d'un fichier flux produits (CSV/XML) envoyé depuis l'appli : enregistré comme un run.
 * Renvoie le résumé du run, ou une erreur si aucun produit n'est reconnu.
 */
export function importFeedFile(sourceId: number, text: string, fileName: string): { ok: boolean; message: string; offers: number; newOffers: number } {
  const db = getDb();
  const src = db.prepare("SELECT * FROM scrape_sources WHERE id = ?").get(sourceId) as ScrapeSource | undefined;
  if (!src) return { ok: false, message: "Source introuvable", offers: 0, newOffers: 0 };
  const startedAt = new Date().toISOString();
  const items = parseFeed(text);
  const c: Counters = { offers: 0, newProducts: 0, newOffers: 0 };
  if (items.length) saveFeed(sourceId, src.base_url, items, c);
  const ok = items.length > 0;
  const message = ok
    ? `Fichier importé : ${fileName} (${items.length} ligne(s), ${items.filter((i) => i.ean).length} avec EAN)`
    : `Aucun produit reconnu dans ${fileName} : colonnes attendues titre, EAN/GTIN, prix, lien.`;
  db.prepare(
    `INSERT INTO scrape_runs(source_id, started_at, finished_at, status, pages_seen, offers_seen, new_products, new_offers, errors, message)
     VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(sourceId, startedAt, new Date().toISOString(), ok ? "success" : "error", c.offers, c.newProducts, c.newOffers, ok ? 0 : 1, message);
  return { ok, message, offers: c.offers, newOffers: c.newOffers };
}

/* ---------- Un run ---------- */

const DENIED = new Set([401, 403, 429, 503]);

/** Message affiché quand le site refuse les robots dès les premières requêtes. */
export function blockedMessage(host: string, status: number | null, protection: string | null, steps: string[]): string {
  const what = [status ? `HTTP ${status}` : "page de vérification", protection ? `protection ${protection}` : null].filter(Boolean).join(", ");
  return (
    `${host.replace(/^www\./, "")} refuse l'accès aux robots (${what}) dès ${[...new Set(steps)].join(", ")}. ` +
    "C'est un blocage volontaire du site : le scraping s'arrête et ne le contourne pas. " +
    "Solution : passez la source en mode FLUX avec un flux produits (CSV ou XML) fourni par le site, son service pro ou une plateforme d'affiliation, " +
    "ou importez un fichier depuis la page Produits."
  );
}

async function runSource(src: ScrapeSource): Promise<void> {
  const db = getDb();
  const startedAt = new Date().toISOString();
  const runId = Number(db.prepare("INSERT INTO scrape_runs(source_id, started_at, status) VALUES(?, ?, 'running')").run(src.id, startedAt).lastInsertRowid);
  const p: Progress = { runId, sourceId: src.id, startedAt, pages: 0, offers: 0, newProducts: 0, newOffers: 0, errors: 0, queued: 0, phase: "Préparation", cancel: false };
  state.current = p;

  const details: { step: string; url: string; error: string }[] = [];
  const saveProgress = db.prepare(
    "UPDATE scrape_runs SET pages_seen = ?, offers_seen = ?, new_products = ?, new_offers = ?, errors = ?, message = ?, error_details = ? WHERE id = ?",
  );
  const detailsJson = () => (details.length ? JSON.stringify(details) : null);
  const flush = (message: string | null = null) => saveProgress.run(p.pages, p.offers, p.newProducts, p.newOffers, p.errors, message, detailsJson(), runId);
  const save = offerSaver(src.id, p);

  const base = new URL(src.base_url);
  const host = base.hostname;
  let status: "success" | "error" | "cancelled" = "success";
  let message: string | null = null;

  /** Fin du run : résultat enregistré, prochain run automatique programmé. */
  const finish = () => {
    db.prepare(
      "UPDATE scrape_runs SET status = ?, finished_at = ?, pages_seen = ?, offers_seen = ?, new_products = ?, new_offers = ?, errors = ?, message = ?, error_details = ? WHERE id = ?",
    ).run(status, new Date().toISOString(), p.pages, p.offers, p.newProducts, p.newOffers, p.errors, message, detailsJson(), runId);
    const fresh = db.prepare("SELECT auto, interval_days FROM scrape_sources WHERE id = ?").get(src.id) as { auto: number; interval_days: number } | undefined;
    if (fresh) {
      const next = fresh.auto ? new Date(Date.now() + fresh.interval_days * 86_400_000).toISOString() : null;
      db.prepare("UPDATE scrape_sources SET next_run_at = ? WHERE id = ?").run(next, src.id);
    }
    state.current = null;
  };

  const fail = (step: string, url: string, error: string, msg = error) => {
    p.errors++;
    message = msg;
    if (details.length < MAX_ERROR_DETAILS) details.push({ step, url, error });
  };

  // Refus d'accès (403, 429…) : si le site refuse tout dès le début, on s'arrête avec un diagnostic clair
  let served = 0; // sitemaps et pages reçus normalement
  const denied: { step: string; status: number | null; protection: string | null }[] = [];
  let blocked: string | null = null;
  const deny = (step: string, url: string, r: { status: number; text: string; headers: Headers } | null, challenge = false) => {
    const protection = r ? detectProtection(r.headers, r.text) : null;
    const st = challenge ? null : (r?.status ?? null);
    denied.push({ step, status: st, protection });
    const label = `${challenge ? "page de vérification anti-robots" : `HTTP ${st}`}${protection ? ` (${protection})` : ""}`;
    fail(step, url, label, `Le site refuse l'accès (${label}) : ${step}`);
    if (!blocked && served === 0 && denied.length >= 2) {
      const prot = denied.map((d) => d.protection).find(Boolean) ?? null;
      const last = [...denied].reverse().find((d) => d.status !== null);
      blocked = blockedMessage(host, last?.status ?? null, prot, denied.map((d) => d.step));
    }
  };

  try {
    const starts = (src.start_urls ?? "")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => new URL(s, base).toString());

    // Flux produits (CSV/XML) : un seul fichier par adresse, pas de visite de pages
    if (src.mode === "feed") {
      if (!starts.length) throw new Error("Mode FLUX : indiquez l'adresse du flux produits (CSV ou XML) dans « URLs de départ », ou importez un fichier depuis la page Produits.");
      for (const f of starts) {
        if (p.cancel) break;
        p.phase = "Lecture du flux";
        p.pages++;
        try {
          const r = await fetchText(f, "text/csv,application/xml,text/xml,text/plain", MAX_FEED_BYTES);
          if (r.status >= 400) {
            fail("flux", f, `HTTP ${r.status}`, `Flux inaccessible (HTTP ${r.status}) : ${f}`);
            continue;
          }
          const items = parseFeed(r.text);
          if (!items.length) {
            fail("flux", f, "aucun produit reconnu", `Aucun produit reconnu dans le flux ${f} : colonnes attendues titre, EAN/GTIN, prix, lien.`);
            continue;
          }
          p.phase = "Enregistrement";
          saveFeed(src.id, src.base_url, items, p);
        } catch (e) {
          fail("flux", f, (e as Error).message);
        }
      }
      if (p.cancel) {
        status = "cancelled";
        message = "Arrêté manuellement";
      } else if (p.offers === 0) status = "error";
      return finish();
    }

    const isProductUrl = urlFilter(src.url_pattern);

    // robots.txt
    p.phase = "robots.txt";
    let robots: Robots = { rules: [], sitemaps: [], crawlDelay: null };
    const robotsUrl = new URL("/robots.txt", base).toString();
    try {
      const r = await fetchText(robotsUrl, "text/plain");
      if (r.status === 200) robots = parseRobots(r.text);
      else if (DENIED.has(r.status)) deny("robots.txt", robotsUrl, r); // robots.txt refusé : signe d'un blocage global
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
      while (queue.length && seen.size < MAX_SITEMAPS && !p.cancel && !blocked) {
        const sm = queue.shift()!;
        if (seen.has(sm)) continue;
        seen.add(sm);
        try {
          const r = await fetchText(sm, "application/xml,text/xml");
          if (DENIED.has(r.status)) {
            deny("sitemap", sm, r);
            continue;
          }
          if (r.status !== 200) {
            fail("sitemap", sm, `HTTP ${r.status}`, `Sitemap introuvable (HTTP ${r.status}) : ${sm}`);
            continue;
          }
          if (isBotChallenge(r.text) && !/<(urlset|sitemapindex)\b/i.test(r.text)) {
            deny("sitemap", sm, r, true);
            continue;
          }
          served++;
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
          fail("sitemap", sm, (e as Error).message, `sitemap ${sm} : ${(e as Error).message}`);
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
    while (p.pages < src.max_pages && !p.cancel && !blocked) {
      const url = productQueue.shift() ?? (crawl ? pageQueue.shift() : undefined);
      if (!url) break;
      p.queued = productQueue.length + (crawl ? pageQueue.length : 0);
      if (!robotsAllows(robots, url)) continue;
      p.pages++;
      const step = p.pages === 1 && new URL(url).pathname === "/" ? "page d'accueil" : p.pages === 1 ? "première page" : "page";
      try {
        const r = await fetchText(url);
        if (DENIED.has(r.status)) deny(step, url, r);
        else if (r.status >= 400) fail(step, url, `HTTP ${r.status}`, `HTTP ${r.status} : ${url}`);
        else if (isBotChallenge(r.text) && !extractProduct(r.text, r.url)) deny(step, url, r, true);
        else if (/html|xml/i.test(r.type) || r.text.trimStart().startsWith("<")) {
          served++;
          const prod = extractProduct(r.text, r.url);
          if (prod) {
            const offerUrl = (() => {
              try {
                return normalizeUrl(prod.url);
              } catch {
                return url;
              }
            })();
            save(prod, offerUrl);
          }
          if (crawl) for (const l of extractLinks(r.text, r.url)) push(l);
        }
      } catch (e) {
        fail(step, url, (e as Error).message);
      }
      // Bloqué par le site en cours de route : on arrête plutôt que d'insister
      if (!blocked && p.pages >= 20 && p.errors / p.pages > 0.6) {
        blocked = denied.length
          ? blockedMessage(host, denied.at(-1)?.status ?? null, denied.map((d) => d.protection).find(Boolean) ?? null, ["la lecture des pages"])
          : "Trop d'erreurs : le site bloque probablement les robots.";
      }
      if (p.pages % 10 === 0) flush(message);
      if (!blocked) await sleep(delay);
    }
    if (blocked) {
      status = "error";
      message = blocked;
    } else if (p.cancel) {
      status = "cancelled";
      message = "Arrêté manuellement";
    } else {
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
  finish();
}
