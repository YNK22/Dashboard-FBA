"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtEur, fmtInt } from "./format";

interface LotRow {
  id: string;
  sku: string;
  received_at: string;
  quantity: number;
  remaining: number;
  unit_cost: number | null;
  shipment_id: string | null;
  source: string;
  title: string | null;
  asin: string | null;
}

const SOURCE: Record<string, string> = { fba_shipment: "Envoi FBA", csv: "Import CSV", manual: "Saisie" };

/* ---------- Import CSV souple (en-têtes reconnus en français ou en anglais, y compris export Scorasin) ---------- */

const HEADERS: Record<string, string[]> = {
  sku: ["sku", "merchant_sku", "seller_sku", "sellersku"],
  date: ["date", "date_reception", "received_at", "reception", "date_achat", "purchase_date", "created_at"],
  quantity: ["quantite", "quantité", "qty", "quantity", "quantity_received", "quantite_recue", "unites", "units"],
  cost: ["cout_unitaire_ht", "cout", "coût", "cout_unitaire", "unit_cog_ht", "final_cog_ht", "unit_cost", "cog", "prix_achat_ht", "prix_achat"],
  shipment: ["envoi_fba", "envoi", "shipment_id", "amazon_shipment_id", "fba_shipment_id"],
  included: ["included_in_fifo"],
  qtyExpected: ["quantity_expected"],
};

function parseNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim().replace(/\s|€/g, "").replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

function parseDate(v: string | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  const fr = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/); // 21/04/2026
  if (fr) return new Date(Date.UTC(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]), 12)).toISOString();
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseLotsCsv(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { lots: [], skipped: 0 };
  const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ";" : lines[0].includes("\t") ? "\t" : ",";
  const split = (l: string) => l.split(sep).map((c) => c.replace(/^"|"$/g, "").trim());
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const idx = (k: keyof typeof HEADERS) => head.findIndex((h) => HEADERS[k].includes(h));
  const hasHeader = idx("sku") >= 0;
  const col = hasHeader
    ? { sku: idx("sku"), date: idx("date"), quantity: idx("quantity"), cost: idx("cost"), shipment: idx("shipment"), included: idx("included"), qtyExpected: idx("qtyExpected") }
    : { sku: 0, date: 1, quantity: 2, cost: 3, shipment: 4, included: -1, qtyExpected: -1 };
  let skipped = 0;
  const lots = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const c = split(line);
    if (col.included >= 0 && /^(false|0|non)$/i.test(c[col.included] ?? "")) {
      skipped++; // lot exclu du FIFO dans l'outil d'origine
      continue;
    }
    const qty = parseNumber(c[col.quantity]) || (col.qtyExpected >= 0 ? parseNumber(c[col.qtyExpected]) : null);
    const date = parseDate(c[col.date]);
    if (!c[col.sku] || !qty || !date) {
      skipped++;
      continue;
    }
    lots.push({
      sku: c[col.sku],
      received_at: date,
      quantity: qty,
      unit_cost: parseNumber(c[col.cost]),
      shipment_id: col.shipment >= 0 ? c[col.shipment] || null : null,
    });
  }
  return { lots, skipped };
}

