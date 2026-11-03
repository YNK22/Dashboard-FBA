import { getConfig, hasAmazonCredentials } from "./config";
import { getAccessToken, spApiRequest } from "./spapi/client";
import { listTransactions } from "./spapi/finances";
import { fetchInventory } from "./spapi/inventory";

/**
 * Vérification de la connexion à Amazon, étape par étape.
 * Utilisée par `npm run check-amazon` et par la page « Connexion Amazon ».
 */

export interface CheckStep {
  label: string;
  ok: boolean;
  detail: string;
}

export async function checkAmazon(): Promise<CheckStep[]> {
  const cfg = getConfig();
  const steps: CheckStep[] = [];

  if (!hasAmazonCredentials(cfg)) {
    steps.push({
      label: "Identifiants",
      ok: false,
      detail: "SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET ou SPAPI_REFRESH_TOKEN manquant (variables d'environnement / .env)",
    });
    return steps;
  }
  steps.push({
    label: "Identifiants",
    ok: true,
    detail: `présents · région ${cfg.region} · marketplaces ${cfg.marketplaces.map((m) => m.code).join(", ")}`,
  });

  try {
    await getAccessToken(cfg);
    steps.push({ label: "Authentification Login with Amazon", ok: true, detail: "access token obtenu" });
  } catch (e) {
    steps.push({ label: "Authentification Login with Amazon", ok: false, detail: (e as Error).message });
    return steps;
  }

  try {
    const res = await spApiRequest<{
      payload: { marketplace: { id: string; countryCode: string }; participation: { isParticipating: boolean } }[];
    }>({ operation: "getMarketplaceParticipations", path: "/sellers/v1/marketplaceParticipations" }, cfg);
    const active = res.payload.filter((p) => p.participation.isParticipating).map((p) => p.marketplace.countryCode);
    steps.push({ label: "Compte vendeur (Sellers API)", ok: true, detail: `vous vendez sur : ${active.join(", ") || "—"}` });
  } catch (e) {
    steps.push({ label: "Compte vendeur (Sellers API)", ok: false, detail: (e as Error).message });
  }

  try {
    const res = await spApiRequest<{ orders: unknown[] }>(
      {
        operation: "searchOrders",
        path: "/orders/2026-01-01/orders",
        query: {
          createdAfter: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          marketplaceIds: cfg.marketplaces.map((m) => m.id),
          includedData: ["PROCEEDS", "FULFILLMENT"],
          maxResultsPerPage: 10,
        },
      },
      cfg,
    );
    steps.push({
      label: "Commandes (rôle « Suivi des stocks et des commandes »)",
      ok: true,
      detail: `${res.orders.length} commande(s) sur les 3 derniers jours (aperçu limité à 10)`,
    });
  } catch (e) {
    steps.push({ label: "Commandes (rôle « Suivi des stocks et des commandes »)", ok: false, detail: (e as Error).message });
  }

  try {
    const first = await listTransactions(new Date(Date.now() - 7 * 86_400_000), new Date(Date.now() - 3 * 60_000), cfg).next();
    steps.push({
      label: "Finances (rôle « Finance et comptabilité »)",
      ok: true,
      detail: `${(first.value ?? []).length} transaction(s) sur la première page (7 derniers jours)`,
    });
  } catch (e) {
    steps.push({ label: "Finances (rôle « Finance et comptabilité »)", ok: false, detail: (e as Error).message });
  }

  const inv = cfg.marketplaces.find((m) => m.code === cfg.inventoryMarketplace) ?? cfg.marketplaces[0];
  if (inv) {
    try {
      const items = await fetchInventory(inv.id, cfg);
      steps.push({ label: "Stock FBA (rôle « Expédition par Amazon »)", ok: true, detail: `${items.length} SKU dans l'inventaire FBA (${inv.code})` });
    } catch (e) {
      steps.push({ label: "Stock FBA (rôle « Expédition par Amazon »)", ok: false, detail: (e as Error).message });
    }
  }

  return steps;
}
