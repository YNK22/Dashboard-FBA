import { NextResponse, type NextRequest } from "next/server";
import { countryBreakdown } from "@/lib/queries";
import { readRange } from "@/lib/range";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const r = readRange(req);
  if (!r) return NextResponse.json({ error: "from et to requis (YYYY-MM-DD)" }, { status: 400 });
  return NextResponse.json({ rows: countryBreakdown(r.range) });
}
