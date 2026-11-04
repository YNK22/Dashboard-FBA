import { getConfig, vatRateFor, type AppConfig } from "./config";
import { getDb } from "./db";
import { currentUnitCost, loadFifo } from "./fifo";
import {
  computeSummary,
  estimateLineFees,
  forecastMonth,
  pctChange,
  type OtherCost,
  type RefundLine,
  type SaleLine,
  type Summary,
} from "./metrics";
import {
  FR_MONTHS,
  FR_WEEKDAYS,
  addDays,
  addMonths,
  dayRange,
  daysInMonth,
  formatDayFr,
  localDayKey,
  monthRange,
  startOfDay,
  toYMD,
  weekdayOf,
  yearRange,
  ymdKey,
  type Range,
  type YMD,
} from "./time";

/* ---------------------------------------------------------------------------
 * Chargement des données depuis SQLite
 * ------------------------------------------------------------------------- */

/** Configuration + filtre optionnel sur une marketplace (ID Amazon). */
export type Scope = AppConfig & { mkt?: string | null };

/** Applique le filtre marketplace (code pays "FR", "DE"...) à la configuration. */
export function withMarketplace(cfg: AppConfig, code: string | null | undefined): Scope {
  const m = code ? cfg.marketplaces.find((x) => x.code === code.toUpperCase()) : undefined;
  return { ...cfg, mkt: m?.id ?? null };
}

interface ItemRow {
  order_item_id: string;
  order_id: string;
  purchase_date: string;
  status: string;
  marketplace_id: string | null;
  sku: string | null;
  asin: string | null;
  title: string | null;
  quantity: number;
  sales_ttc: number;
  vat: number;
  unit_price_ttc: number | null;
  price_estimated: number;
  cogs: number | null;
  extra_cost: number | null;
}

interface FinRow {
  order_id: string | null;
  sku: string | null;
  quantity: number | null;
  posted_date: string;
  kind: string;
  description: string | null;
  transaction_type: string | null;
  marketplace_id: string | null;
  revenue: number;
  tax: number;
  promo: number;
  fees: number;
  fee_tax: number | null;
  fee_detail: string | null;
  total: number;
}

/**
 * Frais Amazon d'une ligne financière (signés, négatifs = coût) : HT si vous êtes assujetti à la TVA,
 * sinon TVA réellement facturée par Amazon comprise (ce que vous payez vraiment, en micro-entreprise).
 */
function feeOf(f: Pick<FinRow, "fees" | "fee_tax">, cfg: AppConfig): number {
  return f.fees + (cfg.vatRegistered ? 0 : f.fee_tax ?? 0);
}

const HISTORY_DAYS = 120;

/** Frais réels par article de commande, à partir des lignes financières "shipment". */
function allocateActualFees(items: ItemRow[], finLines: FinRow[], cfg: AppConfig): Map<string, number> {
  const byOrder = new Map<string, FinRow[]>();
  for (const f of finLines) {
    if (!f.order_id) continue;
    const list = byOrder.get(f.order_id) ?? [];
    list.push(f);
    byOrder.set(f.order_id, list);
  }
  const itemsByOrder = new Map<string, ItemRow[]>();
  for (const it of items) {
    const list = itemsByOrder.get(it.order_id) ?? [];
    list.push(it);
    itemsByOrder.set(it.order_id, list);
  }

  const out = new Map<string, number>();
  for (const [orderId, lines] of byOrder) {
    const orderItems = itemsByOrder.get(orderId);
    if (!orderItems) continue;
    const orderSales = orderItems.reduce((s, i) => s + Math.max(i.sales_ttc, 0), 0);
    const skus = new Set(orderItems.map((i) => i.sku));
    let unassigned = 0;
    const bySku = new Map<string, number>();
    for (const l of lines) {
      const cost = -feeOf(l, cfg); // frais Amazon négatifs -> coût positif
      if (l.sku && skus.has(l.sku)) bySku.set(l.sku, (bySku.get(l.sku) ?? 0) + cost);
      else unassigned += cost;
    }
    for (const it of orderItems) {
      const sameSku = orderItems.filter((i) => i.sku === it.sku);
      const skuQty = sameSku.reduce((s, i) => s + i.quantity, 0) || 1;
      const skuPart = it.sku && bySku.has(it.sku) ? (bySku.get(it.sku)! * it.quantity) / skuQty : 0;
      const share = orderSales > 0 ? Math.max(it.sales_ttc, 0) / orderSales : 1 / orderItems.length;
      out.set(it.order_item_id, skuPart + unassigned * share);
    }
  }
  return out;
}

