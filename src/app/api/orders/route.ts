import { NextResponse, type NextRequest } from "next/server";
import { ordersList } from "@/lib/queries";
import { readRange } from "@/lib/range";

export const dynamic = "force-dynamic";

// /api/orders?from=2026-10-01&to=2026-10-31&mkt=FR&q=lego&loss=1&page=1
export function GET(req: NextRequest) {
  const r = readRange(req);
  if (!r) return NextResponse.json({ error: "from et to requis (YYYY-MM-DD)" }, { status: 400 });
  const p = req.nextUrl.searchParams;
  return NextResponse.json(
    ordersList(r.range, { q: p.get("q") ?? undefined, onlyLoss: p.get("loss") === "1", page: Number(p.get("page")) || 1 }, r.scope),
  );
}
