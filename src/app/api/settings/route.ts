import { NextResponse } from "next/server";
import { getConfig, hasAmazonCredentials } from "@/lib/config";
import { kvGet } from "@/lib/db";
import { isSyncRunning, lastSync } from "@/lib/sync";

export const dynamic = "force-dynamic";

/** Réglages actifs (sans jamais renvoyer les secrets) + état de la synchronisation. */
export function GET() {
  const cfg = getConfig();
  const mask = (s: string) => (s ? `${s.slice(0, 18)}…` : "");
  return NextResponse.json({
    connected: hasAmazonCredentials(cfg),
    clientId: mask(cfg.clientId),
    region: cfg.region,
    endpoint: cfg.endpoint,
    marketplaces: cfg.marketplaces.map((m) => `${m.code} (${m.vatRate} %)`),
    vatRegistered: cfg.vatRegistered,
    timezone: cfg.timezone,
    syncIntervalMinutes: cfg.syncIntervalMinutes,
    syncInitialDays: cfg.syncInitialDays,
    passwordProtected: Boolean(cfg.dashboardPassword),
    demo: kvGet("demo") === "1",
    sync: { running: isSyncRunning(), ...lastSync() },
  });
}
