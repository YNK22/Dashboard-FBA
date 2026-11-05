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
export default function BreakdownPanel({
  refreshKey,
  mkt,
  onSettingsChange,
}: {
  refreshKey?: string;
  mkt: string | null;
  onSettingsChange?: () => void;
}) {
  const [preset, setPreset] = useState<Preset>("all");
  const [reload, setReload] = useState(0);
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
  }, [from, to, mkt, refreshKey, reload]);

  const s = data?.summary;
  const rate = data?.urssafRate ?? 0;
  const saved = () => {
    setReload((n) => n + 1);
    onSettingsChange?.();
  };

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
              <div className="label">{rate > 0 ? "Ce qu'il vous reste (après URSSAF)" : "Bénéfice net"}</div>
              <div className={`breakdown-hero ${signClass(rate > 0 ? s.netAfterUrssaf : s.netProfit)}`}>
                {fmtEur(rate > 0 ? s.netAfterUrssaf : s.netProfit)}
              </div>
            </div>
            <div className="breakdown-kpis">
              {rate > 0 && (
                <span>
                  Bénéfice avant URSSAF <strong>{fmtEur(s.netProfit)}</strong>
                </span>
              )}
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
              <span>= Bénéfice net{rate > 0 ? " (avant URSSAF)" : ""}</span>
              <span className={signClass(s.netProfit)}>{fmtEur(s.netProfit)}</span>
            </div>
            {rate > 0 && (
              <>
                <div className="breakdown-section">
                  <div className="row section-row">
                    <span>− Cotisations URSSAF</span>
                    <span className="neg">{fmtEur(-s.urssaf)}</span>
                  </div>
                  <div className="row sub-row">
                    <span>
                      {fmtPct(rate)} du CA encaissé ({fmtEur(s.urssafBase)} = ventes {fmtEur(s.salesHt)} − remboursés{" "}
                      {fmtEur(s.salesHt - s.urssafBase)})
                    </span>
                    <span>{fmtEur(-s.urssaf)}</span>
                  </div>
                </div>
                <div className="row total">
                  <span>= Ce qu&apos;il vous reste</span>
                  <span className={signClass(s.netAfterUrssaf)}>{fmtEur(s.netAfterUrssaf)}</span>
                </div>
              </>
            )}
          </div>

          <UrssafSetting rate={rate} onSaved={saved} />

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

/** Réglage du taux de cotisations URSSAF (micro-entreprise), enregistré dans le dashboard. */
function UrssafSetting({ rate, onSaved }: { rate: number; onSaved: () => void }) {
  const [value, setValue] = useState(() => (rate > 0 ? String(Math.round(rate * 10000) / 100).replace(".", ",") : ""));
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  useEffect(() => setValue(rate > 0 ? String(Math.round(rate * 10000) / 100).replace(".", ",") : ""), [rate]);

  const save = async () => {
    setState("saving");
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urssafRate: value.trim() === "" ? 0 : value }),
    }).catch(() => null);
    if (!res?.ok) return setState("error");
    setState("idle");
    onSaved();
  };

  return (
    <div className="urssaf-setting">
      <label>
        Taux URSSAF{" "}
        <input
          className="btn"
          inputMode="decimal"
          value={value}
          placeholder="ex. 12,4"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          aria-label="Taux de cotisations URSSAF en %"
        />{" "}
        %
      </label>
      <button className="btn" onClick={save} disabled={state === "saving"}>
        {state === "saving" ? "…" : "Enregistrer"}
      </button>
      {state === "error" && <span className="warn-text">Taux invalide</span>}
      <span className="note">
        Vente de marchandises en micro : cotisations sociales + formation professionnelle, + versement libératoire de l&apos;impôt si vous l&apos;avez choisi.
        Prenez le taux total indiqué sur votre espace URSSAF. 0 = pas de calcul.
      </span>
    </div>
  );
}
