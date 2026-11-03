import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liste des produits avec leur prix d'achat et quelques stats de vente. */
export function GET() {
  const rows = getDb()
    .prepare(
      `SELECT p.sku, p.asin, p.title, p.cogs, p.extra_cost,
              (SELECT oi.unit_price_ttc FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                WHERE oi.sku = p.sku AND oi.price_estimated = 0 ORDER BY o.purchase_date DESC LIMIT 1) AS last_price,
              (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                WHERE oi.sku = p.sku AND o.status != 'CANCELLED' AND o.purchase_date >= ?) AS units_30d
       FROM products p ORDER BY units_30d DESC, p.sku`,
    )
    .all(new Date(Date.now() - 30 * 86_400_000).toISOString());
  return NextResponse.json({ rows });
}

/** Met à jour le prix d'achat : body = [{ sku, cogs, extra_cost }] */
export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { sku: string; cogs: number | null; extra_cost?: number | null }[];
  if (!Array.isArray(body)) return NextResponse.json({ error: "Tableau attendu" }, { status: 400 });
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO products(sku, cogs, extra_cost, updated_at) VALUES(?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET cogs = excluded.cogs, extra_cost = excluded.extra_cost, updated_at = excluded.updated_at`);
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const r of body) {
      if (!r.sku) continue;
      const cogs = r.cogs === null || r.cogs === undefined || Number.isNaN(Number(r.cogs)) ? null : Number(r.cogs);
      stmt.run(r.sku, cogs, Number(r.extra_cost) || 0, now);
    }
  })();
  return NextResponse.json({ ok: true, updated: body.length });
}