export default function LotsPanel({ unit = "HT" }: { unit?: "HT" | "TTC" }) {
  const [rows, setRows] = useState<LotRow[]>([]);
  const [missing, setMissing] = useState(0);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(50);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ sku: "", date: new Date().toISOString().slice(0, 10), quantity: "", cost: "" });

  const load = useCallback(
    () =>
      fetch(`/api/lots${onlyMissing ? "?missing=1" : ""}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => {
          setRows(j.rows ?? []);
          setMissing(j.missing ?? 0);
        }),
    [onlyMissing],
  );
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    const body = Object.entries(edits).map(([id, v]) => ({ id, unit_cost: parseNumber(v) }));
    const res = await fetch("/api/lots", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setMsg(res.ok ? `${body.length} lot(s) enregistré(s).` : "Erreur lors de l'enregistrement.");
    setEdits({});
    load();
  };

  const post = async (lots: unknown[], source: "csv" | "manual") => {
    const res = await fetch("/api/lots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lots, source }) });
    return res.json() as Promise<{ imported: number; errors: string[] }>;
  };

  const importCsv = async (file: File) => {
    const { lots, skipped } = parseLotsCsv(await file.text());
    if (lots.length === 0) return setMsg("Aucun lot reconnu. Colonnes attendues : sku;date;quantite;cout_unitaire_ht;envoi_fba");
    const j = await post(lots, "csv");
    setMsg(`${j.imported} lot(s) importé(s) depuis ${file.name}${skipped ? `, ${skipped} ligne(s) ignorée(s)` : ""}.`);
    load();
  };

  const addLot = async (e: React.FormEvent) => {
    e.preventDefault();
    const j = await post([{ sku: form.sku, received_at: form.date, quantity: Number(form.quantity), unit_cost: parseNumber(form.cost) }], "manual");
    setMsg(j.imported ? "Lot ajouté." : j.errors.join(" "));
    if (j.imported) setForm({ ...form, sku: "", quantity: "", cost: "" });
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Supprimer ce lot ?")) return;
    await fetch(`/api/lots?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    load();
  };

  const shown = rows.filter((r) => !q || `${r.sku} ${r.asin} ${r.title} ${r.shipment_id}`.toLowerCase().includes(q.toLowerCase()));
  const value = (r: LotRow) => edits[r.id] ?? (r.unit_cost === null ? "" : String(r.unit_cost).replace(".", ","));

  return (
    <section className="panel" style={{ marginTop: 0 }}>
      <div className="panel-head">
        <h2 className="panel-title">Lots d&apos;achat (FIFO)</h2>
        <button className="btn btn-primary" onClick={save} disabled={Object.keys(edits).length === 0}>
          Enregistrer {Object.keys(edits).length > 0 ? `(${Object.keys(edits).length})` : ""}
        </button>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        Chaque vente consomme le lot le plus ancien de son SKU. Les lots sont créés automatiquement à partir de vos envois FBA : complétez leur coût unitaire {unit}
        tout compris (achat + prep + transport). Sans lot, le prix d&apos;achat par défaut ci-dessous est utilisé.
      </p>
      {missing > 0 && <div className="banner">⚠ {missing} lot(s) sans coût unitaire.</div>}
      {msg && <div className="banner">{msg}</div>}

      <div className="panel-head">
        <div className="chips" style={{ marginBottom: 0 }}>
          <button className="chip" aria-pressed={!onlyMissing} onClick={() => setOnlyMissing(false)}>
            Tous
          </button>
          <button className="chip" aria-pressed={onlyMissing} onClick={() => setOnlyMissing(true)}>
            Coût à compléter
          </button>
        </div>
        <div className="form-row">
          <input className="cell" style={{ width: 220, textAlign: "left" }} placeholder="SKU, ASIN, titre, envoi…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="btn" style={{ cursor: "pointer", color: "var(--text)" }}>
            ⬆ Importer des lots (CSV)
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importCsv(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>

      <div className="table-wrap">
        <table className="num">
          <thead>
            <tr>
              <th>Produit</th>
              <th>Entrée en stock</th>
              <th>Origine</th>
              <th>Quantité</th>
              <th>Restant</th>
              <th>Coût unit. {unit}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Aucun lot. Ils apparaissent après la synchronisation de vos envois FBA, ou par import CSV.
                </td>
              </tr>
            )}
            {shown.slice(0, limit).map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="title" title={r.title ?? ""}>
                    {r.title ?? r.sku}
                  </span>
                  <span className="sku">
                    {r.sku}
                    {r.asin ? ` · ${r.asin}` : ""}
                  </span>
                </td>
                <td>{new Date(r.received_at).toLocaleDateString("fr-FR")}</td>
                <td>
                  {SOURCE[r.source] ?? r.source}
                  {r.shipment_id && <span className="sku">{r.shipment_id}</span>}
                </td>
                <td>{fmtInt(r.quantity)}</td>
                <td>{fmtInt(r.remaining)}</td>
                <td>
                  <input
                    className={`cell${value(r) === "" ? " missing" : ""}`}
                    inputMode="decimal"
                    value={value(r)}
                    placeholder="à saisir"
                    onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })}
                    aria-label={`Coût unitaire du lot ${r.sku}`}
                  />
                  {r.unit_cost !== null && !edits[r.id] && <span className="sku">{fmtEur(r.unit_cost * r.remaining)} restant</span>}
                </td>
                <td>
                  <button className="more-btn" onClick={() => remove(r.id)} aria-label={`Supprimer le lot ${r.sku}`}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown.length > limit && (
        <div className="pager">
          <button className="btn" onClick={() => setLimit(limit + 100)}>
            Afficher plus ({fmtInt(shown.length - limit)} restants)
          </button>
        </div>
      )}

      <form className="form-row" style={{ marginTop: 14 }} onSubmit={addLot}>
        <label style={{ flex: 1, minWidth: 160 }}>
          SKU
          <input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} required />
        </label>
        <label>
          Entrée en stock
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
        </label>
        <label>
          Quantité
          <input inputMode="numeric" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required style={{ width: 90 }} />
        </label>
        <label>
          Coût unit. {unit}
          <input inputMode="decimal" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} style={{ width: 100 }} />
        </label>
        <button className="btn" type="submit">
          Ajouter un lot
        </button>
      </form>
      <p className="note">
        CSV : <code>sku;date;quantite;cout_unitaire_ht;envoi_fba</code> (ou les colonnes d&apos;un export Scorasin : <code>merchant_sku</code>,{" "}
        <code>received_at</code>, <code>quantity_received</code>, <code>unit_cog_ht</code>, <code>amazon_shipment_id</code>). Avec le n° d&apos;envoi FBA,
        le coût complète le lot créé automatiquement, sans doublon.
      </p>
    </section>
  );
}
