import { NextResponse, type NextRequest } from "next/server";
import { profitBreakdown } from "@/lib/queries";
import { readRange } from "@/lib/range";

export const dynamic = "force-dynamic";

// /api/breakdown?from=2026-01-01&to=2026-11-04&mkt=FR : détail du bénéfice net, frais par frais
export function GET(req: NextRequest) {
  const r = readRange(req);
  if (!r) return NextResponse.json({ error: "from et to requis (YYYY-MM-DD)" }, { status: 400 });
  return NextResponse.json(profitBreakdown(r.range, r.scope));
}