function loadItems(from: string, to: string, mkt: string | null = null): ItemRow[] {
  return getDb()
    .prepare(
      `SELECT oi.order_item_id, oi.order_id, o.purchase_date, o.status, o.marketplace_id, oi.sku, oi.asin,
              COALESCE(oi.title, p.title) AS title, oi.quantity, oi.sales_ttc, oi.vat, oi.unit_price_ttc, oi.price_estimated,
              p.cogs, p.extra_cost
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       LEFT JOIN products p ON p.sku = oi.sku
       WHERE o.purchase_date >= ? AND o.purchase_date < ? AND o.status != 'CANCELLED' AND oi.quantity > 0
         AND (? IS NULL OR o.marketplace_id = ?)`,
    )
    .all(from, to, mkt, mkt) as ItemRow[];
}

/**
 * Une transaction différée libérée garde le statut DEFERRED_RELEASED et Amazon crée en plus
 * une transaction RELEASED identique : on ignore la première pour ne pas compter deux fois.
 */
const ACTIVE_FIN = "status IS NOT 'DEFERRED_RELEASED'";

function loadShipmentFinance(orderIds: string[]): FinRow[] {
  if (orderIds.length === 0) return [];
  const db = getDb();
  const out: FinRow[] = [];
  for (let i = 0; i < orderIds.length; i += 500) {
    const chunk = orderIds.slice(i, i + 500);
    out.push(
      ...(db
        .prepare(`SELECT * FROM finance_lines WHERE kind = 'shipment' AND ${ACTIVE_FIN} AND order_id IN (${chunk.map(() => "?").join(",")})`)
        .all(...chunk) as FinRow[]),
    );
  }
  return out;
}

interface FeeHistory {
  feesPerUnit: number;
  unitPriceTtc: number;
}

let historyCache: { at: number; map: Map<string, FeeHistory>; prices: Map<string, number> } | null = null;

/** Historique des frais réels par SKU/marketplace (sert à estimer les commandes non réglées). */
function feeHistory(cfg: AppConfig): { map: Map<string, FeeHistory>; prices: Map<string, number> } {
  if (historyCache && Date.now() - historyCache.at < 60_000) return historyCache;
  const now = new Date();
  const items = loadItems(new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString(), now.toISOString());
  const fin = loadShipmentFinance([...new Set(items.map((i) => i.order_id))]);
  const actual = allocateActualFees(items, fin, cfg);
  const agg = new Map<string, { fees: number; units: number; sales: number }>();
  const prices = new Map<string, number>();
  for (const it of [...items].sort((a, b) => a.purchase_date.localeCompare(b.purchase_date))) {
    if (it.sku && it.unit_price_ttc && !it.price_estimated) {
      prices.set(`${it.sku}|${it.marketplace_id}`, it.unit_price_ttc);
      prices.set(`${it.sku}|*`, it.unit_price_ttc);
    }
    const fees = actual.get(it.order_item_id);
    if (fees === undefined || !it.sku || it.price_estimated) continue;
    for (const key of [`${it.sku}|${it.marketplace_id}`, `${it.sku}|*`]) {
      const a = agg.get(key) ?? { fees: 0, units: 0, sales: 0 };
      a.fees += fees;
      a.units += it.quantity;
      a.sales += it.sales_ttc;
      agg.set(key, a);
    }
  }
  const map = new Map<string, FeeHistory>();
  for (const [k, a] of agg) if (a.units > 0) map.set(k, { feesPerUnit: a.fees / a.units, unitPriceTtc: a.sales / a.units });

  // Estimations de l'API Product Fees (produits sans historique)
  const est = getDb().prepare("SELECT sku, marketplace_id, price, fees FROM fee_estimates").all() as {
    sku: string;
    marketplace_id: string;
    price: number;
    fees: number;
  }[];
  for (const e of est) {
    const key = `${e.sku}|${e.marketplace_id}`;
    // L'API Product Fees renvoie des frais HT
    if (!map.has(key)) map.set(key, { feesPerUnit: e.fees * (cfg.vatRegistered ? 1 : 1 + cfg.feesVatRate), unitPriceTtc: e.price });
  }
  historyCache = { at: Date.now(), map, prices };
  return historyCache;
}

