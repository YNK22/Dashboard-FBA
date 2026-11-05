import { NextResponse, type NextRequest } from "next/server";
import { getConfig, hasAmazonCredentials } from "@/lib/config";
import { bumpDataVersion, kvGet, kvSet } from "@/lib/db";
import { urssafRate } from "@/lib/queries";
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
    urssafRate: Math.round(urssafRate(cfg) * 10000) / 100, // en %
    timezone: cfg.timezone,
    syncIntervalMinutes: cfg.syncIntervalMinutes,
    syncInitialDays: cfg.syncInitialDays,
    passwordProtected: Boolean(cfg.dashboardPassword),
    demo: kvGet("demo") === "1",
    sync: { running: isSyncRunning(), ...lastSync() },
  });
}

/** Réglages modifiables depuis le dashboard : body = { urssafRate: 12.4 } (en %, 0 = désactivé). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { urssafRate?: number | string };
  if (body.urssafRate !== undefined) {
    const v = Number(String(body.urssafRate).replace(",", "."));
    if (!Number.isFinite(v) || v < 0 || v > 60) return NextResponse.json({ error: "Taux URSSAF invalide (0 à 60 %)" }, { status: 400 });
    kvSet("urssaf_rate", String(v));
    bumpDataVersion();
  }
  return NextResponse.json({ ok: true, urssafRate: Math.round(urssafRate() * 10000) / 100 });
}
