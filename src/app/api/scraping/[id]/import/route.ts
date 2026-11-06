import { NextResponse, type NextRequest } from "next/server";
import { importFeedFile } from "@/lib/scraper/run";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const MAX_BYTES = 200 * 1024 * 1024;

/** Import d'un fichier flux produits (CSV ou XML) envoyé tel quel dans le corps ; nom du fichier dans ?name=. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  const size = Number(req.headers.get("content-length") ?? 0);
  if (size > MAX_BYTES) return NextResponse.json({ error: "Fichier trop volumineux (200 Mo au plus)" }, { status: 413 });
  const text = await req.text();
  if (!text.trim()) return NextResponse.json({ error: "Fichier vide" }, { status: 400 });
  const name = (req.nextUrl.searchParams.get("name") ?? "fichier").slice(0, 120);
  const r = importFeedFile(id, text, name);
  return NextResponse.json(r.ok ? r : { error: r.message }, { status: r.ok ? 200 : 400 });
}
