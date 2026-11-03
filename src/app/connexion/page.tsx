"use client";

import { useCallback, useEffect, useState } from "react";

interface Settings {
  connected: boolean;
  clientId: string;
  region: string;
  endpoint: string;
  marketplaces: string[];
  vatRegistered: boolean;
  timezone: string;
  syncIntervalMinutes: number;
  syncInitialDays: number;
  passwordProtected: boolean;
  demo: boolean;
  sync: {
    running: boolean;
    lastOkAt?: string | null;
    last?: { ok: boolean; orders: number; financeLines: number; feeEstimates: number; startedAt: string; finishedAt: string; error?: string };
  };
}

interface Step {
  label: string;
  ok: boolean;
  detail: string;
}

const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—");

export default function ConnexionPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [days, setDays] = useState("90");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => fetch("/api/settings", { cache: "no-store" }).then((r) => r.json()).then(setS), []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const check = async () => {
    setChecking(true);
    setSteps(null);
    try {
      const j = await (await fetch("/api/check", { method: "POST" })).json();
      setSteps(j.steps);
    } finally {
      setChecking(false);
    }
  };

  const sync = async (withDays?: number) => {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withDays ? { days: withDays } : {}),
    });
    const j = await res.json();
    setMsg(res.ok ? (withDays ? `Ré-import des ${withDays} derniers jours lancé.` : "Synchronisation lancée.") : j.error);
    load();
  };

  const clearDemo = async () => {
    if (!confirm("Effacer toutes les données de démonstration ?")) return;
    const res = await fetch("/api/demo", { method: "DELETE" });
    setMsg(res.ok ? "Données de démonstration effacées." : (await res.json()).error);
    load();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Connexion Amazon</h1>
          <div className="page-sub">État de la connexion SP-API et de la synchronisation. Les identifiants se règlent dans les variables d&apos;environnement (fichier .env ou stack Portainer).</div>
        </div>
      </div>

      {msg && <div className="banner">{msg}</div>}
      {s?.demo && (
        <div className="banner">
          La base contient des <strong>données de démonstration</strong>.{" "}
          <button className="btn" onClick={clearDemo}>
            Effacer la démo
          </button>
        </div>
      )}
      {s && !s.passwordProtected && <div className="banner">🔒 Aucun mot de passe : définissez DASHBOARD_PASSWORD si le dashboard est accessible depuis Internet.</div>}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Configuration</h2>
          <button className="btn btn-primary" onClick={check} disabled={checking || !s?.connected}>
            {checking ? "Test en cours…" : "Tester la connexion"}
          </button>
        </div>
        {s && (
          <div className="details" style={{ borderTop: 0, fontSize: 14 }}>
            <div className="row">
              <span>Identifiants SP-API</span>
              <span>{s.connected ? `✅ ${s.clientId}` : "❌ non renseignés"}</span>
            </div>
            <div className="row">
              <span>Région</span>
              <span>
                {s.region} · {s.endpoint}
              </span>
            </div>
            <div className="row">
              <span>Marketplaces (taux de TVA)</span>
              <span>{s.marketplaces.join(", ")}</span>
            </div>
            <div className="row">
              <span>Calcul du bénéfice</span>
              <span>{s.vatRegistered ? "HT (assujetti TVA)" : "TTC (non assujetti)"}</span>
            </div>
            <div className="row">
              <span>Fuseau horaire</span>
              <span>{s.timezone}</span>
            </div>
            <div className="row">
              <span>Synchro automatique</span>
              <span>{s.syncIntervalMinutes > 0 ? `toutes les ${s.syncIntervalMinutes} min` : "désactivée"}</span>
            </div>
          </div>
        )}
        {steps && (
          <div className="details" style={{ marginTop: 12, fontSize: 14 }}>
            {steps.map((st) => (
              <div key={st.label}>
                <strong>
                  {st.ok ? "✅" : "❌"} {st.label}
                </strong>
                <div className="note" style={{ wordBreak: "break-word" }}>
                  {st.detail}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Synchronisation</h2>
          <button className="btn" onClick={() => sync()} disabled={!s?.connected || s?.sync.running || s?.demo}>
            {s?.sync.running ? "Synchronisation…" : "↻ Synchroniser maintenant"}
          </button>
        </div>
        {s && (
          <div className="details" style={{ borderTop: 0, fontSize: 14 }}>
            <div className="row">
              <span>Dernière synchro réussie</span>
              <span>{dt(s.sync.lastOkAt)}</span>
            </div>
            {s.sync.last && (
              <div className="row">
                <span>Dernier passage</span>
                <span>
                  {dt(s.sync.last.finishedAt)} · {s.sync.last.ok ? "✅" : "❌"} {s.sync.last.orders} commandes, {s.sync.last.financeLines} lignes financières
                </span>
              </div>
            )}
            {s.sync.last?.error && <div className="note warn-text">{s.sync.last.error}</div>}
          </div>
        )}
        <form
          className="form-row"
          style={{ marginTop: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            sync(Number(days));
          }}
        >
          <label>
            Ré-importer l&apos;historique (jours)
            <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 110 }} />
          </label>
          <button className="btn" type="submit" disabled={!s?.connected || s?.sync.running || s?.demo}>
            Ré-importer
          </button>
          <span className="note">Amazon limite le débit : quelques minutes à une heure selon le volume. Vous pouvez fermer la page.</span>
        </form>
      </section>
    </>
  );
}
