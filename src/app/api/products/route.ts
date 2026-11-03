import { NextResponse, type NextRequest } from "next/server";
import { productBreakdown } from "@/lib/queries";
import { readRange } from "@/lib/range";

export const dynamic = "force-dynamic";

// /api/products?from=2026-10-01&to=2026-10-31[&mkt=FR]  (bornes incluses, jours locaux)
export function GET(req: NextRequest) {
  const r = readRange(req);
  if (!r) return NextResponse.json({ error: "from et to requis (YYYY-MM-DD)" }, { status: 400 });
  return NextResponse.json({ rows: productBreakdown(r.range, r.scope) });
}
