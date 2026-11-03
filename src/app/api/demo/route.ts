import { NextResponse } from "next/server";
import { clearData } from "@/lib/demo";
import { kvGet } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Efface les données de démonstration (uniquement si la base est en mode démo). */
export function DELETE() {
  if (kvGet("demo") !== "1") return NextResponse.json({ error: "La base ne contient pas de données de démonstration." }, { status: 400 });
  clearData();
  return NextResponse.json({ ok: true });
}
