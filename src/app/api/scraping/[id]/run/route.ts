import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { cancelScrape, enqueueScrape } from "@/lib/scraper/run";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Lance un run (mis en file si une autre source tourne déjà). */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  if (!getDb().prepare("SELECT 1 FROM scrape_sources WHERE id = ?").get(id)) return NextResponse.json({ error: "Source introuvable" }, { status: 404 });
  const started = enqueueScrape(id);
  return NextResponse.json({ ok: true, started, message: started ? "Run lancé" : "Déjà en cours ou en file d'attente" });
}

/** Arrête le run en cours (ou retire la source de la file). */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  return NextResponse.json({ ok: true, cancelled: cancelScrape(id) });
}
