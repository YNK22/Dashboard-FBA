"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Card, ChartPoint, ProductRow } from "@/lib/queries";
import BarChart from "./BarChart";
import PeriodCard from "./PeriodCard";
import { fmtEur, fmtInt, fmtPct, signClass } from "./format";

interface DashboardData {
  generatedAt: string;
  cards: Card[];
  demo: boolean;
  connected: boolean;
  vatRegistered: boolean;
  marketplaces: string[];
  sync: { running: boolean; lastOkAt: string | null; lastError: string | null };
}

const TAB_LABELS: Record<Card["key"], string> = {
  today: "Aujourd'hui",
  yesterday: "Hier",
  month: "Mois",
  lastMonth: "M-1",
  forecast: "Prévi.",
};

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—");

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Card["key"]>("today");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(`Impossible de charger les données (${(e as Error).message})`);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000); // rafraîchit l'écran chaque minute
    return () => clearInterval(id);
  }, [load]);

  const syncNow = async () => {
    const res = await fetch("/api/sync", { method: "POST" });
    const body = await res.json();
    if (!res.ok) setError(body.error);
    else {
      setData((d) => (d ? { ...d, sync: { ...d.sync, running: true } } : d));
      const poll = setInterval(async () => {
        const st = await (await fetch("/api/sync", { cache: "no-store" })).json();
        if (!st.running) {
          clearInterval(poll);
          load();
        }
      }, 4000);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="page-sub">
            Ventes et rentabilité, {data?.marketplaces.length ? data.marketplaces.join(" · ") : "toutes marketplaces"} · à jour{" "}
            {time(data?.sync.lastOkAt ?? null)}
          </div>
        </div>
        {data?.connected && !data.demo && (
          <button className="btn" onClick={syncNow} disabled={data.sync.running}>
            {data.sync.running ? "Synchronisation…" : "↻ Synchroniser"}
          </button>
        )}
      </div>

      {data?.demo && (
        <div className="banner">
          <strong>Données de démonstration.</strong> Pour afficher vos vraies ventes : suivez le guide{" "}
          <code>docs/GUIDE-CONNEXION-AMAZON.md</code>, puis <code>npm run demo -- --clear</code> et <code>npm run sync</code>.
        </div>
      )}
      {data && !data.demo && !data.connected && (
        <div className="banner">
          <strong>Amazon n&apos;est pas encore connecté.</strong> Renseignez vos identifiants SP-API dans le fichier <code>.env</code> (voir{" "}
          <code>docs/GUIDE-CONNEXION-AMAZON.md</code>), ou lancez <code>npm run demo</code> pour tester avec des données fictives.
        </div>
      )}
      {(error || data?.sync.lastError) && <div className="banner error">⚠ {error ?? `Dernière synchro en erreur : ${data?.sync.lastError}`}</div>}

      <div className="segmented mobile-tabs" role="tablist">
        {(Object.keys(TAB_LABELS) as Card["key"][]).map((k) => (
          <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {TAB_LABELS[k]}
          </button>
        ))}
      </div>

      <div className="cards">
        {data
          ? data.cards.map((c) => <PeriodCard key={c.key} card={c} active={tab === c.key} vatRegistered={data.vatRegistered} />)
          : !error && <div className="muted">Chargement…</div>}
      </div>

      <ChartPanel refreshKey={data?.generatedAt} />
      <ProductsPanel refreshKey={data?.generatedAt} />
    </>
  );
}

/* ---------------- Graphique Mois / Année ---------------- */

