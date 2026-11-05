import { NextResponse, type NextRequest } from "next/server";
import { bumpDataVersion, getDb } from "@/lib/db";
import { loadFifo } from "@/lib/fifo";

export const dynamic = "force-dynamic";

interface ItemRow {
  order_item_id: string;
  sku: string;
  quantity: number;
  purchase_date: string;
  unit_price_ttc: number | null;
  title: string | null;
  asin: string | null;
}

/**
 * Produits vendus dont le coût d'achat est inconnu (lot sans coût et pas de prix par défaut),
 * avec le nombre d'unités concernées : ce qu'il faut compléter pour un bénéfice exact.
 */
export function GET() {
  const fifo = loadFifo();
  const db = getDb();
  const items = db
    .prepare(
      `SELECT oi.order_item_id, oi.sku, oi.quantity, o.purchase_date, oi.unit_price_ttc, COALESCE(oi.title, p.title) AS title, COALESCE(oi.asin, p.asin) AS asin
       FROM order_items oi JOIN orders o ON o.order_id = oi.order_id LEFT JOIN products p ON p.sku = oi.sku
       WHERE o.status != 'CANCELLED' AND oi.sku IS NOT NULL AND oi.quantity > 0
       ORDER BY o.purchase_date`,
    )
    .all() as ItemRow[];

  const bySku = new Map<
    string,
    { sku: string; title: string | null; asin: string | null; units: number; lastSale: string; lastPrice: number | null }
  >();
  for (const it of items) {
    if (fifo.costs.get(it.order_item_id)?.source !== "missing") continue;
    const r = bySku.get(it.sku) ?? { sku: it.sku, title: it.title, asin: it.asin, units: 0, lastSale: it.purchase_date, lastPrice: null };
    r.units += it.quantity;
    r.lastSale = it.purchase_date;
    if (it.unit_price_ttc) r.lastPrice = it.unit_price_ttc;
    bySku.set(it.sku, r);
  }

  const lotStmt = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS q FROM lots WHERE sku = ? AND unit_cost IS NULL");
  const rows = [...bySku.values()]
    .map((r) => {
      const l = lotStmt.get(r.sku) as { n: number; q: number };
      return { ...r, lotsWithoutCost: l.n, unitsInLots: l.q };
    })
    .sort((a, b) => b.units - a.units || a.sku.localeCompare(b.sku));
  return NextResponse.json({ rows, units: rows.reduce((s, r) => s + r.units, 0) });
}

/**
 * Enregistre un coût d'achat unitaire par produit : body = [{ sku, unit_cost }].
 * Complète tous les lots de ce SKU encore sans coût, et sert de prix par défaut s'il n'y en a pas
 * (ventes non couvertes par un lot). Les lots qui ont déjà un coût ne sont pas modifiés.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { sku: string; unit_cost: number | string | null }[] | null;
  if (!Array.isArray(body)) return NextResponse.json({ error: "Tableau attendu" }, { status: 400 });
  const db = getDb();
  const now = new Date().toISOString();
  const updLots = db.prepare("UPDATE lots SET unit_cost = ?, updated_at = ? WHERE sku = ? AND unit_cost IS NULL");
  const setDefault = db.prepare(`
    INSERT INTO products(sku, cogs, extra_cost, updated_at) VALUES(?, ?, 0, ?)
    ON CONFLICT(sku) DO UPDATE SET cogs = COALESCE(products.cogs, excluded.cogs), updated_at = excluded.updated_at`);
  const errors: string[] = [];
  let saved = 0;
  db.transaction(() => {
    for (const r of body) {
      const cost = Number(String(r.unit_cost ?? "").replace(",", ".").replace(/\s|€/g, ""));
      if (!r.sku || String(r.unit_cost ?? "").trim() === "" || !Number.isFinite(cost) || cost < 0) {
        errors.push(`${r.sku || "?"} : montant invalide`);
        continue;
      }
      updLots.run(cost, now, r.sku);
      setDefault.run(r.sku, cost, now);
      saved++;
    }
  })();
  bumpDataVersion();
  return NextResponse.json({ ok: errors.length === 0, saved, errors });
}
