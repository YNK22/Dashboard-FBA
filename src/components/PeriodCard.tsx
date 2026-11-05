"use client";

import { useState } from "react";
import type { Card } from "@/lib/queries";
import { fmtEur, fmtInt, fmtPct, fmtPct0, signClass, splitEur } from "./format";

export default function PeriodCard({
  card,
  active,
  vatRegistered,
  urssafRate = 0,
}: {
  card: Card;
  active: boolean;
  vatRegistered: boolean;
  urssafRate?: number;
}) {
  const [open, setOpen] = useState(false);
  const s = card.summary;
  const hero = splitEur(s.salesTtc);
  const pct = card.compare?.pct;
  const trend = pct === null || pct === undefined ? "flat" : pct >= 0.005 ? "up" : pct <= -0.005 ? "down" : "flat";
  const isForecast = card.key === "forecast";
  const ht = vatRegistered ? "HT" : "TTC";

  return (
    <section className={`card${active ? " active" : ""}`} aria-label={`${card.title} — ${card.subtitle}`}>
      <div className={`card-head${card.live ? " live" : ""}`}>
        <div className="card-title">
          {card.title}
          {card.live && (
            <span className="live-pill">
              <span className="live-dot" />
              en direct
            </span>
          )}
        </div>
        <div className="card-sub">{card.subtitle}</div>
      </div>

      <div className="card-body">
        <div>
          <div className="label">
            {isForecast ? "Ventes prévues" : "Ventes"} TTC<span className="mobile-only"> · {card.subtitle}</span>
          </div>
          <div className="hero num">
            {hero.whole}
            <span className="cents">{hero.cents}</span>
          </div>
          <div className="sub-hero num">{fmtEur(s.salesHt)} HT</div>
        </div>

        {card.compare && (
          <div className={`badge ${trend}`}>
            <span aria-hidden>{trend === "up" ? "▲" : trend === "down" ? "▼" : "•"}</span>
            <span>
              {pct === null || pct === undefined ? "—" : fmtPct0(Math.abs(pct))} {card.compare.label}
            </span>
          </div>
        )}

        {!isForecast && s.pendingSalesTtc > 0 && (
          <div className="note num">
            dont {fmtEur(s.pendingSalesTtc)} en attente d&apos;expédition ({fmtInt(s.pendingOrders)} cmd)
          </div>
        )}

        <div className="kpis">
          <div className="kpi">
            <div className="label">Cmd / Unités</div>
            <div className="value num">
              {fmtInt(s.orders)} <span className="muted">/ {fmtInt(s.units)}</span>
            </div>
          </div>
          <div className="kpi">
            <div className="label">Rembours.</div>
            <div className="value num">{fmtInt(s.refunds)}</div>
          </div>
          {urssafRate > 0 ? (
            <div className="kpi">
              <div className="label">Après URSSAF</div>
              <div className={`value num ${signClass(s.netAfterUrssaf)}`}>{fmtEur(s.netAfterUrssaf)}</div>
            </div>
          ) : (
            <div className="kpi">
              <div className="label">Bénéfice brut</div>
              <div className={`value num ${signClass(s.grossProfit)}`}>{fmtEur(s.grossProfit)}</div>
            </div>
          )}
          <div className="kpi">
            <div className="label">Bénéfice net</div>
            <div className={`value num ${signClass(s.netProfit)}`}>{fmtEur(s.netProfit)}</div>
          </div>
          <div className="kpi">
            <div className="label">Marge</div>
            <div className="value num">{fmtPct(s.margin)}</div>
          </div>
          <div className="kpi">
            <div className="label">ROI</div>
            <div className="value num">{fmtPct(s.roi)}</div>
          </div>
        </div>

        {s.missingCogsUnits > 0 && (
          <div className="note warn-text">
            ⚠ {fmtInt(s.missingCogsUnits)} unité(s) sans prix d&apos;achat — <a href="/produits">à compléter</a>
          </div>
        )}

        <button className="more-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Moins ‹" : "Plus ›"}
        </button>

        {open && (
          <div className="details num">
            <div className="row">
              <span>Ventes TTC</span>
              <span>{fmtEur(s.salesTtc)}</span>
            </div>
            {vatRegistered && (
              <div className="row">
                <span>− TVA collectée</span>
                <span>{fmtEur(-s.vat)}</span>
              </div>
            )}
            <div className="row">
              <span>= Ventes {ht}</span>
              <span>{fmtEur(s.salesHt)}</span>
            </div>
            <div className="row">
              <span>− Frais Amazon</span>
              <span>{fmtEur(-s.amazonFees)}</span>
            </div>
            <div className="row">
              <span>− Coût d&apos;achat</span>
              <span>{fmtEur(-s.cogs)}</span>
            </div>
            <div className="row total">
              <span>= Bénéfice brut</span>
              <span>{fmtEur(s.grossProfit)}</span>
            </div>
            <div className="row">
              <span>− Remboursements ({fmtEur(s.refundAmountTtc)} TTC)</span>
              <span>{fmtEur(-s.refundCost)}</span>
            </div>
            <div className="row">
              <span>− Coûts divers (abonnement, stockage, pub…)</span>
              <span>{fmtEur(-s.otherCosts)}</span>
            </div>
            <div className="row total">
              <span>= Bénéfice net</span>
              <span className={signClass(s.netProfit)}>{fmtEur(s.netProfit)}</span>
            </div>
            {urssafRate > 0 && (
              <>
                <div className="row">
                  <span>
                    − Cotisations URSSAF ({fmtPct(urssafRate)} de {fmtEur(s.urssafBase)} encaissés)
                  </span>
                  <span>{fmtEur(-s.urssaf)}</span>
                </div>
                <div className="row total">
                  <span>= Reste pour vous</span>
                  <span className={signClass(s.netAfterUrssaf)}>{fmtEur(s.netAfterUrssaf)}</span>
                </div>
              </>
            )}
            {!isForecast && s.estimatedFeesSalesTtc > 0 && (
              <div className="note">Frais Amazon estimés pour {fmtEur(s.estimatedFeesSalesTtc)} de ventes pas encore réglées par Amazon.</div>
            )}
            {isForecast && <div className="note">Projection : réalisé du mois + moyenne des 14 derniers jours × jours restants.</div>}
          </div>
        )}
      </div>
    </section>
  );
}