function ChartPanel({ refreshKey }: { refreshKey?: string }) {
  const now = new Date();
  const [mode, setMode] = useState<"month" | "year">("month");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [metric, setMetric] = useState<"salesTtc" | "netProfit">("salesTtc");
  const [points, setPoints] = useState<ChartPoint[]>([]);

  useEffect(() => {
    const qs = mode === "month" ? `year=${year}&month=${month}` : `year=${year}`;
    fetch(`/api/chart?${qs}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setPoints(j.points ?? []))
      .catch(() => setPoints([]));
  }, [mode, year, month, refreshKey]);

  const shift = (delta: number) => {
    if (mode === "year") return setYear((y) => y + delta);
    let m = month + delta;
    let y = year;
    if (m < 1) {
      m = 12;
      y--;
    } else if (m > 12) {
      m = 1;
      y++;
    }
    setMonth(m);
    setYear(y);
  };

  const totals = useMemo(
    () => points.reduce((a, p) => ({ sales: a.sales + p.salesTtc, profit: a.profit + p.netProfit, orders: a.orders + p.orders }), { sales: 0, profit: 0, orders: 0 }),
    [points],
  );
  const title = mode === "month" ? `${MONTHS[month - 1]} ${year}` : String(year);

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="segmented">
          <button aria-pressed={mode === "month"} onClick={() => setMode("month")}>
            Mois
          </button>
          <button aria-pressed={mode === "year"} onClick={() => setMode("year")}>
            Année
          </button>
        </div>
        <div className="chart-nav">
          <button className="icon-btn" onClick={() => shift(-1)} aria-label="Période précédente">
            ‹
          </button>
          <span className="chart-title">Évolution · {title}</span>
          <button className="icon-btn" onClick={() => shift(1)} aria-label="Période suivante">
            ›
          </button>
        </div>
        <div className="segmented">
          <button aria-pressed={metric === "salesTtc"} onClick={() => setMetric("salesTtc")}>
            CA TTC
          </button>
          <button aria-pressed={metric === "netProfit"} onClick={() => setMetric("netProfit")}>
            Bénéfice net
          </button>
        </div>
      </div>
      <div className="chart-total num">
        {metric === "salesTtc" ? "CA TTC" : "Bénéfice net"} {mode === "month" ? "par jour" : "par mois"} · total {fmtEur(totals.sales)} TTC ·{" "}
        <span className={signClass(totals.profit)}>{fmtEur(totals.profit)}</span> de bénéfice · {fmtInt(totals.orders)} commandes
      </div>
      <BarChart
        points={points}
        metric={metric}
        longLabel={(p) => (mode === "month" ? `${Number(p.key.slice(8))} ${MONTHS[month - 1]}` : `${MONTHS[Number(p.key.slice(5)) - 1]} ${year}`)}
      />
    </section>
  );
}

/* ---------------- Rentabilité par produit ---------------- */

type RangeKey = "today" | "yesterday" | "7d" | "month" | "lastMonth" | "30d" | "90d";

function rangeFor(key: RangeKey): { from: string; to: string } {
  const now = new Date();
  const d = (offset: number) => ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  switch (key) {
    case "today":
      return { from: d(0), to: d(0) };
    case "yesterday":
      return { from: d(-1), to: d(-1) };
    case "7d":
      return { from: d(-6), to: d(0) };
    case "30d":
      return { from: d(-29), to: d(0) };
    case "90d":
      return { from: d(-89), to: d(0) };
    case "month":
      return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: d(0) };
    case "lastMonth":
      return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
  }
}

function ProductsPanel({ refreshKey }: { refreshKey?: string }) {
  const [range, setRange] = useState<RangeKey>("month");
  const [rows, setRows] = useState<ProductRow[]>([]);

  useEffect(() => {
    const { from, to } = rangeFor(range);
    fetch(`/api/products?from=${from}&to=${to}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setRows(j.rows ?? []))
      .catch(() => setRows([]));
  }, [range, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Rentabilité par produit</h2>
        <select className="btn" value={range} onChange={(e) => setRange(e.target.value as RangeKey)} aria-label="Période">
          <option value="today">Aujourd&apos;hui</option>
          <option value="yesterday">Hier</option>
          <option value="7d">7 derniers jours</option>
          <option value="month">Ce mois</option>
          <option value="lastMonth">Mois dernier</option>
          <option value="30d">30 derniers jours</option>
          <option value="90d">90 derniers jours</option>
        </select>
      </div>
      <div className="table-wrap">
        <table className="num">
          <thead>
            <tr>
              <th>Produit</th>
              <th>Unités</th>
              <th>CA TTC</th>
              <th>Frais Amazon</th>
              <th>Coût d&apos;achat</th>
              <th>Rembours.</th>
              <th>Bénéfice net</th>
              <th>Marge</th>
              <th>ROI</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  Aucune vente sur la période.
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
                <td>{fmtInt(r.units)}</td>
                <td>{fmtEur(r.salesTtc)}</td>
                <td>{fmtEur(r.amazonFees)}</td>
                <td>{r.cogsMissing ? <a href="/produits" className="warn-text">⚠ à saisir</a> : fmtEur(r.cogs)}</td>
                <td>{fmtInt(r.refunds)}</td>
                <td className={signClass(r.netProfit)}>{fmtEur(r.netProfit)}</td>
                <td>{fmtPct(r.margin)}</td>
                <td>{fmtPct(r.roi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
