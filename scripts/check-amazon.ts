import "./env";
import { getConfig, hasAmazonCredentials } from "../src/lib/config";
import { getAccessToken, spApiRequest } from "../src/lib/spapi/client";
import { listTransactions } from "../src/lib/spapi/finances";

/**
 * Vérifie la connexion à l'API Amazon, étape par étape :  npm run check-amazon
 */
async function main() {
  const cfg = getConfig();
  const ok = (m: string) => console.log(`  ✅ ${m}`);
  const ko = (m: string) => console.log(`  ❌ ${m}`);

  console.log("\n1) Fichier .env");
  if (!hasAmazonCredentials(cfg)) {
    ko("SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET ou SPAPI_REFRESH_TOKEN manquant (voir docs/GUIDE-CONNEXION-AMAZON.md)");
    process.exit(1);
  }
  ok(`identifiants présents, région ${cfg.region} (${cfg.endpoint})`);
  ok(`marketplaces suivies : ${cfg.marketplaces.map((m) => m.code).join(", ")}`);

  console.log("\n2) Authentification Login with Amazon");
  try {
    await getAccessToken(cfg);
    ok("access token obtenu");
  } catch (e) {
    ko((e as Error).message);
    process.exit(1);
  }

  console.log("\n3) Compte vendeur (Sellers API)");
  try {
    const res = await spApiRequest<{ payload: { marketplace: { id: string; name: string; countryCode: string }; participation: { isParticipating: boolean } }[] }>(
      { operation: "getMarketplaceParticipations", path: "/sellers/v1/marketplaceParticipations" },
      cfg,
    );
    const active = res.payload.filter((p) => p.participation.isParticipating);
    ok(`vous vendez sur : ${active.map((p) => `${p.marketplace.countryCode} (${p.marketplace.id})`).join(", ")}`);
  } catch (e) {
    ko((e as Error).message);
  }

  console.log("\n4) Commandes (Orders API v2026-01-01, rôle « Suivi des stocks et des commandes »)");
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
    ok(`${res.orders.length} commande(s) trouvée(s) sur les 3 derniers jours (aperçu limité à 10)`);
  } catch (e) {
    ko((e as Error).message);
  }

  console.log("\n5) Finances (Finances API v2024-06-19, rôle « Finance et comptabilité »)");
  try {
    const gen = listTransactions(new Date(Date.now() - 7 * 86_400_000), new Date(Date.now() - 3 * 60_000), cfg);
    const first = await gen.next();
    ok(`${(first.value ?? []).length} transaction(s) sur la première page (7 derniers jours)`);
  } catch (e) {
    ko((e as Error).message);
  }

  console.log("\nSi tout est vert : npm run sync  (la première synchro peut prendre plusieurs minutes)\n");
}

main();
