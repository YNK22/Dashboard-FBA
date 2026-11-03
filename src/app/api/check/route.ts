import { NextResponse } from "next/server";
import { checkAmazon } from "@/lib/check";

export const dynamic = "force-dynamic";

/** Teste la connexion à Amazon étape par étape. */
export async function POST() {
  return NextResponse.json({ steps: await checkAmazon() });
}