export function loadSales(range: Range, cfg: Scope = getConfig()): SaleLine[] {
  const items = loadItems(range.from.toISOString(), range.to.toISOString(), cfg.mkt ?? null);
  const fifo = loadFifo();
  const fin = loadShipmentFinance([...new Set(items.map((i) => i.order_id))]);
  const actual = allocateActualFees(items, fin, cfg);
  const { map: history, prices } = feeHistory(cfg);

  return items.map((it) => {
    let salesTtc = it.sales_ttc;
    let vat = it.vat;
    let unit = it.unit_price_ttc ?? (it.quantity ? it.sales_ttc / it.quantity : 0);
    if (it.price_estimated) {
      // Commande en attente sans prix : on prend le dernier prix de vente connu
      unit = prices.get(`${it.sku}|${it.marketplace_id}`) ?? prices.get(`${it.sku}|*`) ?? 0;
      salesTtc = unit * it.quantity;
      const r = vatRateFor(it.marketplace_id, cfg);
      vat = salesTtc - salesTtc / (1 + r);
    }
    const actualFees = actual.get(it.order_item_id);
    const fees =
      actualFees !== undefined
        ? actualFees
        : estimateLineFees(
            it.quantity,
            unit,
            salesTtc,
            history.get(`${it.sku}|${it.marketplace_id}`) ?? history.get(`${it.sku}|*`),
            cfg.fallbackFeeRate,
          );
    return {
      date: it.purchase_date,
      orderId: it.order_id,
      sku: it.sku,
      title: it.title,
      asin: it.asin,
      marketplaceId: it.marketplace_id,
      status: it.status,
      quantity: it.quantity,
      salesTtc,
      vat,
      fees,
      feesEstimated: actualFees === undefined,
      // coût FIFO du lot consommé, sinon prix d'achat par défaut du SKU
      cogsUnit: fifo.costs.get(it.order_item_id)?.unitCost ?? (it.cogs === null || it.cogs === undefined ? null : it.cogs + (it.extra_cost ?? 0)),
    };
  });
}

export function loadRefunds(range: Range, cfg: Scope = getConfig()): RefundLine[] {
  const fifo = loadFifo();
  const rows = getDb()
    .prepare(
      `SELECT f.*, p.cogs, p.extra_cost,
              (SELECT oi.quantity FROM order_items oi WHERE oi.order_id = f.order_id AND (f.sku IS NULL OR oi.sku = f.sku) LIMIT 1) AS item_qty
       FROM finance_lines f LEFT JOIN products p ON p.sku = f.sku
       WHERE f.kind = 'refund' AND f.${ACTIVE_FIN} AND f.posted_date >= ? AND f.posted_date < ? AND (? IS NULL OR f.marketplace_id = ?)`,
    )
    .all(range.from.toISOString(), range.to.toISOString(), cfg.mkt ?? null, cfg.mkt ?? null) as (FinRow & {
    cogs: number | null;
    extra_cost: number | null;
    item_qty: number | null;
  })[];

  return rows.map((f) => {
    const hasTax = f.tax < 0;
    const refundTtc = Math.max(0, -(f.revenue + f.promo + (hasTax ? f.tax : 0)));
    const r = vatRateFor(f.marketplace_id, cfg);
    const vatBack = hasTax ? -f.tax : refundTtc - refundTtc / (1 + r);
    const qty = f.quantity ?? (refundTtc > 0 ? f.item_qty ?? 1 : 0);
    const cogsUnit = (f.sku ? currentUnitCost(f.sku, fifo) : null) ?? 0;
    return {
      date: f.posted_date,
      orderId: f.order_id,
      sku: f.sku,
      quantity: qty,
      refundTtc,
      vatBack,
      feesNet: feeOf(f, cfg),
      cogsRecovered: cfg.returnRestockRate * qty * cogsUnit,
    };
  });
}

