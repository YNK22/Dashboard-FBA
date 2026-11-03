import { NextResponse, type NextRequest } from "next/server";
import { getConfig, hasAmazonCredentials } from "@/lib/config";
import { kvGet } from "@/lib/db";
import { dashboardCards } from "@/lib/queries";
import { readScope } from "@/lib/range";
import { isSyncRunning, lastSync } from "@/lib/sync";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const cfg = getConfig();
  const scope = readScope(req);
  const { last, lastOkAt } = lastSync();
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    cards: dashboardCards(new Date(), scope),
    demo: kvGet("demo") === "1",
    connected: hasAmazonCredentials(cfg),
    vatRegistered: cfg.vatRegistered,
    marketplaces: cfg.marketplaces.map((m) => m.code),
    sync: { running: isSyncRunning(), lastOkAt, lastError: last && !last.ok ? last.error : null, warnings: last?.warnings ?? [] },
  });
}
