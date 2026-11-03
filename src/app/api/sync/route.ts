import { NextResponse, type NextRequest } from "next/server";
import { kvGet } from "@/lib/db";
import { isSyncRunning, lastSync, runSync } from "@/lib/sync";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ running: isSyncRunning(), ...lastSync() });
}

/**
 * Lance une synchronisation en arrière-plan.
 * Body optionnel : { "days": 180 } pour ré-importer les 180 derniers jours.
 */
export async function POST(req: NextRequest) {
  if (kvGet("demo") === "1") {
    return NextResponse.json(
      { error: "Données de démonstration actives : effacez-les (page Connexion Amazon) avant de synchroniser Amazon." },
      { status: 409 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { days?: number };
  const days = body.days ? Math.min(Math.max(Math.round(Number(body.days)), 1), 730) : undefined;
  if (!isSyncRunning()) void runSync({ days });
  return NextResponse.json({ started: true, days: days ?? null });
}
