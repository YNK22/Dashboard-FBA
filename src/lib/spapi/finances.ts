import { getConfig, toEur, type AppConfig } from "../config";
import { num, spApiRequest } from "./client";

/**
 * Finances API v2024-06-19 — opération `listTransactions` (remplace listFinancialEvents v0, dépréciée).
 * Donne les montants RÉELS réglés par Amazon : commissions, frais FBA, remboursements, frais divers.
 * Attention : les transactions des dernières ~48 h peuvent ne pas encore apparaître.
 */

interface Currency {
  currencyCode?: string;
  currencyAmount?: number | string;
}

export interface ApiBreakdown {
  breakdownType?: string;
  breakdownAmount?: Currency;
  breakdowns?: ApiBreakdown[];
}

interface ApiContext {
  contextType?: string;
  sku?: string;
  asin?: string;
  quantityShipped?: number;
}

export interface ApiTransaction {
  transactionId?: string;
  transactionType?: string;
  transactionStatus?: string;
  description?: string;
  postedDate?: string;
  totalAmount?: Currency;
  marketplaceDetails?: { marketplaceId?: string };
  sellingPartnerMetadata?: { marketplaceId?: string };
  relatedIdentifiers?: { relatedIdentifierName?: string; relatedIdentifierValue?: string }[];
  items?: {
    description?: string;
    totalAmount?: Currency;
    breakdowns?: ApiBreakdown[];
    contexts?: ApiContext[];
  }[];
  breakdowns?: ApiBreakdown[];
}

interface ListTransactionsResponse {
  payload?: { nextToken?: string; transactions?: ApiTransaction[] };
}

export interface FinanceLineRow {
  id: string;
  transaction_id: string;
  posted_date: string;
  kind: "shipment" | "refund" | "other";
  transaction_type: string | null;
  description: string | null;
  status: string | null;
  order_id: string | null;
  sku: string | null;
  quantity: number | null;
  marketplace_id: string | null;
  revenue: number;
  tax: number;
  promo: number;
  fees: number;
  fee_tax: number;
  fee_detail: string | null;
  total: number;
}

export async function* listTransactions(postedAfter: Date, postedBefore: Date | undefined, cfg: AppConfig = getConfig()) {
  let nextToken: string | undefined;
  do {
    const res = await spApiRequest<ListTransactionsResponse>(
      {
        operation: "listTransactions",
        path: "/finances/2024-06-19/transactions",
        query: {
          postedAfter: postedAfter.toISOString(),
          postedBefore: postedBefore?.toISOString(),
          nextToken,
        },
      },
      cfg,
    );
    yield res.payload?.transactions ?? [];
    nextToken = res.payload?.nextToken;
  } while (nextToken);
}

/* ---------- Classification des montants ---------- */

type Category = "revenue" | "tax" | "promo" | "fee";

const RE_FEE = /fee|commission|expense|chargeback|closing|storage|subscription|advertis|hb$|service|disposal|removal|label|prep|weight|handling|pick|pack/i;
const RE_TAX = /tax|tva|vat|withheld/i;
const RE_PROMO = /promo|discount|rebate|coupon/i;
const RE_REVENUE = /principal|principle|product ?charge|shipping|gift ?wrap|sales|refund|charge|price/i;

function classifyName(name: string): Category | null {
  if (RE_FEE.test(name)) return "fee";
  if (RE_TAX.test(name)) return "tax";
  if (RE_PROMO.test(name)) return "promo";
  if (RE_REVENUE.test(name)) return "revenue";
  return null;
}

/** Classe une feuille de l'arbre de "breakdowns" en remontant vers la racine si besoin. */
export function classifyPath(path: string[]): Category {
  for (let i = path.length - 1; i >= 0; i--) {
    const c = classifyName(path[i] ?? "");
    if (c) return c;
  }
  return "fee"; // montant inconnu : considéré comme un frais
}

interface Sums {
  revenue: number;
  tax: number;
  promo: number;
  fees: number; // frais Amazon HT (signés)
  feeTax: number; // TVA facturée sur ces frais (signée)
}

/** Détail des frais par type Amazon : [HT, TVA], montants signés. */
export type FeeDetail = Record<string, [number, number]>;

/** Feuille rattachée à un frais Amazon (un des parents est un frais). */
const underFee = (p: string[]) => p.slice(0, -1).some((n) => classifyName(n) === "fee");
const isTaxLeaf = (p: string[]) => /^tax$/i.test(p[p.length - 1] ?? "");
/** TVA sur ventes encaissée puis reversée directement par Amazon (régime « marketplace facilitator », retenue). */
const isWithheldVat = (p: string[]) => p.some((n) => /facilitator|withheld/i.test(n));
/** Remise d'Amazon sur un de ses frais (ex. frais FBA offerts : « FBAPerUnitFulfillmentFee/Promo »). */
const isFeePromo = (p: string[]) => /promo|discount|rebate/i.test(p[p.length - 1] ?? "");

/** Clé du détail : nom du frais (dernier élément du chemin, hors feuilles Base / Tax / Promo). */
function feeName(p: string[]): string {
  if (isWithheldVat(p)) return "MarketplaceFacilitatorVAT";
  const leaf = p[p.length - 1] ?? "";
  if (isFeePromo(p) && p.length > 1) return "FeePromo";
  const q = /^(base|tax)$/i.test(leaf) && p.length > 1 ? p.slice(0, -1) : p;
  return q[q.length - 1] || "Autre";
}

