import { getConfig, marketplaceById, toEur, type AppConfig } from "../config";
import { num, spApiRequest } from "./client";

/**
 * Product Fees API v0 — `getMyFeesEstimates` : estimation des frais Amazon (commission + FBA)
 * pour un SKU à un prix donné. Utilisé pour les commandes pas encore réglées quand on n'a
 * pas d'historique de frais réels pour ce produit.
 */

export interface FeeRequest {
  sku: string;
  marketplaceId: string;
  priceTtc: number; // dans la devise de la marketplace
}

interface FeesEstimateResult {
  Status?: string;
  FeesEstimateIdentifier?: { SellerInputIdentifier?: string; IdValue?: string; MarketplaceId?: string };
  FeesEstimate?: { TotalFeesEstimate?: { Amount?: number; CurrencyCode?: string } };
  Error?: { Message?: string };
}

/** Renvoie une map "sku|marketplaceId" -> frais estimés en EUR (par unité). */
export async function estimateFees(requests: FeeRequest[], cfg: AppConfig = getConfig()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < requests.length; i += 20) {
    const chunk = requests.slice(i, i + 20);
    const body = chunk.map((r, j) => ({
      IdType: "SellerSKU",
      IdValue: r.sku,
      FeesEstimateRequest: {
        MarketplaceId: r.marketplaceId,
        IsAmazonFulfilled: true,
        Identifier: `req-${i + j}`,
        PriceToEstimateFees: {
          ListingPrice: { CurrencyCode: marketplaceById(r.marketplaceId)?.currency ?? "EUR", Amount: r.priceTtc },
        },
      },
    }));
    try {
      const res = await spApiRequest<FeesEstimateResult[]>(
        { operation: "getMyFeesEstimates", method: "POST", path: "/products/fees/v0/feesEstimate", body },
        cfg,
      );
      for (const result of res ?? []) {
        const id = result.FeesEstimateIdentifier?.SellerInputIdentifier ?? "";
        const idx = Number(id.replace("req-", "")) - i;
        const req = chunk[idx];
        const total = result.FeesEstimate?.TotalFeesEstimate;
        if (req && result.Status === "Success" && total) {
          out.set(`${req.sku}|${req.marketplaceId}`, toEur(num(total.Amount), total.CurrencyCode, cfg));
        }
      }
    } catch (e) {
      console.warn(`[fees] estimation impossible : ${(e as Error).message}`);
    }
  }
  return out;
}