export function loadOtherCosts(range: Range, cfg: Scope = getConfig()): OtherCost[] {
  const db = getDb();
  const amazon = (
    db
      .prepare(
        `SELECT posted_date, description, transaction_type, total, fee_tax FROM finance_lines
         WHERE kind = 'other' AND ${ACTIVE_FIN} AND posted_date >= ? AND posted_date < ? AND (? IS NULL OR marketplace_id = ?)`,
      )
      .all(range.from.toISOString(), range.to.toISOString(), cfg.mkt ?? null, cfg.mkt ?? null) as FinRow[]
  ).map<OtherCost>((f) => ({
    date: f.posted_date,
    label: f.description || f.transaction_type || "Frais Amazon",
    category: otherCategory(f.transaction_type, f.description),
    // montant total = TVA comprise ; HT si assujetti
    amount: -(f.total - (cfg.vatRegistered ? f.fee_tax ?? 0 : 0)),
    source: "amazon",
  }));
  const fromKey = localDayKey(range.from.toISOString(), cfg.timezone);
  const toKey = localDayKey(new Date(range.to.getTime() - 1).toISOString(), cfg.timezone);
  const manual = (
    db.prepare(`SELECT date, label, amount FROM expenses WHERE date >= ? AND date <= ?`).all(fromKey, toKey) as {
      date: string;
      label: string;
      amount: number;
    }[]
  ).map<OtherCost>((e) => ({
    // début de journée locale
    date: startOfDay(
      { y: Number(e.date.slice(0, 4)), m: Number(e.date.slice(5, 7)), d: Number(e.date.slice(8, 10)) },
      cfg.timezone,
    ).toISOString(),
    label: e.label,
    category: `Dépense : ${e.label}`,
    amount: e.amount,
    source: "manual",
  }));
  // Les dépenses saisies ne sont pas rattachées à un pays : comptées seulement dans la vue « Tous »
  return cfg.mkt ? amazon : [...amazon, ...manual];
}

export function summarize(range: Range, cfg: Scope = getConfig()): Summary {
  return computeSummary(loadSales(range, cfg), loadRefunds(range, cfg), loadOtherCosts(range, cfg), {
    vatRegistered: cfg.vatRegistered,
    feesVatRate: cfg.feesVatRate,
  });
}

/* ---------------------------------------------------------------------------
 * Détail du bénéfice (chaque montant, ligne par ligne)
 * ------------------------------------------------------------------------- */

/** Libellés des frais Amazon par commande (type de frais de l'API Finances). */
const FEE_LABELS: [RegExp, string][] = [
  [/^commission$/i, "Commission Amazon"],
  [/^refundcommission$/i, "Frais de remboursement"],
  [/fulfillment|fbaperunit|fbaweight|pickpack/i, "Frais d'expédition FBA"],
  [/digitalservices/i, "Taxe services numériques (DST)"],
  [/closing/i, "Frais de clôture"],
  [/shippingchargeback|shippinghb/i, "Port refacturé par Amazon"],
  [/giftwrapchargeback/i, "Emballage cadeau refacturé"],
];

export function feeLabel(name: string): string {
  return FEE_LABELS.find(([re]) => re.test(name))?.[1] ?? name;
}

/** Regroupement des frais/crédits Amazon hors commandes. */
export function otherCategory(type: string | null, description: string | null): string {
  const t = `${type ?? ""} ${description ?? ""}`;
  if (/reimbursement|clawback/i.test(t)) return "Indemnisations FBA (stock perdu ou endommagé)";
  if (/subscription/i.test(t)) return "Abonnement vendeur Amazon";
  if (/inbound|transportation|placement/i.test(t)) return "Transport vers les entrepôts (inbound)";
  if (/storage/i.test(t)) return "Stockage FBA";
  if (/removal|disposal|liquidat/i.test(t)) return "Retrait / destruction de stock";
  if (/epr|eco/i.test(t)) return "Éco-participation (EPR)";
  if (/advertis|sponsored|ads/i.test(t)) return "Publicité";
  return description || type || "Autres frais Amazon";
}

export interface BreakdownLine {
  label: string;
  amount: number; // signé : + gain, − coût
  note?: string;
}

export interface BreakdownSection {
  key: "sales" | "fees" | "cogs" | "refunds" | "other";
  title: string;
  total: number;
  lines: BreakdownLine[];
}

export interface ProfitBreakdown {
  summary: Summary;
  vatRegistered: boolean;
  sections: BreakdownSection[];
  feeVat: number; // TVA payée à Amazon sur ses frais (incluse dans les montants ci-dessus si non assujetti)
}

const r2b = (n: number) => Math.round(n * 100) / 100;

function linesFrom(map: Map<string, number>, notes: Map<string, string> = new Map()): BreakdownLine[] {
  return [...map.entries()]
    .filter(([, v]) => Math.abs(v) >= 0.005)
    .sort((a, b) => a[1] - b[1])
    .map(([label, amount]) => ({ label, amount: r2b(amount), note: notes.get(label) }));
}