export function sumBreakdowns(bds: ApiBreakdown[] | undefined, cfg: AppConfig = getConfig()): Sums & { leaves: number; detail: FeeDetail } {
  const sums = { revenue: 0, tax: 0, promo: 0, fees: 0, feeTax: 0, leaves: 0, detail: {} as FeeDetail };
  const add = (name: string, i: 0 | 1, amount: number) => {
    const d = (sums.detail[name] ??= [0, 0]);
    d[i] += amount;
  };
  const walk = (list: ApiBreakdown[], path: string[]) => {
    for (const b of list) {
      const p = [...path, b.breakdownType ?? ""];
      if (b.breakdowns && b.breakdowns.length > 0) {
        walk(b.breakdowns, p);
      } else {
        const amount = toEur(num(b.breakdownAmount?.currencyAmount), b.breakdownAmount?.currencyCode, cfg);
        sums.leaves++;
        // TVA sur un frais, ou TVA sur ventes retenue par Amazon : jamais encaissée par vous
        if ((isTaxLeaf(p) && underFee(p)) || isWithheldVat(p)) {
          sums.feeTax += amount;
          add(feeName(p), 1, amount);
          continue;
        }
        // Tout ce qui est rattaché à un frais (montant de base, remise d'Amazon sur ce frais...) est un frais
        if (underFee(p)) {
          sums.fees += amount;
          add(feeName(p), 0, amount);
          continue;
        }
        const cat = classifyPath(p);
        if (cat === "fee") {
          sums.fees += amount;
          add(feeName(p), 0, amount);
        } else sums[cat] += amount;
      }
    }
  };
  walk(bds ?? [], []);
  return sums;
}

// Virements et mouvements de trésorerie (prélèvement sur votre carte pour couvrir un solde négatif, et son
// remboursement) : ce ne sont ni des gains ni des coûts
const RE_EXCLUDED = /transfer|disburse|payout|payable to|reserve|balance|debt ?recovery|debt ?payment|charge ?refund/i;

/** Transforme une transaction Amazon en lignes (une par article si possible). */
export function parseTransaction(t: ApiTransaction, cfg: AppConfig = getConfig()): FinanceLineRow[] {
  const typeDesc = `${t.transactionType ?? ""} ${t.description ?? ""}`;
  if (RE_EXCLUDED.test(typeDesc)) return []; // virements vers votre banque : ce ne sont pas des coûts
  if (!t.transactionId || !t.postedDate) return [];

  const orderId = t.relatedIdentifiers?.find((r) => r.relatedIdentifierName === "ORDER_ID")?.relatedIdentifierValue ?? null;
  let kind: FinanceLineRow["kind"] = "other";
  if (orderId) {
    if (/refund|return/i.test(typeDesc)) kind = "refund";
    else if (/shipment|order/i.test(typeDesc)) kind = "shipment";
  }

  const marketplaceId = t.marketplaceDetails?.marketplaceId ?? t.sellingPartnerMetadata?.marketplaceId ?? null;
  const total = toEur(num(t.totalAmount?.currencyAmount), t.totalAmount?.currencyCode, cfg);
  const base = {
    transaction_id: t.transactionId,
    posted_date: new Date(t.postedDate).toISOString(),
    kind,
    transaction_type: t.transactionType ?? null,
    description: t.description ?? null,
    status: t.transactionStatus ?? null,
    order_id: orderId,
    marketplace_id: marketplaceId,
  };

  const lines: FinanceLineRow[] = [];
  let itemsTotal = 0;
  (t.items ?? []).forEach((it, i) => {
    const ctx = it.contexts?.find((c) => c.contextType === "ProductContext" || c.sku);
    const s = sumBreakdowns(it.breakdowns, cfg);
    const itTotal = it.totalAmount ? toEur(num(it.totalAmount.currencyAmount), it.totalAmount.currencyCode, cfg) : s.revenue + s.tax + s.promo + s.fees + s.feeTax;
    if (s.leaves === 0) s.fees = itTotal; // pas de détail : tout est compté comme frais/montant divers
    itemsTotal += itTotal;
    lines.push({
      ...base,
      id: `${t.transactionId}#${i}`,
      sku: ctx?.sku ?? null,
      quantity: ctx?.quantityShipped ?? null,
      ...round(s),
      total: r2(itTotal),
    });
  });

  if (lines.length === 0) {
    const s = sumBreakdowns(t.breakdowns, cfg);
    if (s.leaves === 0) s.fees = total;
    lines.push({ ...base, id: `${t.transactionId}#0`, sku: null, quantity: null, ...round(s), total: r2(total) });
  } else if (Math.abs(total - itemsTotal) > 0.01) {
    // Frais au niveau de la commande (non rattachés à un article)
    lines.push({
      ...base,
      id: `${t.transactionId}#rest`,
      sku: null,
      quantity: null,
      revenue: 0,
      tax: 0,
      promo: 0,
      fees: r2(total - itemsTotal),
      fee_tax: 0,
      fee_detail: null,
      total: r2(total - itemsTotal),
    });
  }
  return lines;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const round = (s: Sums & { detail?: FeeDetail }) => {
  const detail = Object.entries(s.detail ?? {}).filter(([, [ht, tva]]) => Math.abs(ht) >= 0.005 || Math.abs(tva) >= 0.005);
  return {
    revenue: r2(s.revenue),
    tax: r2(s.tax),
    promo: r2(s.promo),
    fees: r2(s.fees),
    fee_tax: r2(s.feeTax),
    fee_detail: detail.length ? JSON.stringify(Object.fromEntries(detail.map(([k, [a, b]]) => [k, [r2(a), r2(b)]]))) : null,
  };
};
