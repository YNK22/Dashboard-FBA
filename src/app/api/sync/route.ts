import { NextResponse } from "next/server";
import { kvGet } from "@/lib/db";
import { isSyncRunning, lastSync, runSync } from "@/lib/sync";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ running: isSyncRunning(), ...lastSync() });
}

/** Lance une synchronisation en arrière-plan. */
export function POST() {
  if (kvGet("demo") === "1") {
    return NextResponse.json(
      { error: "Données de démonstration actives : lancez `npm run demo -- --clear` avant de synchroniser Amazon." },
      { status: 409 },
    );
  }
  if (!isSyncRunning()) void runSync();
  return NextResponse.json({ started: true });
}
