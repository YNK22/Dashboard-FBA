import { NextResponse, type NextRequest } from "next/server";
import { bumpDataVersion, getDb } from "@/lib/db";
import { loadFifo } from "@/lib/fifo";

export const dynamic = "force-dynamic";

interface LotRow {
  id: string;
  sku: string;
  received_at: string;
  quantity: number;
  unit_cost: number | null;
  shipment_id: string | null;
  source: string;
  note: string | null;
  title: string | null;
  asin: string | null;
}

/** Liste des lots avec les unités restantes (FIFO). ?missing=1 : seulement les lots sans coût. */
export function GET(req: NextRequest) {
  const onlyMissing = req.nextUrl.searchParams.get("missing") === "1";
  const rows = getDb()
    .prepare(
      `SELECT l.*, p.title, p.asin FROM lots l LEFT JOIN products p ON p.sku = l.sku
       ${onlyMissing ? "WHERE l.unit_cost IS NULL" : ""}
       ORDER BY l.received_at DESC, l.sku LIMIT 2000`,
    )
    .all() as LotRow[];
  const fifo = loadFifo();
  const remaining = new Map<string, number>();
  for (const lots of fifo.lots.values()) for (const l of lots) remaining.set(l.id, l.remaining);
  const missing = (getDb().prepare("SELECT COUNT(*) AS n FROM lots WHERE unit_cost IS NULL").get() as { n: number }).n;
  return NextResponse.json({ rows: rows.map((r) => ({ ...r, remaining: remaining.get(r.id) ?? r.quantity })), missing });
}

interface LotInput {
  id?: string;
  sku: string;
  received_at: string; // YYYY-MM-DD ou ISO
  quantity: number;
  unit_cost: number | null;
  shipment_id?: string | null;
  note?: string | null;
}

/**
 * Création / import de lots : body = { lots: LotInput[], source?: "csv" | "manual" }.
 * Si un envoi FBA est indiqué, le lot est fusionné avec le lot créé automatiquement
 * depuis Amazon (même identifiant « envoi|sku ») : son coût est complété.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { lots?: LotInput[]; source?: string };
  const lots = Array.isArray(body.lots) ? body.lots : [];
  const source = body.source === "manual" ? "manual" : "csv";
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO lots(id, sku, received_at, quantity, unit_cost, shipment_id, source, note, updated_at)
    VALUES(@id, @sku, @received_at, @quantity, @unit_cost, @shipment_id, @source, @note, @updated_at)
    ON CONFLICT(id) DO UPDATE SET unit_cost = excluded.unit_cost,
      received_at = excluded.received_at, note = COALESCE(excluded.note, lots.note), updated_at = excluded.updated_at,
      quantity = CASE WHEN lots.source = 'fba_shipment' THEN lots.quantity ELSE excluded.quantity END`);
  const now = new Date().toISOString();
  let n = 0;
  const errors: string[] = [];
  db.transaction(() => {
    lots.forEach((l, i) => {
      const date = new Date(l.received_at);
      const qty = Math.round(Number(l.quantity));
      const cost = l.unit_cost === null || l.unit_cost === undefined || String(l.unit_cost) === "" ? null : Number(l.unit_cost);
      if (!l.sku || Number.isNaN(date.getTime()) || !(qty > 0) || (cost !== null && Number.isNaN(cost))) {
        errors.push(`ligne ${i + 1} ignorée (sku, date, quantité ou coût invalide)`);
        return;
      }
      const iso = date.toISOString();
      const id = l.id || (l.shipment_id ? `${l.shipment_id}|${l.sku}` : `${source}|${l.sku}|${iso.slice(0, 10)}|${qty}|${cost ?? ""}`);
      upsert.run({ id, sku: l.sku.trim(), received_at: iso, quantity: qty, unit_cost: cost, shipment_id: l.shipment_id || null, source, note: l.note ?? null, updated_at: now });
      n++;
    });
  })();
  bumpDataVersion();
  return NextResponse.json({ ok: true, imported: n, errors: errors.slice(0, 20) });
}

/** Mise à jour des coûts : body = [{ id, unit_cost }] */
export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { id: string; unit_cost: number | null }[];
  if (!Array.isArray(body)) return NextResponse.json({ error: "Tableau attendu" }, { status: 400 });
  const db = getDb();
  const stmt = db.prepare("UPDATE lots SET unit_cost = ?, updated_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const r of body) {
      const cost = r.unit_cost === null || Number.isNaN(Number(r.unit_cost)) ? null : Number(r.unit_cost);
      stmt.run(cost, now, r.id);
    }
  })();
  bumpDataVersion();
  return NextResponse.json({ ok: true, updated: body.length });
}

/** Suppression d'un lot (?id=...). Un lot issu d'un envoi FBA sera recréé à la prochaine synchro. */
export function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });
  getDb().prepare("DELETE FROM lots WHERE id = ?").run(id);
  bumpDataVersion();
  return NextResponse.json({ ok: true });
}
