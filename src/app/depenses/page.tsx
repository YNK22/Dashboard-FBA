"use client";

import { useEffect, useState } from "react";
import { fmtEur } from "@/components/format";

interface Expense {
  id: number;
  date: string;
  label: string;
  category: string | null;
  amount: number;
}

const CATEGORIES = ["Publicité", "Logiciels", "Prep center", "Transport", "Comptabilité", "Autre"];

export default function DepensesPage() {
  const [rows, setRows] = useState<Expense[]>([]);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), label: "", category: "Publicité", amount: "" });
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    fetch("/api/expenses", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setRows(j.rows ?? []));
  useEffect(() => {
    load();
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, amount: Number(form.amount.replace(",", ".")) }),
    });
    const j = await res.json();
    setMsg(res.ok ? "Dépense ajoutée." : j.error);
    if (res.ok) setForm({ ...form, label: "", amount: "" });
    load();
  };

  const remove = async (id: number) => {
    await fetch(`/api/expenses?id=${id}`, { method: "DELETE" });
    load();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dépenses</h1>
          <div className="page-sub">
            Coûts hors Amazon déduits du bénéfice net à leur date : publicité, logiciels, prep center… Montants HT (TTC si non assujetti).
            Les frais Amazon (abonnement, stockage…) sont récupérés automatiquement.
          </div>
        </div>
      </div>
      {msg && <div className="banner">{msg}</div>}

      <section className="panel">
        <form className="form-row" onSubmit={add}>
          <label>
            Date
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
          </label>
          <label style={{ flex: 1, minWidth: 180 }}>
            Libellé
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="ex. Sponsored Products octobre" required />
          </label>
          <label>
            Catégorie
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Montant (€)
            <input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0,00" required style={{ width: 110 }} />
          </label>
          <button className="btn btn-primary" type="submit">
            Ajouter
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="table-wrap">
          <table className="num">
            <thead>
              <tr>
                <th>Date</th>
                <th style={{ textAlign: "left" }}>Libellé</th>
                <th style={{ textAlign: "left" }}>Catégorie</th>
                <th>Montant</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    Aucune dépense saisie.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(`${r.date}T12:00:00`).toLocaleDateString("fr-FR")}</td>
                  <td style={{ textAlign: "left" }}>{r.label}</td>
                  <td style={{ textAlign: "left" }}>{r.category ?? "—"}</td>
                  <td>{fmtEur(r.amount)}</td>
                  <td>
                    <button className="more-btn" onClick={() => remove(r.id)} aria-label={`Supprimer ${r.label}`}>
                      Supprimer
                    </button>
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
