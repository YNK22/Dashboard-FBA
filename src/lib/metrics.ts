/**
 * Calculs de rentabilité — fonctions pures (testées dans tests/metrics.test.ts).
 *
 *   CA TTC          = prix payé par les clients (article + port + emballage − promotions)
 *   TVA             = TVA incluse dans le CA TTC
 *   CA HT           = CA TTC − TVA
 *   Frais Amazon    = commissions + frais FBA + autres frais par commande (réels, ou estimés si pas encore réglés)
 *   Coût d'achat    = unités × (prix d'achat + coûts annexes par unité)
 *   Bénéfice brut   = CA HT − frais Amazon − coût d'achat
 *   Remboursements  = montant remboursé HT − frais Amazon rendus + frais de remboursement − stock récupéré
 *   Coûts divers    = abonnement, stockage, publicité, dépenses saisies...
 *   Bénéfice net    = bénéfice brut − coût des remboursements − coûts divers
 *   Marge           = bénéfice net / CA HT
 *   ROI             = bénéfice net / coût d'achat
 *
 * Si vous n'êtes pas assujetti à la TVA (VAT_REGISTERED=false, micro-entreprise), la TVA n'est pas déduite :
 * le calcul se fait sur le CA TTC, et les frais Amazon sont comptés TVA comprise, avec la TVA réellement
 * facturée par Amazon (les montants reçus sont déjà dans la bonne base : aucune majoration ici).
 */

export interface SaleLine {
  date: string; // ISO (date de commande)
  orderId: string;
  sku: string | null;
  title: string | null;
  asin: string | null;
  marketplaceId: string | null;
  status: string;
  quantity: number;
  salesTtc: number;
  vat: number;
  fees: number; // coût positif (HT si assujetti, sinon TVA comprise)
  feesEstimated: boolean;
  cogsUnit: number | null; // prix d'achat + coûts annexes, par unité (null = non renseigné)
}

export interface RefundLine {
  date: string; // ISO (date du remboursement)
  orderId: string | null;
  sku: string | null;
  quantity: number;
  refundTtc: number; // montant remboursé au client (positif)
  vatBack: number; // TVA récupérée sur le remboursement (positif)
  feesNet: number; // signé : + = Amazon vous rend des frais, − = frais de remboursement
  cogsRecovered: number; // coût d'achat récupéré (retour en stock vendable)
}

export interface OtherCost {
  date: string; // ISO ou YYYY-MM-DD
  label: string;
  amount: number; // positif = coût, négatif = gain (ex. remboursement Amazon d'un article perdu)
  source: "amazon" | "manual";
  category?: string; // regroupement pour le détail du bénéfice
}

export interface TaxSettings {
  vatRegistered: boolean;
  feesVatRate: number; // fraction, ex 0.2 (sert seulement aux estimations HT de l'API Product Fees)
}

export interface Summary {
  orders: number;
  units: number;
  salesTtc: number;
  salesHt: number;
  vat: number;
  amazonFees: number;
  cogs: number;
  grossProfit: number;
  refunds: number; // nombre de remboursements
  refundUnits: number;
  refundAmountTtc: number;
  refundCost: number;
  otherCosts: number;
  netProfit: number;
  margin: number | null; // fraction
  roi: number | null; // fraction
  pendingOrders: number; // commandes pas encore expédiées
  pendingSalesTtc: number;
  estimatedFeesSalesTtc: number; // CA dont les frais sont estimés (pas encore réglés)
  missingCogsUnits: number; // unités vendues sans prix d'achat renseigné
}

export const PENDING_STATUSES = new Set(["PENDING", "PENDING_AVAILABILITY", "UNSHIPPED"]);

const r2 = (n: number) => Math.round(n * 100) / 100;

export function emptySummary(): Summary {
  return {
    orders: 0,
    units: 0,
    salesTtc: 0,
    salesHt: 0,
    vat: 0,
    amazonFees: 0,
    cogs: 0,
    grossProfit: 0,
    refunds: 0,
    refundUnits: 0,
    refundAmountTtc: 0,
    refundCost: 0,
    otherCosts: 0,
    netProfit: 0,
    margin: null,
    roi: null,
    pendingOrders: 0,
    pendingSalesTtc: 0,
    estimatedFeesSalesTtc: 0,
    missingCogsUnits: 0,
  };
}

