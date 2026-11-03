import { getConfig, type AppConfig } from "./config";
import { getDb } from "./db";
import { currentUnitCost, loadFifo } from "./fifo";

/**
 * Stock FBA et réassort.
 *
 *   Stock vendable   = disponible + réservé (transferts entre entrepôts, traitement)
 *                      (les unités réservées pour des commandes clients sont déjà vendues)
 *   Entrant          = en préparation + expédié + en réception
 *   Vitesse          = unités vendues sur 30 jours / 30
 *   Jours de stock   = stock vendable / vitesse
 *   À commander      = vitesse × couverture visée − (vendable + entrant)
 *   Valeur du stock  = (vendable + entrant) × coût unitaire actuel (lots FIFO restants)
 */

export type StockStatus = "rupture" | "reassort" | "ok" | "surstock" | "dormant" | "inactif";

export interface StockRow {
  sku: string;
  asin: string | null;
  title: string | null;
  available: number;
  sellable: number;
  inbound: number;
  reservedCustomer: number;
  unfulfillable: number;
  sold7: number;
  sold30: number;
  sold90: number;
  velocity: number; // unités / jour (30 j)
  daysOfStock: number | null; // null = pas de ventes
  daysWithInbound: number | null;
  stockoutDate: string | null; // YYYY-MM-DD estimée
  reorderQty: number;
  unitCost: number | null;
  stockValue: number | null;
  status: StockStatus;
}

export interface StockOverview {
  updatedAt: string | null;
  totals: {
    skus: number;
    units: number;
    inboundUnits: number;
    unfulfillableUnits: number;
    value: number;
    valueMissingSkus: number;
    rupture: number;
    reassort: number;
    surstock: number;
    dormant: number;
  };
  rows: StockRow[];
}

interface InvRow {
  sku: string;
  asin: string | null;
  title: string | null;
  fulfillable: number;
  inbound_working: number;
  inbound_shipped: number;
  inbound_receiving: number;
  reserved_customer: number;
  reserved_transfer: number;
  reserved_processing: number;
  unfulfillable: number;
  updated_at: string;
}

export function stockOverview(cfg: AppConfig = getConfig(), now = new Date()): StockOverview {
  const db = getDb();
  const inv = db
    .prepare(
      `SELECT i.*, COALESCE(i.title, p.title) AS title, COALESCE(i.asin, p.asin) AS asin
       FROM inventory i LEFT JOIN products p ON p.sku = i.sku`,
    )
    .all() as InvRow[];

  const salesRows = db
    .prepare(
      `SELECT oi.sku,
              SUM(CASE WHEN o.purchase_date >= ? THEN oi.quantity ELSE 0 END) AS s7,
              SUM(CASE WHEN o.purchase_date >= ? THEN oi.quantity ELSE 0 END) AS s30,
              SUM(oi.quantity) AS s90
       FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
       WHERE o.status != 'CANCELLED' AND o.purchase_date >= ? AND oi.sku IS NOT NULL
       GROUP BY oi.sku`,
    )
    .all(
      new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      new Date(now.getTime() - 30 * 86_400_000).toISOString(),
      new Date(now.getTime() - 90 * 86_400_000).toISOString(),
    ) as { sku: string; s7: number; s30: number; s90: number }[];
  const sales = new Map(salesRows.map((r) => [r.sku, r]));
  const fifo = loadFifo();

  const rows = inv.map<StockRow>((i) => {
    const s = sales.get(i.sku) ?? { s7: 0, s30: 0, s90: 0 };
    const sellable = i.fulfillable + i.reserved_transfer + i.reserved_processing;
    const inbound = i.inbound_working + i.inbound_shipped + i.inbound_receiving;
    const velocity = s.s30 / 30;
    const days = velocity > 0 ? sellable / velocity : null;
    const daysIn = velocity > 0 ? (sellable + inbound) / velocity : null;
    const unitCost = currentUnitCost(i.sku, fifo);
    const reorderQty = velocity > 0 ? Math.max(0, Math.ceil(velocity * cfg.targetStockDays - sellable - inbound)) : 0;

    let status: StockStatus;
    if (sellable + inbound === 0) status = s.s90 > 0 ? "rupture" : "inactif";
    else if (sellable === 0 && s.s90 > 0) status = "rupture";
    else if (s.s90 === 0 && sellable > 0) status = "dormant";
    else if (daysIn !== null && daysIn < cfg.reorderDays) status = "reassort";
    else if (days !== null && days > cfg.overstockDays) status = "surstock";
    else status = "ok";

    return {
      sku: i.sku,
      asin: i.asin,
      title: i.title,
      available: i.fulfillable,
      sellable,
      inbound,
      reservedCustomer: i.reserved_customer,
      unfulfillable: i.unfulfillable,
      sold7: s.s7,
      sold30: s.s30,
      sold90: s.s90,
      velocity: Math.round(velocity * 100) / 100,
      daysOfStock: days === null ? null : Math.round(days),
      daysWithInbound: daysIn === null ? null : Math.round(daysIn),
      stockoutDate: days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10),
      reorderQty,
      unitCost: unitCost === null ? null : Math.round(unitCost * 100) / 100,
      stockValue: unitCost === null ? null : Math.round((sellable + inbound) * unitCost * 100) / 100,
      status,
    };
  });

  const order: Record<StockStatus, number> = { rupture: 0, reassort: 1, surstock: 2, dormant: 3, ok: 4, inactif: 5 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.sold30 - a.sold30 || (b.stockValue ?? 0) - (a.stockValue ?? 0));

  const count = (st: StockStatus) => rows.filter((r) => r.status === st).length;
  return {
    updatedAt: inv[0]?.updated_at ?? null,
    totals: {
      skus: rows.filter((r) => r.sellable + r.inbound > 0).length,
      units: rows.reduce((s, r) => s + r.sellable, 0),
      inboundUnits: rows.reduce((s, r) => s + r.inbound, 0),
      unfulfillableUnits: rows.reduce((s, r) => s + r.unfulfillable, 0),
      value: Math.round(rows.reduce((s, r) => s + (r.stockValue ?? 0), 0) * 100) / 100,
      valueMissingSkus: rows.filter((r) => r.stockValue === null && r.sellable + r.inbound > 0).length,
      rupture: count("rupture"),
      reassort: count("reassort"),
      surstock: count("surstock"),
      dormant: count("dormant"),
    },
    rows,
  };
}
