const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const eur0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("fr-FR");
const pct1 = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1 });
const pct0 = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });

const clean = (n: number) => Math.round(n * 100) / 100 || 0; // évite "-0,00 €"
export const fmtEur = (n: number) => eur.format(clean(n));
export const fmtEur0 = (n: number) => eur0.format(n);
export const fmtInt = (n: number) => int.format(n);
export const fmtPct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : pct1.format(n));
export const fmtPct0 = (n: number | null | undefined) => (n === null || n === undefined ? "—" : pct0.format(n));

/** Sépare "2 011,41 €" en partie entière / décimales pour l'affichage "hero". */
export function splitEur(n: number): { whole: string; cents: string } {
  const s = eur.format(n);
  const m = s.match(/^(.*?)(,\d{2})(\s?€)$/);
  return m ? { whole: m[1], cents: `${m[2]}${m[3]}` } : { whole: s, cents: "" };
}

export function signClass(n: number): string {
  return n > 0.004 ? "pos" : n < -0.004 ? "neg" : "";
}

export function compactEur(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return `${(n / 1000).toLocaleString("fr-FR", { maximumFractionDigits: a >= 10000 ? 0 : 1 })} k€`;
  return `${Math.round(n)} €`;
}
