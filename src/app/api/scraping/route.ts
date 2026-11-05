import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { listSources, validateSource } from "@/lib/scraper/sources";

export const dynamic = "force-dynamic";

/** Sources de scraping, avec leur dernier run et la progression en direct. */
export function GET() {
  return NextResponse.json({ sources: listSources() });
}

/** Nouvelle source : { name, base_url, mode, start_urls, url_pattern, interval_days, max_pages, delay_ms, auto } */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const { data, error } = validateSource(body);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const r = getDb()
    .prepare(
      `INSERT INTO scrape_sources(name, base_url, mode, start_urls, url_pattern, interval_days, auto, max_pages, delay_ms, next_run_at, created_at)
       VALUES(@name, @base_url, @mode, @start_urls, @url_pattern, @interval_days, @auto, @max_pages, @delay_ms, NULL, @created_at)`,
    )
    .run({ start_urls: null, url_pattern: null, ...data, created_at: new Date().toISOString() });
  return NextResponse.json({ ok: true, source: listSources(Number(r.lastInsertRowid))[0] });
}
