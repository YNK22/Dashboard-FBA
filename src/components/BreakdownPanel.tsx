"use client";

import { useEffect, useState } from "react";
import type { ProfitBreakdown } from "@/lib/queries";
import { fmtEur, fmtInt, fmtPct, signClass } from "./format";

type Preset = "month" | "lastMonth" | "30d" | "90d" | "year" | "all" | "custom";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function presetRange(p: Exclude<Preset, "custom">): { from: string; to: string } {
  const now = new Date();
  const today = ymd(now);
  switch (p) {
    case "month":
      return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case "lastMonth":
      return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case "30d":
      return { from: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), to: today };
    case "90d":
      return { from: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89)), to: today };
    case "year":
      return { from: `${now.getFullYear()}-01-01`, to: today };
    case "all":
      return { from: "2015-01-01", to: today };
  }
}

/** Détail du bénéfice net, frais par frais, sur une période au choix. */
export default function BreakdownPanel({ refreshKey, mkt }: { refreshKey?: string; mkt: string | null }) {
  const [preset, setPreset] = useState<Preset>("all");
  const [custom, setCustom] = useState(() => presetRange("month"));
  const [data, setData] = useState<ProfitBreakdown | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ fees: true, other: true });

  const { from, to } = preset === "custom" ? custom : presetRange(preset);

  useEffect(() => {
    if (!from || !to) return;
    fetch(`/api/breakdown?from=${from}&to=${to}${mkt ? `&mkt=${mkt}` : ""}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setData(j.sections ? j : null))
      .catch(() => setData(null));
  }, [from, to, mkt, refreshKey]);

  const s = data?.summary;

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="chart-title">Détail du bénéfice</div>
        <div className="breakdown-range">
          <select className="btn" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Période">
            <option value="all">Depuis le début</option>
            <option value="year">Cette année</option>
            <option value="month">Ce mois</option>
            <option value="lastMonth">Mois dernier</option>
            <option value="30d">30 derniers jours</option>
            <option value="90d">90 derniers jours</option>
            <option value="custom">Personnalisé…</option>
          </select>
          {preset === "custom" && (
            <>
              <input className="btn" type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} aria-label="Du" />
              <input className="btn" type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} aria-label="Au" />
            </>
          )}
        </div>
      </div>

      {!data || !s ? (
        <div className="muted">Chargement…</div>
      ) : (
        <>
          <div className="breakdown-head num">
            <div>
              <div className="label">Bénéfice net</div>
              <div className={`breakdown-hero ${signClass(s.netProfit)}`}>{fmtEur(s.netProfit)}</div>
            </div>
            <div className="breakdown-kpis">
              <span>
                Marge <strong>{fmtPct(s.margin)}</strong>
              </span>
              <span>
                ROI <strong>{fmtPct(s.roi)}</strong>
              </span>
              <span>
                <strong>{fmtInt(s.orders)}</strong> cmd · <strong>{fmtInt(s.units)}</strong> unités
              </span>
            </div>
          </div>

          <div className="details num breakdown">
            {data.sections.map((sec, i) => {
              const isOpen = open[sec.key] ?? false;
              const expandable = sec.lines.length > 1 || sec.lines.some((l) => l.note);
              return (
                <div key={sec.key} className="breakdown-section">
                  <div className="row section-row">
                    <span>
                      {expandable ? (
                        <button className="link-btn" onClick={() => setOpen((o) => ({ ...o, [sec.key]: !isOpen }))} aria-expanded={isOpen}>
                          {isOpen ? "▾" : "▸"} {i === 0 ? "" : sec.total >= 0 ? "+ " : "− "}
                          {sec.title}
                        </button>
                      ) : (
                        <>
                          {i === 0 ? "" : sec.total >= 0 ? "+ " : "− "}
                          {sec.title}
                        </>
                      )}
                    </span>
                    <span className={i === 0 ? "" : signClass(sec.total)}>{fmtEur(sec.total)}</span>
                  </div>
                  {expandable &&
                    isOpen &&
                    sec.lines.map((l) => (
                      <div key={l.label} className="row sub-row">
                        <span>
                          {l.label}
                          {l.note && <span className="warn-text"> · {l.note}</span>}
                        </span>
                        <span>{fmtEur(l.amount)}</span>
                      </div>
                    ))}
                </div>
              );
            })}
            <div className="row total">
              <span>= Bénéfice net</span>
              <span className={signClass(s.netProfit)}>{fmtEur(s.netProfit)}</span>
            </div>
          </div>

          <div className="note" style={{ marginTop: 10 }}>
            {data.vatRegistered
              ? "Montants HT : la TVA collectée est reversée et la TVA sur les frais Amazon est récupérable."
              : `Micro-entreprise : tout est compté TVA comprise. La TVA payée à Amazon (sur ses frais, et retenue sur certaines ventes : ${fmtEur(data.feeVat)} sur la période) n'est pas récupérable, elle est incluse dans les frais.`}{" "}
            Ventes, frais des commandes et coût d&apos;achat sont rattachés à la date de commande ; remboursements et autres frais à la date où Amazon les
            enregistre.
          </div>
        </>
      )}
    </section>
  );
}
