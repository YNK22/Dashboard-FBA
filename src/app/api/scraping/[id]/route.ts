import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { cancelScrape } from "@/lib/scraper/run";
import { listSources, validateSource } from "@/lib/scraper/sources";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Une source, avec l'historique de ses 20 derniers runs. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  const source = listSources(id)[0];
  if (!source) return NextResponse.json({ error: "Source introuvable" }, { status: 404 });
  const runs = getDb().prepare("SELECT * FROM scrape_runs WHERE source_id = ? ORDER BY id DESC LIMIT 20").all(id);
  return NextResponse.json({ source, runs });
}

/** Modification des réglages (champs partiels). Activer « auto » programme le prochain run. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  const db = getDb();
  const cur = db.prepare("SELECT * FROM scrape_sources WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!cur) return NextResponse.json({ error: "Source introuvable" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const { data, error } = validateSource(body, true);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const next = { ...cur, ...data } as Record<string, unknown>;
  // Prochain run : désactivé si auto OFF ; sinon dernier run + fréquence (ou maintenant + fréquence)
  if (!next.auto) next.next_run_at = null;
  else if (data.auto !== undefined || data.interval_days !== undefined) {
    const last = db.prepare("SELECT COALESCE(finished_at, started_at) AS t FROM scrape_runs WHERE source_id = ? ORDER BY id DESC LIMIT 1").get(id) as
      | { t: string }
      | undefined;
    const from = last ? new Date(last.t).getTime() : Date.now();
    next.next_run_at = new Date(Math.max(from + Number(next.interval_days) * 86_400_000, Date.now() + 60_000)).toISOString();
  }
  db.prepare(
    `UPDATE scrape_sources SET name = @name, base_url = @base_url, mode = @mode, start_urls = @start_urls, url_pattern = @url_pattern,
       interval_days = @interval_days, auto = @auto, max_pages = @max_pages, delay_ms = @delay_ms, next_run_at = @next_run_at WHERE id = @id`,
  ).run(next);
  return NextResponse.json({ ok: true, source: listSources(id)[0] });
}

/** Suppression de la source, de son historique et des produits trouvés. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  cancelScrape(id);
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM scrape_products WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM scrape_runs WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM scrape_sources WHERE id = ?").run(id);
  })();
  return NextResponse.json({ ok: true });
}