/**
 * Détail du bénéfice net sur une période : mêmes données et mêmes règles que les cartes du dashboard,
 * mais chaque frais Amazon est séparé (commission, FBA, taxe numérique, abonnement, inbound…).
 * La somme des sections est égale au bénéfice net.
 */
export function profitBreakdown(range: Range, cfg: Scope = getConfig()): ProfitBreakdown {
  const sales = loadSales(range, cfg);
  const refunds = loadRefunds(range, cfg);
  const others = loadOtherCosts(range, cfg);
  const summary = computeSummary(sales, refunds, others, { vatRegistered: cfg.vatRegistered, feesVatRate: cfg.feesVatRate });
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  let feeVat = 0;

  // Ventes
  const salesLines: BreakdownLine[] = [{ label: "Ventes TTC (articles + port − promotions)", amount: summary.salesTtc }];
  if (cfg.vatRegistered) salesLines.push({ label: "TVA collectée", amount: -summary.vat });

  // Frais Amazon des commandes : réels par type, estimés pour les commandes pas encore réglées
  const fees = new Map<string, number>();
  const settled = new Set(sales.filter((l) => !l.feesEstimated).map((l) => l.orderId));
  for (const f of loadShipmentFinance([...settled])) {
    feeVat += -(f.fee_tax ?? 0);
    const detail = f.fee_detail ? (JSON.parse(f.fee_detail) as Record<string, [number, number]>) : null;
    if (!detail) {
      if (f.fees) add(fees, "Autres frais sur commandes", feeOf(f, cfg));
      continue;
    }
    for (const [name, [ht, tva]] of Object.entries(detail)) add(fees, feeLabel(name), ht + (cfg.vatRegistered ? 0 : tva));
  }
  const estimated = sales.filter((l) => l.feesEstimated).reduce((s, l) => s + l.fees, 0);
  if (estimated) fees.set("Frais estimés (commandes pas encore réglées)", -estimated);
  const feeLines = linesFrom(fees);
  const feeGap = -summary.amazonFees - feeLines.reduce((s, l) => s + l.amount, 0);
  if (Math.abs(feeGap) >= 0.01) feeLines.push({ label: "Arrondis", amount: r2b(feeGap) });

  // Remboursements
  const refundBase = refunds.reduce((s, r) => s + r.refundTtc - (cfg.vatRegistered ? r.vatBack : 0), 0);
  const refundFees = refunds.reduce((s, r) => s + r.feesNet, 0);
  const restock = refunds.reduce((s, r) => s + r.cogsRecovered, 0);
  const refundLines: BreakdownLine[] = [
    { label: `Montant remboursé aux clients${cfg.vatRegistered ? " (HT)" : ""}`, amount: r2b(-refundBase) },
    { label: "Frais rendus par Amazon, nets des frais de remboursement", amount: r2b(refundFees) },
  ];
  if (restock) refundLines.push({ label: "Stock remis en vente (coût d'achat récupéré)", amount: r2b(restock) });
  feeVat += -(
    getDb()
      .prepare(
      `SELECT COALESCE(SUM(fee_tax), 0) AS t FROM finance_lines WHERE kind != 'shipment' AND ${ACTIVE_FIN}
       AND posted_date >= ? AND posted_date < ? AND (? IS NULL OR marketplace_id = ?)`,
    )
    .get(range.from.toISOString(), range.to.toISOString(), cfg.mkt ?? null, cfg.mkt ?? null) as { t: number }
  ).t;

  // Autres frais et crédits
  const other = new Map<string, number>();
  for (const o of others) add(other, o.category ?? o.label, -o.amount);

  const sections: BreakdownSection[] = [
    { key: "sales", title: cfg.vatRegistered ? "Ventes HT" : "Ventes", total: summary.salesHt, lines: salesLines },
    { key: "fees", title: "Frais Amazon sur les commandes", total: -summary.amazonFees, lines: feeLines },
    {
      key: "cogs",
      title: "Coût d'achat des unités vendues",
      total: -summary.cogs,
      lines: [
        {
          label: `${fmtUnits(summary.units - summary.missingCogsUnits)} unité(s) avec prix d'achat`,
          amount: -summary.cogs,
          note: summary.missingCogsUnits ? `${summary.missingCogsUnits} unité(s) sans prix d'achat, comptée(s) à 0 €` : undefined,
        },
      ],
    },
    { key: "refunds", title: "Remboursements et retours", total: -summary.refundCost, lines: refundLines },
    { key: "other", title: "Autres frais et crédits Amazon", total: -summary.otherCosts, lines: linesFrom(other) },
  ];
  return { summary, vatRegistered: cfg.vatRegistered, sections, feeVat: r2b(feeVat) };
}

