/**
 * Configuration centrale : marketplaces, TVA, devises, variables d'environnement.
 */

export interface Marketplace {
  id: string;
  code: string; // code pays
  name: string;
  currency: string;
  vatRate: number; // taux standard de TVA, en %
  region: "eu" | "na" | "fe";
}

/** Marketplaces Amazon (IDs officiels SP-API). */
export const MARKETPLACES: Marketplace[] = [
  { id: "A13V1IB3VIYZZH", code: "FR", name: "Amazon.fr", currency: "EUR", vatRate: 20, region: "eu" },
  { id: "A1PA6795UKMFR9", code: "DE", name: "Amazon.de", currency: "EUR", vatRate: 19, region: "eu" },
  { id: "APJ6JRA9NG5V4", code: "IT", name: "Amazon.it", currency: "EUR", vatRate: 22, region: "eu" },
  { id: "A1RKKUPIHCS9HS", code: "ES", name: "Amazon.es", currency: "EUR", vatRate: 21, region: "eu" },
  { id: "A1805IZSGTT6HS", code: "NL", name: "Amazon.nl", currency: "EUR", vatRate: 21, region: "eu" },
  { id: "AMEN7PMS3EDWL", code: "BE", name: "Amazon.com.be", currency: "EUR", vatRate: 21, region: "eu" },
  { id: "A2NODRKZP88ZB9", code: "SE", name: "Amazon.se", currency: "SEK", vatRate: 25, region: "eu" },
  { id: "A1C3SOZRARQ6R3", code: "PL", name: "Amazon.pl", currency: "PLN", vatRate: 23, region: "eu" },
  { id: "A28R8C7NBKEWEA", code: "IE", name: "Amazon.ie", currency: "EUR", vatRate: 23, region: "eu" },
  { id: "A1F83G8C2ARO7P", code: "UK", name: "Amazon.co.uk", currency: "GBP", vatRate: 20, region: "eu" },
];

export const SPAPI_ENDPOINTS: Record<string, string> = {
  eu: "https://sellingpartnerapi-eu.amazon.com",
  na: "https://sellingpartnerapi-na.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
};

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v.trim();
}

function envNumber(name: string, fallback: number): number {
  const n = Number(env(name, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

function envJson<T>(name: string, fallback: T): T {
  const raw = env(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`[config] ${name} n'est pas un JSON valide, valeur ignorée`);
    return fallback;
  }
}

export function getConfig() {
  const codes = env("MARKETPLACES", "FR,DE,IT,ES,NL,BE")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const vatOverrides = envJson<Record<string, number>>("VAT_RATES", {});
  const marketplaces = MARKETPLACES.filter((m) => codes.includes(m.code)).map((m) => ({
    ...m,
    vatRate: vatOverrides[m.code] ?? m.vatRate,
  }));

  return {
    clientId: env("SPAPI_CLIENT_ID"),
    clientSecret: env("SPAPI_CLIENT_SECRET"),
    refreshToken: env("SPAPI_REFRESH_TOKEN"),
    region: env("SPAPI_REGION", "eu"),
    endpoint: env("SPAPI_ENDPOINT") || (SPAPI_ENDPOINTS[env("SPAPI_REGION", "eu")] ?? SPAPI_ENDPOINTS.eu),
    lwaTokenUrl: env("LWA_TOKEN_URL", "https://api.amazon.com/auth/o2/token"),
    marketplaces,
    vatRegistered: env("VAT_REGISTERED", "true").toLowerCase() !== "false",
    feesVatRate: envNumber("FEES_VAT_RATE", 20) / 100,
    fxRates: { EUR: 1, ...envJson<Record<string, number>>("FX_RATES", { SEK: 0.088, PLN: 0.234, GBP: 1.17 }) },
    returnRestockRate: Math.min(1, Math.max(0, envNumber("RETURN_RESTOCK_RATE", 0))),
    fallbackFeeRate: envNumber("FALLBACK_FEE_RATE", 35) / 100,
    timezone: env("TIMEZONE", "Europe/Paris"),
    databasePath: env("DATABASE_PATH", "./data/dashboard.db"),
    syncIntervalMinutes: envNumber("SYNC_INTERVAL_MINUTES", 15),
    syncInitialDays: envNumber("SYNC_INITIAL_DAYS", 60),
    dashboardPassword: env("DASHBOARD_PASSWORD"),
    // Stock : marketplace interrogée pour l'inventaire FBA (stock Pan-EU / EFN mutualisé)
    inventoryMarketplace: env("INVENTORY_MARKETPLACE", codes[0] ?? "FR"),
    reorderDays: envNumber("REORDER_DAYS", 30), // alerte « à réassortir » sous ce nombre de jours de stock
    targetStockDays: envNumber("TARGET_STOCK_DAYS", 60), // couverture visée pour la quantité à commander
    overstockDays: envNumber("OVERSTOCK_DAYS", 180),
  };
}

export type AppConfig = ReturnType<typeof getConfig>;

export function hasAmazonCredentials(cfg: AppConfig = getConfig()): boolean {
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken && !cfg.clientId.includes("xxxx"));
}

export function marketplaceById(id: string | null | undefined): Marketplace | undefined {
  if (!id) return undefined;
  return MARKETPLACES.find((m) => m.id === id);
}

/** Taux de TVA (fraction, ex. 0.2) pour une marketplace, en tenant compte des surcharges. */
export function vatRateFor(marketplaceId: string | null | undefined, cfg: AppConfig = getConfig()): number {
  const configured = cfg.marketplaces.find((m) => m.id === marketplaceId);
  const m = configured ?? marketplaceById(marketplaceId);
  return (m?.vatRate ?? 20) / 100;
}

/** Convertit un montant dans une devise vers l'EUR. */
export function toEur(amount: number, currency: string | null | undefined, cfg: AppConfig = getConfig()): number {
  if (!currency || currency === "EUR") return amount;
  const rate = (cfg.fxRates as Record<string, number>)[currency];
  if (!rate) {
    console.warn(`[config] Pas de taux de change pour ${currency} (ajoutez-le dans FX_RATES). Montant laissé tel quel.`);
    return amount;
  }
  return amount * rate;
}
