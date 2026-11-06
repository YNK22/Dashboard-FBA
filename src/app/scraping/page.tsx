"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtInt } from "@/components/format";
import type { SourceView } from "@/lib/scraper/sources";

const MODES: Record<SourceView["mode"], { label: string; help: string }> = {
  sitemap: { label: "SITEMAP", help: "Lit le plan du site (sitemap.xml) : rapide, tout le catalogue d'un coup." },
  crawl: { label: "CRAWL", help: "Suit les liens à partir des pages de départ (catégories) : pour les sites sans sitemap." },
  hybrid: { label: "HYBRID", help: "Sitemap d'abord, puis suit les liens : le plus complet." },
  feed: {
    label: "FLUX",
    help: "Lit un flux produits (CSV ou XML : Google Shopping, Awin, Effinity, fichier fournisseur…) au lieu des pages : la solution pour les sites qui bloquent les robots.",
  },
};

const STATUS: Record<string, { label: string; cls: string }> = {
  running: { label: "EN COURS", cls: "st-run" },
  success: { label: "SUCCESS", cls: "st-ok" },
  error: { label: "ERREUR", cls: "st-err" },
  cancelled: { label: "ARRÊTÉ", cls: "st-off" },
  interrupted: { label: "INTERROMPU", cls: "st-off" },
};

const dt = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

