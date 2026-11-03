import { NextResponse } from "next/server";
import { getConfig, hasAmazonCredentials } from "@/lib/config";
import { kvGet } from "@/lib/db";
import { dashboardCards } from "@/lib/queries";
import { isSyncRunning, lastSync } from "@/lib/sync";

export const dynamic = "force-dynamic";

export function GET() {
  const cfg = getConfig();
  const { last, lastOkAt } = lastSync();
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    cards: dashboardCards(new Date(), cfg),
    demo: kvGet("demo") === "1",
    connected: hasAmazonCredentials(cfg),
    vatRegistered: cfg.vatRegistered,
    marketplaces: cfg.marketplaces.map((m) => m.code),
    sync: { running: isSyncRunning(), lastOkAt, lastError: last && !last.ok ? last.error : null },
  });
}