const fmtUnits = (n: number) => String(Math.round(n));

/* ---------------------------------------------------------------------------
 * Données du dashboard
 * ------------------------------------------------------------------------- */

export interface Card {
  key: "today" | "yesterday" | "month" | "lastMonth" | "forecast";
  title: string;
  subtitle: string;
  live?: boolean;
  summary: Summary;
  compare: { pct: number | null; label: string; previousSales: number } | null;
}

export function dashboardCards(now = new Date(), cfg: Scope = getConfig()): Card[] {
  const tz = cfg.timezone;
  const today = toYMD(now, tz);
  const yesterday = addDays(today, -1);
  const lastWeekSameDay = addDays(today, -7);
  const todayStart = startOfDay(today, tz);
  const elapsedToday = now.getTime() - todayStart.getTime();

  // Aujourd'hui vs même jour la semaine dernière, à la même heure
  const todayS = summarize({ from: todayStart, to: now }, cfg);
  const lwStart = startOfDay(lastWeekSameDay, tz);
  const lwS = summarize({ from: lwStart, to: new Date(lwStart.getTime() + elapsedToday) }, cfg);

  // Hier vs même jour de la semaine précédente
  const yS = summarize(dayRange(yesterday, tz), cfg);
  const yPrev = summarize(dayRange(addDays(yesterday, -7), tz), cfg);

  // Mois en cours vs mois précédent à la même date
  const monthStart = startOfDay({ ...today, d: 1 }, tz);
  const mS = summarize({ from: monthStart, to: now }, cfg);
  const prevMonth = addMonths({ ...today, d: 1 }, -1);
  const prevMonthStart = startOfDay(prevMonth, tz);
  const sameDayPrev = addMonths(today, -1);
  const prevMonthSameTime = new Date(startOfDay(sameDayPrev, tz).getTime() + elapsedToday);
  const mPrevSameTime = summarize({ from: prevMonthStart, to: prevMonthSameTime }, cfg);

  // Mois dernier complet vs le mois d'avant
  const lmS = summarize(monthRange(prevMonth.y, prevMonth.m, tz), cfg);
  const pm2 = addMonths(prevMonth, -1);
  const lm2S = summarize(monthRange(pm2.y, pm2.m, tz), cfg);

  // Prévision : moyenne des 14 derniers jours complets
  const recentFrom = startOfDay(addDays(today, -14), tz);
  const recent = summarize({ from: recentFrom, to: todayStart }, cfg);
  const dim = daysInMonth(today.y, today.m);
  const elapsedDays = (now.getTime() - monthStart.getTime()) / 86_400_000;
  const forecast = forecastMonth(mS, recent, 14, elapsedDays, dim);

  const weekday = FR_WEEKDAYS[weekdayOf(today)];
  const ywd = FR_WEEKDAYS[weekdayOf(yesterday)];
  const mName = FR_MONTHS[today.m - 1];
  const pmName = FR_MONTHS[prevMonth.m - 1];

  return [
    {
      key: "today",
      title: "Aujourd'hui",
      subtitle: formatDayFr(today),
      live: true,
      summary: todayS,
      compare: { pct: pctChange(todayS.salesTtc, lwS.salesTtc), label: `vs ${weekday} dernier à la même heure`, previousSales: lwS.salesTtc },
    },
    {
      key: "yesterday",
      title: "Hier",
      subtitle: formatDayFr(yesterday),
      summary: yS,
      compare: { pct: pctChange(yS.salesTtc, yPrev.salesTtc), label: `vs ${ywd} précédent`, previousSales: yPrev.salesTtc },
    },
    {
      key: "month",
      title: "Ce mois",
      subtitle: `${mName} ${today.y}`,
      summary: mS,
      compare: { pct: pctChange(mS.salesTtc, mPrevSameTime.salesTtc), label: `vs ${pmName} à la même date`, previousSales: mPrevSameTime.salesTtc },
    },
    {
      key: "lastMonth",
      title: "Mois dernier",
      subtitle: `${pmName} ${prevMonth.y}`,
      summary: lmS,
      compare: { pct: pctChange(lmS.salesTtc, lm2S.salesTtc), label: `vs ${FR_MONTHS[pm2.m - 1]}`, previousSales: lm2S.salesTtc },
    },
    {
      key: "forecast",
      title: "Prévision",
      subtitle: `fin ${mName} ${today.y}`,
      summary: forecast,
      compare: { pct: pctChange(forecast.salesTtc, lmS.salesTtc), label: `vs ${pmName}`, previousSales: lmS.salesTtc },
    },
  ];
}