export function computeSummary(sales: SaleLine[], refunds: RefundLine[], others: OtherCost[], tax: TaxSettings): Summary {
  const s = emptySummary();
  const orders = new Set<string>();
  const pending = new Set<string>();

  for (const l of sales) {
    orders.add(l.orderId);
    s.units += l.quantity;
    s.salesTtc += l.salesTtc;
    s.vat += tax.vatRegistered ? l.vat : 0;
    s.amazonFees += l.fees;
    if (l.cogsUnit === null) s.missingCogsUnits += l.quantity;
    else s.cogs += l.cogsUnit * l.quantity;
    if (PENDING_STATUSES.has(l.status)) {
      pending.add(l.orderId);
      s.pendingSalesTtc += l.salesTtc;
    }
    if (l.feesEstimated) s.estimatedFeesSalesTtc += l.salesTtc;
  }
  s.orders = orders.size;
  s.pendingOrders = pending.size;
  s.salesHt = s.salesTtc - s.vat;
  s.grossProfit = s.salesHt - s.amazonFees - s.cogs;

  const refundKeys = new Set<string>();
  for (const r of refunds) {
    refundKeys.add(r.orderId ?? `${r.date}-${r.sku}`);
    s.refundUnits += r.quantity;
    s.refundAmountTtc += r.refundTtc;
    const refundBase = r.refundTtc - (tax.vatRegistered ? r.vatBack : 0);
    s.refundCost += refundBase - r.feesNet - r.cogsRecovered;
  }
  s.refunds = refundKeys.size;

  for (const o of others) {
    s.otherCosts += o.amount;
  }

  s.netProfit = s.grossProfit - s.refundCost - s.otherCosts;
  const base = tax.vatRegistered ? s.salesHt : s.salesTtc;
  s.margin = base > 0 ? s.netProfit / base : null;
  s.roi = s.cogs > 0 ? s.netProfit / s.cogs : null;

  for (const k of Object.keys(s) as (keyof Summary)[]) {
    const v = s[k];
    if (typeof v === "number" && !["margin", "roi"].includes(k)) (s[k] as number) = r2(v);
  }
  return s;
}

/** Variation en % entre deux valeurs (null si pas de base de comparaison). */
export function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return (current - previous) / Math.abs(previous);
}

/**
 * Prévision de fin de mois : réalisé + moyenne journalière récente × jours restants.
 */
export function forecastMonth(mtd: Summary, recentDaily: Summary, recentDays: number, elapsedDays: number, totalDays: number): Summary {
  const remaining = Math.max(0, totalDays - elapsedDays);
  const k = recentDays > 0 ? remaining / recentDays : 0;
  const f = emptySummary();
  const keys: (keyof Summary)[] = [
    "orders",
    "units",
    "salesTtc",
    "salesHt",
    "vat",
    "amazonFees",
    "cogs",
    "grossProfit",
    "refunds",
    "refundUnits",
    "refundAmountTtc",
    "refundCost",
    "otherCosts",
    "netProfit",
  ];
  for (const key of keys) (f[key] as number) = r2((mtd[key] as number) + (recentDaily[key] as number) * k);
  f.orders = Math.round(f.orders);
  f.units = Math.round(f.units);
  f.refunds = Math.round(f.refunds);
  f.refundUnits = Math.round(f.refundUnits);
  const base = f.salesHt || f.salesTtc;
  f.margin = base > 0 ? f.netProfit / base : null;
  f.roi = f.cogs > 0 ? f.netProfit / f.cogs : null;
  return f;
}

/**
 * Estimation des frais Amazon d'une ligne pas encore réglée.
 * La commission (~15 %) varie avec le prix ; les frais FBA sont fixes par unité.
 */
export function estimateLineFees(
  quantity: number,
  unitPriceTtc: number,
  salesTtc: number,
  history: { feesPerUnit: number; unitPriceTtc: number } | undefined,
  fallbackRate: number,
  referralRate = 0.15,
): number {
  if (history) {
    const perUnit = history.feesPerUnit + referralRate * (unitPriceTtc - history.unitPriceTtc);
    return Math.max(0, perUnit) * quantity;
  }
  return salesTtc * fallbackRate;
}
