/**
 * Gestion des dates dans le fuseau du vendeur (Europe/Paris par défaut).
 * Les dates sont stockées en ISO UTC ; les journées sont découpées selon le fuseau configuré.
 */

export interface YMD {
  y: number;
  m: number; // 1-12
  d: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(tz, f);
  }
  return f;
}

/** Composantes date/heure d'un instant dans le fuseau `tz`. */
export function zonedParts(date: Date, tz: string) {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute, s: p.second };
}

/** Décalage (ms) du fuseau par rapport à UTC à un instant donné. */
function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instant UTC correspondant à minuit (début de journée) du jour `ymd` dans le fuseau `tz`. */
export function startOfDay(ymd: YMD, tz: string): Date {
  const guess = Date.UTC(ymd.y, ymd.m - 1, ymd.d);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz); // 2e passe pour les changements d'heure
  return new Date(t);
}

/** Jour calendaire (dans le fuseau) d'un instant. */
export function toYMD(date: Date, tz: string): YMD {
  const p = zonedParts(date, tz);
  return { y: p.y, m: p.m, d: p.d };
}

export function addDays(ymd: YMD, n: number): YMD {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function addMonths(ymd: YMD, n: number): YMD {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1 + n, 1));
  const dim = daysInMonth(t.getUTCFullYear(), t.getUTCMonth() + 1);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: Math.min(ymd.d, dim) };
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function ymdKey(ymd: YMD): string {
  return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
}

export function parseYmdKey(key: string): YMD {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d: d || 1 };
}

/** Clé "YYYY-MM-DD" (jour local) d'une date ISO. */
export function localDayKey(iso: string, tz: string): string {
  return ymdKey(toYMD(new Date(iso), tz));
}

export interface Range {
  from: Date; // inclus
  to: Date; // exclu
}

export function dayRange(ymd: YMD, tz: string): Range {
  return { from: startOfDay(ymd, tz), to: startOfDay(addDays(ymd, 1), tz) };
}

export function monthRange(y: number, m: number, tz: string): Range {
  return { from: startOfDay({ y, m, d: 1 }, tz), to: startOfDay(addMonths({ y, m, d: 1 }, 1), tz) };
}

export function yearRange(y: number, tz: string): Range {
  return { from: startOfDay({ y, m: 1, d: 1 }, tz), to: startOfDay({ y: y + 1, m: 1, d: 1 }, tz) };
}

export const FR_WEEKDAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
export const FR_MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

export function weekdayOf(ymd: YMD): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}

export function formatDayFr(ymd: YMD): string {
  return `${ymd.d} ${FR_MONTHS[ymd.m - 1]} ${ymd.y}`;
}
