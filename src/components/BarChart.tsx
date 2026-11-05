"use client";

import { useEffect, useRef, useState } from "react";
import type { ChartPoint } from "@/lib/queries";
import { compactEur, fmtEur, fmtInt } from "./format";

type Metric = "salesTtc" | "netProfit" | "netAfterUrssaf";

/** Histogramme simple en SVG (une série, axe unique, infobulle au survol). */
export default function BarChart({
  points,
  metric,
  longLabel,
  showUrssaf = false,
}: {
  points: ChartPoint[];
  metric: Metric;
  longLabel: (p: ChartPoint) => string;
  showUrssaf?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1000);
  const [H, setH] = useState(260);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setW(el.clientWidth || 1000);
      setH(el.clientWidth < 600 ? 200 : 260);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const padL = 52;
  const padR = 8;
  const padT = 10;
  const padB = 24;

  const values = points.map((p) => p[metric]);
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  const { max, min, ticks } = niceScale(rawMin, rawMax);
  const y = (v: number) => padT + ((max - v) / (max - min || 1)) * (H - padT - padB);
  const band = (W - padL - padR) / Math.max(points.length, 1);
  const barW = Math.min(24, band * 0.7);
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor((W - padL) / 34))));

  const hp = hover !== null ? points[hover] : null;

  return (
    <div className="chart-wrap" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Graphique des ventes">
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? "zero" : "grid"} x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} />
            <text className="axis" x={padL - 8} y={y(t) + 4} textAnchor="end">
              {compactEur(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const v = p[metric];
          const cx = padL + band * i + band / 2;
          const top = y(Math.max(v, 0));
          const h = Math.max(Math.abs(y(v) - y(0)), v === 0 ? 0 : 1.5);
          const r = Math.min(4, barW / 2, h);
          const fill = p.future ? "var(--bar-muted)" : v < 0 ? "var(--bad)" : "var(--bar)";
          return (
            <g key={p.key}>
              {h > 0 && <path d={roundedBar(cx - barW / 2, top, barW, h, r, v >= 0)} fill={fill} opacity={hover === null || hover === i ? 1 : 0.55} />}
              {i % labelEvery === 0 && (
                <text className="axis" x={cx} y={H - 6} textAnchor="middle">
                  {p.label}
                </text>
              )}
              {/* zone de survol plus large que la barre */}
              <rect x={padL + band * i} y={padT} width={band} height={H - padT - padB} fill="transparent" onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {hp && hover !== null && (
        <div
          className="tooltip num"
          style={{
            left: `clamp(80px, ${((padL + band * hover + band / 2) / W) * 100}%, calc(100% - 80px))`,
            top: `${(y(Math.max(hp[metric], 0)) / H) * 100}%`,
          }}
        >
          <strong>{longLabel(hp)}</strong>
          CA TTC : {fmtEur(hp.salesTtc)}
          <br />
          Bénéfice net : {fmtEur(hp.netProfit)}
          <br />
          {showUrssaf && (
            <>
              Après URSSAF : {fmtEur(hp.netAfterUrssaf)}
              <br />
            </>
          )}
          {fmtInt(hp.orders)} cmd · {fmtInt(hp.units)} unités
        </div>
      )}
    </div>
  );
}

/** Barre avec coins arrondis uniquement côté valeur (carrés à la ligne de base). */
function roundedBar(x: number, yTop: number, w: number, h: number, r: number, positive: boolean): string {
  if (positive) {
    return `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yTop + h} Z`;
  }
  const b = yTop + h;
  return `M${x},${yTop} V${b - r} Q${x},${b} ${x + r},${b} H${x + w - r} Q${x + w},${b} ${x + w},${b - r} V${yTop} Z`;
}

function niceScale(min: number, max: number) {
  const span = max - min || 1;
  const step0 = span / 4;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const nMin = Math.floor(min / step) * step;
  const nMax = Math.ceil(max / step) * step || step;
  const ticks: number[] = [];
  for (let t = nMin; t <= nMax + step / 2; t += step) ticks.push(Math.round(t * 100) / 100);
  return { min: nMin, max: nMax, ticks };
}
