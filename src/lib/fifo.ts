import { dataVersion, getDb } from "./db";

/**
 * Coût d'achat en FIFO (premier entré, premier sorti).
 *
 * Pour chaque SKU, les ventes (par date de commande) consomment les lots dans l'ordre
 * d'entrée en stock. Le coût d'une vente est le coût moyen des unités de lots consommées.
 * Une vente ne consomme que des lots déjà entrés en stock à sa date. Les unités qui ne sont
 * couvertes par aucun lot (ventes antérieures au premier lot connu, ou lots manquants) prennent
 * le prix d'achat par défaut du SKU, sinon le coût du lot le plus proche, sans consommer de lot.
 */

export interface Lot {
  id: string;
  sku: string;
  receivedAt: string;
  quantity: number;
  unitCost: number | null;
}

export interface Sale {
  id: string; // order_item_id
  sku: string;
  date: string;
  quantity: number;
}

export interface SaleCost {
  unitCost: number | null;
  source: "fifo" | "default" | "nearest" | "missing";
}

export interface LotState extends Lot {
  remaining: number;
}

export interface FifoResult {
  costs: Map<string, SaleCost>;
  lots: Map<string, LotState[]>; // par SKU, avec unités restantes
}

/** Calcul FIFO pur (testé dans tests/fifo.test.ts). */
export function computeFifo(lots: Lot[], sales: Sale[], defaultCost: Map<string, number>): FifoResult {
  const lotsBySku = new Map<string, LotState[]>();
  for (const l of [...lots].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))) {
    const list = lotsBySku.get(l.sku) ?? [];
    list.push({ ...l, remaining: Math.max(0, l.quantity) });
    lotsBySku.set(l.sku, list);
  }
  const salesBySku = new Map<string, Sale[]>();
  for (const s of sales) {
    const list = salesBySku.get(s.sku) ?? [];
    list.push(s);
    salesBySku.set(s.sku, list);
  }

  const costs = new Map<string, SaleCost>();
  for (const [sku, skuSales] of salesBySku) {
    skuSales.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const skuLots = lotsBySku.get(sku) ?? [];
    const known = skuLots.filter((l) => l.unitCost !== null);
    const fallbackFor = (date: string): { cost: number | null; source: SaleCost["source"] } => {
      const def = defaultCost.get(sku);
      if (def !== undefined) return { cost: def, source: "default" };
      if (known.length === 0) return { cost: null, source: "missing" };
      // lot connu le plus proche dans le temps
      const before = known.filter((l) => l.receivedAt <= date).pop();
      return { cost: (before ?? known[0]).unitCost, source: "nearest" };
    };

    for (const sale of skuSales) {
      let need = sale.quantity;
      let total = 0;
      let covered = 0;
      let unknown = false;
      let usedFallback: SaleCost["source"] | null = null;
      // Une vente ne peut consommer que des lots déjà entrés en stock (tolérance 2 jours)
      const limit = new Date(new Date(sale.date).getTime() + 2 * 86_400_000).toISOString();
      for (const lot of skuLots) {
        if (need <= 0) break;
        if (lot.remaining <= 0 || lot.receivedAt > limit) continue;
        const take = Math.min(need, lot.remaining);
        lot.remaining -= take;
        need -= take;
        if (lot.unitCost === null) {
          const fb = fallbackFor(lot.receivedAt);
          if (fb.cost === null) unknown = true;
          else {
            total += fb.cost * take;
            covered += take;
            usedFallback = fb.source;
          }
        } else {
          total += lot.unitCost * take;
          covered += take;
        }
      }
      if (need > 0) {
        const fb = fallbackFor(sale.date);
        if (fb.cost === null) unknown = true;
        else {
          total += fb.cost * need;
          covered += need;
          usedFallback = fb.source;
        }
      }
      if (unknown || covered === 0) costs.set(sale.id, { unitCost: null, source: "missing" });
      else costs.set(sale.id, { unitCost: total / covered, source: usedFallback ?? "fifo" });
    }
  }
  return { costs, lots: lotsBySku };
}

/* ---------- Chargement depuis la base, avec cache ---------- */

let cache: { at: number; version: number; result: FifoResult; defaults: Map<string, number> } | null = null;

export function loadFifo(): FifoResult & { defaults: Map<string, number> } {
  if (cache && cache.version === dataVersion() && Date.now() - cache.at < 60_000) return { ...cache.result, defaults: cache.defaults };
  const db = getDb();
  const lots = (
    db.prepare("SELECT id, sku, received_at, quantity, unit_cost FROM lots").all() as {
      id: string;
      sku: string;
      received_at: string;
      quantity: number;
      unit_cost: number | null;
    }[]
  ).map<Lot>((l) => ({ id: l.id, sku: l.sku, receivedAt: l.received_at, quantity: l.quantity, unitCost: l.unit_cost }));
  const sales = (
    db
      .prepare(
        `SELECT oi.order_item_id AS id, oi.sku, o.purchase_date AS date, oi.quantity
         FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
         WHERE o.status != 'CANCELLED' AND oi.sku IS NOT NULL AND oi.quantity > 0`,
      )
      .all() as Sale[]
  );
  const defaults = new Map<string, number>();
  for (const p of db.prepare("SELECT sku, cogs, extra_cost FROM products WHERE cogs IS NOT NULL").all() as {
    sku: string;
    cogs: number;
    extra_cost: number | null;
  }[]) {
    defaults.set(p.sku, p.cogs + (p.extra_cost ?? 0));
  }
  const result = computeFifo(lots, sales, defaults);
  cache = { at: Date.now(), version: dataVersion(), result, defaults };
  return { ...result, defaults };
}

/** Coût unitaire actuel d'un SKU : moyenne des lots restants, sinon dernier lot, sinon prix par défaut. */
export function currentUnitCost(sku: string, fifo = loadFifo()): number | null {
  const lots = fifo.lots.get(sku) ?? [];
  const remaining = lots.filter((l) => l.remaining > 0 && l.unitCost !== null);
  const units = remaining.reduce((s, l) => s + l.remaining, 0);
  if (units > 0) return remaining.reduce((s, l) => s + l.remaining * (l.unitCost as number), 0) / units;
  const lastKnown = lots.filter((l) => l.unitCost !== null).pop();
  if (lastKnown) return lastKnown.unitCost;
  return fifo.defaults.get(sku) ?? null;
}
