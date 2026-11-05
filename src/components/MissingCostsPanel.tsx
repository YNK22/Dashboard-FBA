"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtEur, fmtInt } from "./format";

interface MissingRow {
  sku: string;
  title: string | null;
  asin: string | null;
  units: number;
  lastSale: string;
  lastPrice: number | null;
  lotsWithoutCost: number;
  unitsInLots: number;
}

/**
 * Produits vendus sans coût d'achat : un champ par produit, enregistré en un clic.
 * Le coût complète tous les lots sans coût du SKU et sert de prix par défaut.
 */
export default function MissingCostsPanel({ vatRegistered, onSaved }: { vatRegistered: boolean; onSaved?: () => void }) {
  const [rows, setRows] = useState<MissingRow[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      fetch("/api/cogs/missing", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setRows(j.rows ?? []))
        .catch(() => setRows([])),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  // Arrivée depuis l'alerte du dashboard (/produits#a-completer) : la liste se charge après la page
  const loaded = rows !== null;
  useEffect(() => {
    if (loaded && window.location.hash === "#a-completer") document.getElementById("a-completer")?.scrollIntoView({ block: "start" });
  }, [loaded]);

  const filled = Object.entries(values).filter(([, v]) => v.trim() !== "");

  const save = async (only?: string) => {
    const body = (only ? filled.filter(([sku]) => sku === only) : filled).map(([sku, v]) => ({ sku, unit_cost: v }));
    if (body.length === 0) return;
    setSaving(true);
    const res = await fetch("/api/cogs/missing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(
      () => null,
    );
    const j = res ? await res.json().catch(() => ({})) : {};
    setSaving(false);
    if (!res?.ok || j.errors?.length) {
      setMsg({ text: j.errors?.join(" · ") || "Erreur lors de l'enregistrement.", error: true });
    } else {
      setMsg({ text: `${j.saved} produit(s) enregistré(s). Le bénéfice est recalculé.` });
    }
    setValues((v) => {
      const next = { ...v };
      for (const b of body) if (!j.errors?.some((e: string) => e.startsWith(b.sku))) delete next[b.sku];
      return next;
    });
    await load();
    onSaved?.();
  };

  if (rows === null) return null;

  return (
    <section className="panel missing-costs" id="a-completer" style={{ marginTop: 0 }}>
      <div className="panel-head">
        <h2 className="panel-title">
          {rows.length === 0 ? "✅ Tous les produits vendus ont un coût d'achat" : `À compléter : ${fmtInt(rows.reduce((s, r) => s + r.units, 0))} unité(s) vendue(s) sans coût`}
        </h2>
        {rows.length > 0 && (
          <button className="btn btn-primary" onClick={() => save()} disabled={saving || filled.length === 0}>
            {saving ? "Enregistrement…" : `Enregistrer${filled.length ? ` (${filled.length})` : ""}`}
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <p className="note" style={{ marginTop: 0 }}>
          Ces ventes sont comptées à 0 € de coût, ce qui gonfle le bénéfice. Saisissez le coût unitaire{" "}
          <strong>{vatRegistered ? "HT" : "réellement payé, TVA comprise"}</strong> (achat + prep + port vers Amazon) : il s&apos;applique à tous les lots de
          ce produit encore sans coût.
        </p>
      )}
      {msg && <div className={`banner${msg.error ? " error" : ""}`}>{msg.text}</div>}

      <div className="missing-list">
        {rows.map((r) => (
          <div key={r.sku} className="missing-item">
            <div className="missing-info">
              <span className="title" title={r.title ?? ""}>
                {r.title ?? r.sku}
              </span>
              <span className="sku">
                {r.sku}
                {r.asin ? ` · ${r.asin}` : ""}
              </span>
              <span className="note">
                <strong>{fmtInt(r.units)}</strong> unité(s) vendue(s) sans coût · dernière vente le {new Date(r.lastSale).toLocaleDateString("fr-FR")}
                {r.lastPrice ? ` à ${fmtEur(r.lastPrice)}` : ""}
                {r.lotsWithoutCost > 0 ? ` · ${r.lotsWithoutCost} lot(s), ${fmtInt(r.unitsInLots)} u.` : " · aucun lot"}
              </span>
            </div>
            <label className="missing-input">
              <input
                className={`cell${(values[r.sku] ?? "") === "" ? " missing" : ""}`}
                inputMode="decimal"
                placeholder="coût / u."
                value={values[r.sku] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [r.sku]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && save(r.sku)}
                aria-label={`Coût d'achat unitaire de ${r.sku}`}
              />
              <span>€</span>
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}
