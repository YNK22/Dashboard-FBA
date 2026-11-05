"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { fmtEur, fmtInt } from "@/components/format";
import type { SourceView } from "@/lib/scraper/sources";

interface Product {
  id: number;
  title: string;
  ean: string | null;
  price: number | null;
  currency: string | null;
  url: string;
  first_seen: string;
  last_seen: string;
}

interface Run {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  pages_seen: number;
  offers_seen: number;
  new_products: number;
  new_offers: number;
  errors: number;
  message: string | null;
}

const STATUS_FR: Record<string, string> = { running: "en cours", success: "OK", error: "erreur", cancelled: "arrêté", interrupted: "interrompu" };
const d = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });
const price = (p: Product) => (p.price === null ? null : p.currency && p.currency !== "EUR" ? `${p.price} ${p.currency}` : fmtEur(p.price));

export default function ScrapingProductsPage() {
  const { id } = useParams<{ id: string }>();
  const [source, setSource] = useState<SourceView | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [rows, setRows] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "ean" | "new">("all");
  const [showRuns, setShowRuns] = useState(false);

  useEffect(() => {
    fetch(`/api/scraping/${id}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setSource(j.source ?? null);
        setRuns(j.runs ?? []);
      });
  }, [id]);

  const qs = useCallback(
    (extra = "") => `q=${encodeURIComponent(q)}${filter === "ean" ? "&ean=1" : filter === "new" ? "&new=1" : ""}${extra}`,
    [q, filter],
  );

  useEffect(() => {
    const t = setTimeout(() => {
      fetch(`/api/scraping/${id}/products?${qs(`&page=${page}`)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => {
          setRows((prev) => (page === 1 ? (j.rows ?? []) : [...prev, ...(j.rows ?? [])]));
          setTotal(j.total ?? 0);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [id, qs, page]);

  useEffect(() => setPage(1), [q, filter]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="note">
            <Link href="/scraping">‹ Scraping</Link>
          </div>
          <h1>{source?.name ?? "…"}</h1>
          <div className="page-sub">
            {fmtInt(source?.products ?? 0)} produits, dont {fmtInt(source?.withEan ?? 0)} avec EAN
          </div>
        </div>
        <a className="btn" href={`/api/scraping/${id}/products?${qs("&format=csv")}`}>
          ⬇ CSV
        </a>
      </div>

      <section className="panel">
        <div className="panel-head">
          <input className="cell search" placeholder="Titre, EAN, URL…" value={q} onChange={(e) => setQ(e.target.value)} inputMode="search" />
          <div className="segmented">
            <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              Tous
            </button>
            <button aria-pressed={filter === "ean"} onClick={() => setFilter("ean")}>
              Avec EAN
            </button>
            <button aria-pressed={filter === "new"} onClick={() => setFilter("new")}>
              Nouveaux
            </button>
          </div>
        </div>
        <div className="note">{fmtInt(total)} résultat(s)</div>

        <div className="product-list">
          {rows.length === 0 && <div className="muted" style={{ padding: "16px 0" }}>Aucun produit.</div>}
          {rows.map((p) => (
            <div key={p.id} className="product-item">
              <a className="title" href={p.url} target="_blank" rel="noopener noreferrer">
                {p.title}
              </a>
              <div className="product-meta num">
                {p.ean ? (
                  <span className="ean" onClick={() => navigator.clipboard?.writeText(p.ean!)} title="Copier l'EAN">
                    {p.ean}
                  </span>
                ) : (
                  <span className="muted">sans EAN</span>
                )}
                {price(p) && <strong>{price(p)}</strong>}
                <span className="muted">vu le {d(p.last_seen)}</span>
              </div>
              <div className="product-links">
                <a href={p.url} target="_blank" rel="noopener noreferrer">
                  Fiche fournisseur ↗
                </a>
                {p.ean && (
                  <a href={`https://www.amazon.fr/s?k=${p.ean}`} target="_blank" rel="noopener noreferrer">
                    Chercher sur Amazon ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
        {rows.length < total && (
          <div className="pager">
            <button className="btn" onClick={() => setPage((n) => n + 1)}>
              Afficher plus ({fmtInt(total - rows.length)})
            </button>
          </div>
        )}
      </section>

      <section className="panel">
        <button className="link-btn panel-title" onClick={() => setShowRuns(!showRuns)} aria-expanded={showRuns}>
          {showRuns ? "▾" : "▸"} Historique des runs ({runs.length})
        </button>
        {showRuns && (
          <div className="details num" style={{ marginTop: 10 }}>
            {runs.map((r) => (
              <div key={r.id} className="run-row">
                <div className="row">
                  <span>
                    {new Date(r.started_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} · {STATUS_FR[r.status] ?? r.status}
                  </span>
                  <span>
                    {fmtInt(r.offers_seen)} offres · +{fmtInt(r.new_offers)} · {fmtInt(r.errors)} err.
                  </span>
                </div>
                {r.message && <div className="note">{r.message}</div>}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