export interface ChartPoint {
  key: string; // YYYY-MM-DD ou YYYY-MM
  label: string;
  salesTtc: number;
  netProfit: number;
  orders: number;
  units: number;
  future?: boolean;
}

/** Série journalière (mois) ou mensuelle (année). */
export function chartSeries(period: { year: number; month?: number }, now = new Date(), cfg: Scope = getConfig()): ChartPoint[] {
  const tz = cfg.timezone;
  const range = period.month ? monthRange(period.year, period.month, tz) : yearRange(period.year, tz);
  const sales = loadSales(range, cfg);
  const refunds = loadRefunds(range, cfg);
  const others = loadOtherCosts(range, cfg);
  const keyOf = (iso: string) => (period.month ? localDayKey(iso, tz) : localDayKey(iso, tz).slice(0, 7));
  const group = <T extends { date: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) {
      const k = keyOf(x.date);
      m.set(k, [...(m.get(k) ?? []), x]);
    }
    return m;
  };
  const gs = group(sales);
  const gr = group(refunds);
  const go = group(others);

  const nowKey = ymdKey(toYMD(now, tz));
  const keys: { key: string; label: string }[] = [];
  if (period.month) {
    for (let d = 1; d <= daysInMonth(period.year, period.month); d++) {
      const ymd: YMD = { y: period.year, m: period.month, d };
      keys.push({ key: ymdKey(ymd), label: String(d) });
    }
  } else {
    const short = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];
    for (let m = 1; m <= 12; m++) keys.push({ key: `${period.year}-${String(m).padStart(2, "0")}`, label: short[m - 1] });
  }
  const tax = { vatRegistered: cfg.vatRegistered, feesVatRate: cfg.feesVatRate };
  return keys.map(({ key, label }) => {
    const s = computeSummary(gs.get(key) ?? [], gr.get(key) ?? [], go.get(key) ?? [], tax);
    return {
      key,
      label,
      salesTtc: s.salesTtc,
      netProfit: s.netProfit,
      orders: s.orders,
      units: s.units,
      future: period.month ? key > nowKey : key > nowKey.slice(0, 7),
    };
  });
}

export interface ProductRow {
  sku: string;
  asin: string | null;
  title: string | null;
  units: number;
  orders: number;
  salesTtc: number;
  amazonFees: number;
  cogs: number;
  refunds: number;
  netProfit: number;
  margin: number | null;
  roi: number | null;
  cogsMissing: boolean;
}

/** Rentabilité par produit sur une période. */
export function productBreakdown(range: Range, cfg: Scope = getConfig()): ProductRow[] {
  const sales = loadSales(range, cfg);
  const refunds = loadRefunds(range, cfg);
  const bySku = new Map<string, SaleLine[]>();
  for (const s of sales) {
    const k = s.sku ?? "(sans SKU)";
    bySku.set(k, [...(bySku.get(k) ?? []), s]);
  }
  const refundsBySku = new Map<string, RefundLine[]>();
  for (const r of refunds) {
    const k = r.sku ?? "(sans SKU)";
    refundsBySku.set(k, [...(refundsBySku.get(k) ?? []), r]);
  }
  const tax = { vatRegistered: cfg.vatRegistered, feesVatRate: cfg.feesVatRate };
  const skus = new Set([...bySku.keys(), ...refundsBySku.keys()]);
  return [...skus]
    .map((sku) => {
      const lines = bySku.get(sku) ?? [];
      const s = computeSummary(lines, refundsBySku.get(sku) ?? [], [], tax);
      return {
        sku,
        asin: lines[0]?.asin ?? null,
        title: lines[0]?.title ?? null,
        units: s.units,
        orders: s.orders,
        salesTtc: s.salesTtc,
        amazonFees: s.amazonFees,
        cogs: s.cogs,
        refunds: s.refunds,
        netProfit: s.netProfit,
        margin: s.margin,
        roi: s.roi,
        cogsMissing: s.missingCogsUnits > 0,
      };
    })
    .sort((a, b) => b.salesTtc - a.salesTtc);
}

