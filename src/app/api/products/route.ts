import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { productBreakdown } from "@/lib/queries";
import { addDays, parseYmdKey, startOfDay } from "@/lib/time";

export const dynamic = "force-dynamic";

// /api/products?from=2026-10-01&to=2026-10-31  (bornes incluses, jours locaux)
export function GET(req: NextRequest) {
  const cfg = getConfig();
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  if (!from || !to) return NextResponse.json({ error: "from et to requis (YYYY-MM-DD)" }, { status: 400 });
  const range = {
    from: startOfDay(parseYmdKey(from), cfg.timezone),
    to: new Date(Math.min(startOfDay(addDays(parseYmdKey(to), 1), cfg.timezone).getTime(), Date.now())),
  };
  return NextResponse.json({ rows: productBreakdown(range, cfg) });
}