function duration(a: string, b: string | null): string {
  const s = Math.max(0, Math.round(((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : m ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

type FormState = {
  id?: number;
  name: string;
  base_url: string;
  mode: SourceView["mode"];
  start_urls: string;
  url_pattern: string;
  interval_days: string;
  max_pages: string;
  delay_ms: string;
  auto: boolean;
};

const EMPTY: FormState = {
  name: "",
  base_url: "",
  mode: "hybrid",
  start_urls: "",
  url_pattern: "",
  interval_days: "21",
  max_pages: "2000",
  delay_ms: "1000",
  auto: true,
};

export default function ScrapingPage() {
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      fetch("/api/scraping", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setSources(j.sources ?? []))
        .catch(() => setSources((s) => s ?? [])),
    [],
  );

  const active = sources?.some((s) => s.live || s.queuedPosition) ?? false;
  useEffect(() => {
    load();
    const id = setInterval(load, active ? 3000 : 30_000);
    return () => clearInterval(id);
  }, [load, active]);

  const run = async (s: SourceView) => {
    const res = await fetch(`/api/scraping/${s.id}/run`, { method: s.live || s.queuedPosition ? "DELETE" : "POST" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setMsg({ text: j.error ?? "Erreur", error: true });
    load();
  };

  const toggleAuto = async (s: SourceView) => {
    await fetch(`/api/scraping/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auto: !s.auto }) });
    load();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    const body = {
      ...form,
      interval_days: Number(form.interval_days),
      max_pages: Number(form.max_pages),
      delay_ms: Number(form.delay_ms),
    };
    const res = await fetch(form.id ? `/api/scraping/${form.id}` : "/api/scraping", {
      method: form.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setMsg({ text: j.error ?? "Erreur", error: true });
    setMsg({ text: form.id ? "Source modifiée." : "Source ajoutée : appuyez sur « Lancer » pour le premier run." });
    setForm(null);
    load();
  };

  const remove = async () => {
    if (!form?.id || !confirm(`Supprimer « ${form.name} » et tous ses produits trouvés ?`)) return;
    await fetch(`/api/scraping/${form.id}`, { method: "DELETE" });
    setForm(null);
    load();
  };

  const edit = (s: SourceView) =>
    setForm({
      id: s.id,
      name: s.name,
      base_url: s.base_url,
      mode: s.mode,
      start_urls: s.start_urls ?? "",
      url_pattern: s.url_pattern ?? "",
      interval_days: String(s.interval_days),
      max_pages: String(s.max_pages),
      delay_ms: String(s.delay_ms),
      auto: Boolean(s.auto),
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Scraping</h1>
          <div className="page-sub">Titre, EAN et URL des produits de vos sites fournisseurs. Les runs tournent sur le serveur : vous pouvez fermer l&apos;appli.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setForm({ ...EMPTY })}>
          + Source
        </button>
      </div>

      {msg && (
        <div className={`banner${msg.error ? " error" : ""}`} onClick={() => setMsg(null)}>
          {msg.text}
        </div>
      )}

      {sources === null ? (
        <div className="muted">Chargement…</div>
      ) : sources.length === 0 ? (
        <section className="panel empty-state">
          <p>Aucune source pour l&apos;instant.</p>
          <p className="note">Ajoutez le site d&apos;un fournisseur (ex. une boutique en ligne) : le dashboard lira ses fiches produit (titre, EAN, prix, URL).</p>
          <button className="btn btn-primary" onClick={() => setForm({ ...EMPTY })}>
            + Ajouter une source
          </button>
        </section>
      ) : (
        <div className="scrape-grid">
          {sources.map((s) => {
            const r = s.lastRun;
            const live = s.live;
            const status = live ? STATUS.running : s.queuedPosition ? { label: `EN FILE (${s.queuedPosition})`, cls: "st-run" } : r ? STATUS[r.status] ?? STATUS.error : null;
            const busyRun = Boolean(live || s.queuedPosition);
            return (
              <section key={s.id} className="scrape-card">
                <div className="scrape-head">
                  <button className="link-btn scrape-name" onClick={() => edit(s)} title="Modifier">
                    <strong>{s.name}</strong>
                    <span className="sku">{host(s.base_url)} ✎</span>
                  </button>
                  <div className="scrape-badges">
                    <span className="pill pill-mode">{MODES[s.mode].label}</span>
                    {status && <span className={`pill ${status.cls}`}>{status.label}</span>}
                  </div>
                </div>

                <div className="scrape-stats num">
                  <div>
                    <span className="label">{live ? "Démarré" : "Dernier run"}</span>
                    <strong>{live ? dt(r?.started_at) : dt(r?.started_at)}</strong>
                  </div>
                  <div>
                    <span className="label">Durée</span>
                    <strong>{r ? duration(r.started_at, live ? null : r.finished_at) : "—"}</strong>
                  </div>
                  <div>
                    <span className="label">Offres vues</span>
                    <strong>{fmtInt(live ? live.offers : (r?.offers_seen ?? 0))}</strong>
                  </div>
                  <div>
                    <span className="label">Nouveaux produits</span>
                    <strong>{fmtInt(live ? live.newProducts : (r?.new_products ?? 0))}</strong>
                  </div>
                  <div>
                    <span className="label">Nouvelles offres</span>
                    <strong>{fmtInt(live ? live.newOffers : (r?.new_offers ?? 0))}</strong>
                  </div>
                  <div>
                    <span className="label">Erreurs</span>
                    <strong className={(live ? live.errors : (r?.errors ?? 0)) > 0 ? "warn-text" : ""}>{fmtInt(live ? live.errors : (r?.errors ?? 0))}</strong>
                  </div>
                </div>

                {live && (
                  <div className="note scrape-live">
                    ⏳ {live.phase} · {fmtInt(live.pages)} page(s) lue(s){live.queued ? ` · ${fmtInt(live.queued)} en attente` : ""}
                  </div>
                )}
                {!live && r?.message && <div className={`note ${r.status === "error" ? "warn-text" : ""}`}>{r.message}</div>}

                <div className="scrape-foot">
                  <span className="note">
                    🕑 Prochain run : {s.auto && s.next_run_at ? dt(s.next_run_at) : "—"} · tous les {s.interval_days} j
                  </span>
                  <div className="scrape-actions">
                    <Link className="btn" href={`/scraping/${s.id}`}>
                      Produits ({fmtInt(s.products)})
                    </Link>
                    <button className="btn" onClick={() => toggleAuto(s)} aria-pressed={Boolean(s.auto)}>
                      Auto {s.auto ? "ON" : "OFF"}
                    </button>
                    <button className={`btn ${busyRun ? "btn-stop" : "btn-primary"}`} onClick={() => run(s)}>
                      {busyRun ? "■ Arrêter" : "▷ Lancer"}
                    </button>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {form && (
        <div className="sheet-backdrop" onClick={() => setForm(null)}>
          <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <div className="panel-head">
              <h2 className="panel-title">{form.id ? "Modifier la source" : "Nouvelle source"}</h2>
              <button type="button" className="icon-btn" onClick={() => setForm(null)} aria-label="Fermer">
                ✕
              </button>
            </div>
            <label className="field">
              URL du site
              <input
                required
                inputMode="url"
                autoCapitalize="off"
                placeholder="https://www.boutique.fr"
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              />
            </label>
            <label className="field">
              Nom
              <input placeholder="(par défaut : le nom du site)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <div className="field">
              Mode
              <div className="segmented">
                {(Object.keys(MODES) as SourceView["mode"][]).map((m) => (
                  <button type="button" key={m} aria-pressed={form.mode === m} onClick={() => setForm({ ...form, mode: m })}>
                    {MODES[m].label}
                  </button>
                ))}
              </div>
              <span className="note">{MODES[form.mode].help}</span>
            </div>
            <label className="field">
              URLs de départ <span className="muted">(facultatif, une par ligne)</span>
              <textarea
                rows={3}
                autoCapitalize="off"
                placeholder={
                  form.mode === "feed"
                    ? "https://www.boutique.fr/flux/google-shopping.xml"
                    : "https://www.boutique.fr/sitemap_products.xml\nhttps://www.boutique.fr/bricolage/"
                }
                value={form.start_urls}
                onChange={(e) => setForm({ ...form, start_urls: e.target.value })}
              />
              <span className="note">
                {form.mode === "feed"
                  ? "Adresse(s) du flux produits. Vide : importez le fichier depuis la page Produits de la source."
                  : "Sitemaps (.xml) et/ou pages catégorie. Vide : sitemap annoncé dans robots.txt, et page d'accueil."}
              </span>
            </label>
            {form.mode !== "feed" && (
              <label className="field">
                Filtre des URLs produit <span className="muted">(facultatif)</span>
                <input autoCapitalize="off" placeholder="/produit/  ou  -p\d+\.html$" value={form.url_pattern} onChange={(e) => setForm({ ...form, url_pattern: e.target.value })} />
                <span className="note">Ne lit que les pages dont l&apos;URL contient ce texte (ou correspond à cette expression) : beaucoup plus rapide.</span>
              </label>
            )}
            <div className="field-row">
              <label className="field">
                Tous les (jours)
                <input inputMode="numeric" value={form.interval_days} onChange={(e) => setForm({ ...form, interval_days: e.target.value })} />
              </label>
              <label className="field">
                Pages max
                <input inputMode="numeric" value={form.max_pages} onChange={(e) => setForm({ ...form, max_pages: e.target.value })} />
              </label>
              <label className="field">
                Pause (ms)
                <input inputMode="numeric" value={form.delay_ms} onChange={(e) => setForm({ ...form, delay_ms: e.target.value })} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={form.auto} onChange={(e) => setForm({ ...form, auto: e.target.checked })} /> Relancer automatiquement
            </label>
            <div className="sheet-actions">
              {form.id && (
                <button type="button" className="btn btn-danger" onClick={remove}>
                  Supprimer
                </button>
              )}
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "…" : form.id ? "Enregistrer" : "Ajouter"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