/* ---------------------------------------------------------------------------
 * Rentabilité par pays (marketplace)
 * ------------------------------------------------------------------------- */

export interface CountryRow {
  code: string;
  name: string;
  summary: Summary;
}

export function countryBreakdown(range: Range, cfg: AppConfig = getConfig()): CountryRow[] {
  return cfg.marketplaces
    .map((m) => ({ code: m.code, name: m.name, summary: summarize(range, { ...cfg, mkt: m.id }) }))
    .filter((r) => r.summary.orders > 0 || r.summary.refunds > 0)
    .sort((a, b) => b.summary.salesTtc - a.summary.salesTtc);
}

/* ---------------------------------------------------------------------------
 * Liste des commandes avec leur bénéfice
 * ------------------------------------------------------------------------- */

export interface OrderRowView {
  orderId: string;
  date: string;
  country: string | null;
  status: string;
  items: { sku: string | null; title: string | null; asin: string | null; quantity: number }[];
  units: number;
  salesTtc: number;
  salesHt: number;
  fees: number;
  feesEstimated: boolean;
  cogs: number | null;
  profit: number | null;
  margin: number | null;
  refunded: boolean;
}

export function ordersList(
  range: Range,
  opts: { q?: string; onlyLoss?: boolean; page?: number; pageSize?: number } = {},
  cfg: Scope = getConfig(),
): { rows: OrderRowView[]; total: number; totals: { salesTtc: number; profit: number; orders: number } } {
  const lines = loadSales(range, cfg);
  const byOrder = new Map<string, SaleLine[]>();
  for (const l of lines) byOrder.set(l.orderId, [...(byOrder.get(l.orderId) ?? []), l]);

  const ids = [...byOrder.keys()];
  const refunded = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of getDb()
      .prepare(`SELECT DISTINCT order_id FROM finance_lines WHERE kind = 'refund' AND ${ACTIVE_FIN} AND order_id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as { order_id: string }[])
      refunded.add(r.order_id);
  }

  const codeOf = (id: string | null) => cfg.marketplaces.find((m) => m.id === id)?.code ?? null;
  let rows: OrderRowView[] = [...byOrder.entries()].map(([orderId, ls]) => {
    const salesTtc = ls.reduce((s, l) => s + l.salesTtc, 0);
    const vat = cfg.vatRegistered ? ls.reduce((s, l) => s + l.vat, 0) : 0;
    const fees = ls.reduce((s, l) => s + l.fees, 0);
    const cogsKnown = ls.every((l) => l.cogsUnit !== null);
    const cogs = cogsKnown ? ls.reduce((s, l) => s + (l.cogsUnit as number) * l.quantity, 0) : null;
    const salesHt = salesTtc - vat;
    const profit = cogs === null ? null : salesHt - fees - cogs;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      orderId,
      date: ls[0].date,
      country: codeOf(ls[0].marketplaceId),
      status: ls[0].status,
      items: ls.map((l) => ({ sku: l.sku, title: l.title, asin: l.asin, quantity: l.quantity })),
      units: ls.reduce((s, l) => s + l.quantity, 0),
      salesTtc: r2(salesTtc),
      salesHt: r2(salesHt),
      fees: r2(fees),
      feesEstimated: ls.some((l) => l.feesEstimated),
      cogs: cogs === null ? null : r2(cogs),
      profit: profit === null ? null : r2(profit),
      margin: profit !== null && (cfg.vatRegistered ? salesHt : salesTtc) > 0 ? profit / (cfg.vatRegistered ? salesHt : salesTtc) : null,
      refunded: refunded.has(orderId),
    };
  });

  if (opts.q) {
    const q = opts.q.toLowerCase();
    rows = rows.filter((r) => r.orderId.toLowerCase().includes(q) || r.items.some((i) => `${i.sku} ${i.asin} ${i.title}`.toLowerCase().includes(q)));
  }
  if (opts.onlyLoss) rows = rows.filter((r) => r.profit !== null && r.profit < 0);
  rows.sort((a, b) => b.date.localeCompare(a.date));

  const totals = {
    salesTtc: Math.round(rows.reduce((s, r) => s + r.salesTtc, 0) * 100) / 100,
    profit: Math.round(rows.reduce((s, r) => s + (r.profit ?? 0), 0) * 100) / 100,
    orders: rows.length,
  };
  const size = opts.pageSize ?? 100;
  const page = Math.max(1, opts.page ?? 1);
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length, totals };
}
