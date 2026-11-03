"use client";

import { useEffect, useState } from "react";
import type { OrderRowView } from "@/lib/queries";
import { fmtEur, fmtInt, fmtPct, signClass } from "@/components/format";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "En attente",
  PENDING_AVAILABILITY: "Précommande",
  UNSHIPPED: "À expédier",
  PARTIALLY_SHIPPED: "Expédiée en partie",
  SHIPPED: "Expédiée",
  UNFULFILLABLE: "Non traitable",
};

interface Resp {
  rows: OrderRowView[];
  total: number;
  totals: { salesTtc: number; profit: number; orders: number };
}

export default function CommandesPage() {
  const today = new Date();
  const [from, setFrom] = useState(ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)));
  const [to, setTo] = useState(ymd(today));
  const [mkt, setMkt] = useState<string | null>(null);
  const [markets, setMarkets] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [loss, setLoss] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [ready, setReady] = useState(false);

  // Paramètres d'URL (lien depuis le dashboard)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("from")) setFrom(p.get("from")!);
    if (p.get("to")) setTo(p.get("to")!);
    if (p.get("mkt")) setMkt(p.get("mkt"));
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setMarkets((s.marketplaces as string[]).map((m) => m.slice(0, 2))));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const qs = new URLSearchParams({ from, to, page: String(page) });
    if (mkt) qs.set("mkt", mkt);
    if (q) qs.set("q", q);
    if (loss) qs.set("loss", "1");
    const t = setTimeout(() => {
      fetch(`/api/orders?${qs}`, { cache: "no-store" })
        .then((r) => r.json())
        .then(setData);
    }, 200);
    return () => clearTimeout(t);
  }, [from, to, mkt, q, loss, page, ready]);

  const preset = (days: number) => {
    setFrom(ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1)));
    setTo(ymd(today));
    setPage(1);
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / 100)) : 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Commandes</h1>
          <div className="page-sub">Chaque commande avec son bénéfice : CA, frais Amazon (réels ou estimés), coût d&apos;achat FIFO.</div>
        </div>
      </div>

      <section className="panel" style={{ marginTop: 0 }}>
        <div className="form-row">
          <label>
            Du
            <input type="date" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />
          </label>
          <label>
            Au
            <input type="date" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />
          </label>
          <div className="segmented">
            <button onClick={() => preset(1)}>Auj.</button>
            <button onClick={() => preset(7)}>7 j</button>
            <button onClick={() => preset(30)}>30 j</button>
          </div>
          <label style={{ flex: 1, minWidth: 160 }}>
            Recherche
            <input value={q} placeholder="n° de commande, SKU, ASIN, titre…" onChange={(e) => (setQ(e.target.value), setPage(1))} />
          </label>
          <label style={{ flexDirection: "row", display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
            <input type="checkbox" checked={loss} onChange={(e) => (setLoss(e.target.checked), setPage(1))} /> À perte uniquement
          </label>
        </div>
        {markets.length > 1 && (
          <div className="chips" style={{ marginTop: 12, marginBottom: 0 }}>
            {[null, ...markets].map((m) => (
              <button key={m ?? "all"} className="chip" aria-pressed={mkt === m} onClick={() => (setMkt(m), setPage(1))}>
                {m ?? "Tous les pays"}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        {data && (
          <div className="chart-total num">
            {fmtInt(data.totals.orders)} commandes · {fmtEur(data.totals.salesTtc)} TTC · bénéfice{" "}
            <span className={signClass(data.totals.profit)}>{fmtEur(data.totals.profit)}</span>
            <span className="muted"> (hors remboursements et coûts divers)</span>
          </div>
        )}
        <div className="table-wrap">
          <table className="num">
            <thead>
              <tr>
                <th>Commande</th>
                <th>Pays</th>
                <th>Statut</th>
                <th>Unités</th>
                <th>CA TTC</th>
                <th>Frais Amazon</th>
                <th>Coût d&apos;achat</th>
                <th>Bénéfice</th>
                <th>Marge</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">
                    Aucune commande.
                  </td>
                </tr>
              )}
              {data?.rows.map((r) => (
                <tr key={r.orderId}>
                  <td>
                    <span className="title" title={r.items.map((i) => i.title).join(" + ")}>
                      {r.items.map((i) => `${i.quantity > 1 ? `${i.quantity}× ` : ""}${i.title ?? i.sku}`).join(" + ")}
                    </span>
                    <span className="sku">
                      {new Date(r.date).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} · {r.orderId}
                    </span>
                  </td>
                  <td>{r.country ?? "—"}</td>
                  <td>
                    <span className={`status ${r.refunded ? "loss" : r.status === "SHIPPED" ? "neutral" : "estimated"}`}>
                      {r.refunded ? "Remboursée" : (STATUS_LABEL[r.status] ?? r.status)}
                    </span>
                  </td>
                  <td>{fmtInt(r.units)}</td>
                  <td>{fmtEur(r.salesTtc)}</td>
                  <td>
                    {fmtEur(r.fees)}
                    {r.feesEstimated && (
                      <span className="muted" title="Frais estimés : Amazon n'a pas encore réglé cette commande">
                        {" "}
                        ~
                      </span>
                    )}
                  </td>
                  <td>{r.cogs === null ? <a href="/produits" className="warn-text">⚠ à saisir</a> : fmtEur(r.cogs)}</td>
                  <td className={r.profit === null ? "" : signClass(r.profit)}>{r.profit === null ? "—" : fmtEur(r.profit)}</td>
                  <td>{fmtPct(r.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="pager">
            <button className="icon-btn" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Page précédente">
              ‹
            </button>
            <span className="note">
              Page {page} / {pages}
            </span>
            <button className="icon-btn" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Page suivante">
              ›
            </button>
          </div>
        )}
        <div className="note" style={{ marginTop: 8 }}>
          ~ = frais estimés (commande pas encore réglée par Amazon).
        </div>
      </section>
    </>
  );
}
