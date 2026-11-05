import { getDb } from "../db";
import { scrapeState, type ScrapeSource } from "./run";

/** Validation des réglages d'une source (création ou modification). */
export function validateSource(body: Record<string, unknown>, partial = false): { data: Partial<ScrapeSource>; error?: string } {
  const data: Partial<ScrapeSource> = {};
  if (body.base_url !== undefined || !partial) {
    let raw = String(body.base_url ?? "").trim();
    if (raw && !/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { data, error: "URL du site invalide" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { data, error: "L'URL doit commencer par http(s)://" };
    data.base_url = `${u.protocol}//${u.host}/`;
    if (!partial && !String(body.name ?? "").trim()) data.name = u.hostname.replace(/^www\./, "");
  }
  if (body.name !== undefined && String(body.name).trim()) data.name = String(body.name).trim().slice(0, 80);
  if (body.mode !== undefined || !partial) {
    const m = String(body.mode ?? "hybrid");
    if (!["sitemap", "crawl", "hybrid"].includes(m)) return { data, error: "Mode invalide" };
    data.mode = m as ScrapeSource["mode"];
  }
  if (body.start_urls !== undefined) data.start_urls = String(body.start_urls ?? "").trim().slice(0, 5000) || null;
  if (body.url_pattern !== undefined) data.url_pattern = String(body.url_pattern ?? "").trim().slice(0, 300) || null;
  const int = (k: keyof ScrapeSource, min: number, max: number, def: number) => {
    if (body[k] === undefined && partial) return null;
    const n = Math.round(Number(body[k] ?? def));
    if (!Number.isFinite(n) || n < min || n > max) return `${String(k)} doit être entre ${min} et ${max}`;
    (data as Record<string, unknown>)[k] = n;
    return null;
  };
  const err = int("interval_days", 1, 365, 21) ?? int("max_pages", 1, 50_000, 2000) ?? int("delay_ms", 200, 60_000, 1000);
  if (err) return { data, error: err };
  if (body.auto !== undefined || !partial) data.auto = body.auto === false || body.auto === 0 || body.auto === "0" ? 0 : 1;
  return { data };
}

export interface SourceView extends ScrapeSource {
  products: number;
  withEan: number;
  lastRun: {
    id: number;
    started_at: string;
    finished_at: string | null;
    status: string;
    pages_seen: number;
    offers_seen: number;
    new_products: number;
    new_offers: number;
    errors: number;
    message: string | null;
  } | null;
  live: { pages: number; offers: number; newProducts: number; newOffers: number; errors: number; queued: number; phase: string } | null;
  queuedPosition: number | null; // position dans la file (1 = prochain)
}

export function listSources(id?: number): SourceView[] {
  const db = getDb();
  const sources = (
    id ? db.prepare("SELECT * FROM scrape_sources WHERE id = ?").all(id) : db.prepare("SELECT * FROM scrape_sources ORDER BY name COLLATE NOCASE").all()
  ) as ScrapeSource[];
  const lastRun = db.prepare("SELECT * FROM scrape_runs WHERE source_id = ? ORDER BY id DESC LIMIT 1");
  const counts = db.prepare("SELECT COUNT(*) AS n, COUNT(ean) AS e FROM scrape_products WHERE source_id = ?");
  const { current, queue } = scrapeState();
  return sources.map((s) => {
    const c = counts.get(s.id) as { n: number; e: number };
    const live = current?.sourceId === s.id ? current : null;
    const qi = queue.indexOf(s.id);
    return {
      ...s,
      products: c.n,
      withEan: c.e,
      lastRun: (lastRun.get(s.id) as SourceView["lastRun"]) ?? null,
      live: live
        ? { pages: live.pages, offers: live.offers, newProducts: live.newProducts, newOffers: live.newOffers, errors: live.errors, queued: live.queued, phase: live.phase }
        : null,
      queuedPosition: qi >= 0 ? qi + 1 + (current ? 1 : 0) : null,
    };
  });
}
