"use client";

import { useEffect, useMemo, useState } from "react";
import type { StockOverview, StockStatus } from "@/lib/stock";
import { fmtEur, fmtEur0, fmtInt } from "@/components/format";

const STATUS: Record<StockStatus, string> = {
  rupture: "Rupture",
  reassort: "À réassortir",
  surstock: "Surstock",
  dormant: "Dormant",
  ok: "OK",
  inactif: "Inactif",
};

type Resp = StockOverview & { settings: { reorderDays: number; targetStockDays: number; overstockDays: number; marketplace: string } };

export default function StockPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [filter, setFilter] = useState<StockStatus | "all" | "active">("active");
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch("/api/stock", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData);
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter(
      (r) =>
        (filter === "all" || (filter === "active" ? r.status !== "inactif" : r.status === filter)) &&
        (!q || `${r.sku} ${r.asin} ${r.title}`.toLowerCase().includes(q.toLowerCase())),
    );
  }, [data, filter, q]);

  const t = data?.totals;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Stock & réassort</h1>
          <div className="page-sub">
            Stock FBA {data?.settings.marketplace ? `(${data.settings.marketplace}, stock européen mutualisé)` : ""} · mis à jour{" "}
            {data?.updatedAt ? new Date(data.updatedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—"}
          </div>
        </div>
      </div>

      {data && data.rows.length === 0 && (
        <div className="banner">
          Pas encore de données de stock : elles arrivent à la prochaine synchronisation (rôle « Expédition par Amazon » requis, voir la page Amazon en cas d’erreur).
        </div>
      )}

      {t && (
        <div className="tiles">
          <div className="tile">
            <div className="label">Valeur du stock (coût d&apos;achat HT)</div>
            <div className="value num">{fmtEur0(t.value)}</div>
            {t.valueMissingSkus > 0 && <div className="note warn-text">⚠ {t.valueMissingSkus} SKU sans coût</div>}
          </div>
          <div className="tile">
            <div className="label">Unités vendables</div>
            <div className="value num">{fmtInt(t.units)}</div>
            <div className="note">{fmtInt(t.skus)} SKU en stock</div>
          </div>
          <div className="tile">
            <div className="label">Unités entrantes</div>
            <div className="value num">{fmtInt(t.inboundUnits)}</div>
            {t.unfulfillableUnits > 0 && <div className="note">{fmtInt(t.unfulfillableUnits)} invendables</div>}
          </div>
          <button className="tile" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setFilter("rupture")}>
            <div className="label">En rupture</div>
            <div className="value num neg">{fmtInt(t.rupture)}</div>
            <div className="note">SKU vendus ces 90 j, sans stock</div>
          </button>
          <button className="tile" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setFilter("reassort")}>
            <div className="label">À réassortir</div>
            <div className="value num warn-text">{fmtInt(t.reassort)}</div>
            <div className="note">moins de {data?.settings.reorderDays} j de stock</div>
          </button>
          <button className="tile" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setFilter("surstock")}>
            <div className="label">Surstock / dormant</div>
            <div className="value num">
              {fmtInt(t.surstock)} / {fmtInt(t.dormant)}
            </div>
            <div className="note">plus de {data?.settings.overstockDays} j / aucune vente 90 j</div>
          </button>
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <div className="chips" style={{ marginBottom: 0 }}>
            {(["active", "rupture", "reassort", "ok", "surstock", "dormant", "all"] as const).map((f) => (
              <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === "active" ? "Actifs" : f === "all" ? "Tous" : STATUS[f]}
              </button>
            ))}
          </div>
          <input className="cell" style={{ width: 240, textAlign: "left" }} placeholder="Rechercher SKU, ASIN, titre…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table className="num">
            <thead>
              <tr>
                <th>Produit</th>
                <th>Statut</th>
                <th>Vendable</th>
                <th>Entrant</th>
                <th>Ventes 7 j / 30 j</th>
                <th>Jours de stock</th>
                <th>Rupture le</th>
                <th>À commander</th>
                <th>Coût unit.</th>
                <th>Valeur</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="muted">
                    Aucun produit.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
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
                  <td>
                    <span className={`status ${r.status}`}>{STATUS[r.status]}</span>
                  </td>
                  <td>{fmtInt(r.sellable)}</td>
                  <td>{r.inbound ? fmtInt(r.inbound) : "—"}</td>
                  <td>
                    {fmtInt(r.sold7)} / {fmtInt(r.sold30)}
                  </td>
                  <td>
                    {r.daysOfStock === null ? "—" : `${fmtInt(r.daysOfStock)} j`}
                    {r.inbound > 0 && r.daysWithInbound !== null && <span className="sku">{fmtInt(r.daysWithInbound)} j avec entrant</span>}
                  </td>
                  <td>{r.stockoutDate && r.sellable > 0 ? new Date(`${r.stockoutDate}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : "—"}</td>
                  <td>{r.reorderQty > 0 ? <strong>{fmtInt(r.reorderQty)}</strong> : "—"}</td>
                  <td>{r.unitCost === null ? <a href="/produits" className="warn-text">⚠</a> : fmtEur(r.unitCost)}</td>
                  <td>{r.stockValue === null ? "—" : fmtEur(r.stockValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && (
          <div className="note" style={{ marginTop: 10 }}>
            Jours de stock = stock vendable ÷ ventes moyennes des 30 derniers jours. « À commander » vise {data.settings.targetStockDays} jours de couverture
            (stock + entrant). Réglages : REORDER_DAYS, TARGET_STOCK_DAYS, OVERSTOCK_DAYS.
          </div>
        )}
      </section>
    </>
  );
}
