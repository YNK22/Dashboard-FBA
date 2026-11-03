import { NextResponse, type NextRequest } from "next/server";
import { chartSeries } from "@/lib/queries";
import { readScope } from "@/lib/range";

export const dynamic = "force-dynamic";

// /api/chart?year=2026&month=10  (jours du mois)  ou  /api/chart?year=2026  (mois de l'année)
export function GET(req: NextRequest) {
  const year = Number(req.nextUrl.searchParams.get("year"));
  const monthParam = req.nextUrl.searchParams.get("month");
  const month = monthParam ? Number(monthParam) : undefined;
  if (!year || (month !== undefined && (month < 1 || month > 12))) {
    return NextResponse.json({ error: "Paramètres year/month invalides" }, { status: 400 });
  }
  return NextResponse.json({ points: chartSeries({ year, month }, new Date(), readScope(req)) });
}
