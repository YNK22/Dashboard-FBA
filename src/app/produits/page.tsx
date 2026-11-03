"use client";

import { useEffect, useState } from "react";
import { fmtEur, fmtInt } from "@/components/format";

interface Row {
  sku: string;
  asin: string | null;
  title: string | null;
  cogs: number | null;
  extra_cost: number | null;
  last_price: number | null;
  units_30d: number;
}

export default function ProduitsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [edits, setEdits] = useState<Record<string, { cogs: string; extra: string }>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = () =>
    fetch("/api/cogs", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setRows(j.rows ?? []));

  useEffect(() => {
    load();
  }, []);

  const value = (r: Row, field: "cogs" | "extra") =>
    edits[r.sku]?.[field] ?? (field === "cogs" ? (r.cogs ?? "") : (r.extra_cost ?? "")).toString().replace(".", ",");

  const setField = (r: Row, field: "cogs" | "extra", v: string) =>
    setEdits((e) => ({ ...e, [r.sku]: { ...(e[r.sku] ?? { cogs: value(r, "cogs"), extra: value(r, "extra") }), [field]: v } }));

  const save = async () => {
    const parse = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".").replace(/\s/g, "")));
    const body = Object.entries(edits).map(([sku, e]) => ({ sku, cogs: parse(e.cogs), extra_cost: parse(e.extra) ?? 0 }));
    if (body.some((b) => b.cogs !== null && Number.isNaN(b.cogs))) return setMsg("Un montant n'est pas valide.");
    const res = await fetch("/api/cogs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setMsg(res.ok ? `${body.length} produit(s) enregistré(s).` : "Erreur lors de l'enregistrement.");
    setEdits({});
    load();
  };

  const missing = rows.filter((r) => r.cogs === null).length;
  const shown = rows.filter((r) => !filter || `${r.sku} ${r.asin} ${r.title}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Produits & coûts</h1>
          <div className="page-sub">
            Prix d&apos;achat unitaire {""}
            <strong>HT</strong> (TTC si vous n&apos;êtes pas assujetti à la TVA) + coûts annexes par unité (prep, envoi vers Amazon…).
          </div>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={Object.keys(edits).length === 0}>
          Enregistrer {Object.keys(edits).length > 0 ? `(${Object.keys(edits).length})` : ""}
        </button>
      </div>

      {missing > 0 && <div className="banner">⚠ {missing} produit(s) sans prix d&apos;achat : leur bénéfice et leur ROI sont surestimés.</div>}
      {msg && <div className="banner">{msg}</div>}

      <section className="panel">
        <div className="panel-head">
          <input className="cell" style={{ width: 260, textAlign: "left" }} placeholder="Rechercher SKU, ASIN, titre…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="note">
            Import en masse : <code>npm run import-cogs -- fichier.csv</code> (colonnes <code>sku;prix_achat;cout_annexe</code>)
          </span>
        </div>
        <div className="table-wrap">
          <table className="num">
            <thead>
              <tr>
                <th>Produit</th>
                <th>Ventes 30 j</th>
                <th>Dernier prix TTC</th>
                <th>Prix d&apos;achat</th>
                <th>Coût annexe / u.</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    Aucun produit pour l&apos;instant : ils apparaissent automatiquement après la première synchronisation.
                  </td>
                </tr>
              )}
              {shown.map((r) => (
                <tr key={r.sku}>
                  <td>
                    <span className="title" title={r.title ?? ""}>
                      {r.title ?? r.sku}
                    </span>
                    <span className="sku">
                      {r.sku}
                      {r.asin ? ` · ${r.asin}` : ""}
                    </span>
                  </td>
                  <td>{fmtInt(r.units_30d)}</td>
                  <td>{r.last_price ? fmtEur(r.last_price) : "—"}</td>
                  <td>
                    <input
                      className={`cell${value(r, "cogs") === "" ? " missing" : ""}`}
                      inputMode="decimal"
                      value={value(r, "cogs")}
                      placeholder="à saisir"
                      onChange={(e) => setField(r, "cogs", e.target.value)}
                      aria-label={`Prix d'achat ${r.sku}`}
                    />
                  </td>
                  <td>
                    <input
                      className="cell"
                      inputMode="decimal"
                      value={value(r, "extra")}
                      placeholder="0"
                      onChange={(e) => setField(r, "extra", e.target.value)}
                      aria-label={`Coût annexe ${r.sku}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
