"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/commandes", label: "Commandes" },
  { href: "/scraping", label: "Scraping" },
  { href: "/stock", label: "Stock" },
  { href: "/produits", label: "Coûts" },
  { href: "/depenses", label: "Dépenses" },
  { href: "/connexion", label: "Amazon" },
];

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

/** Menu du haut (ordinateur et tablette). */
export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={isActive(path, l.href) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

/* ---------- Barre d'onglets du bas (téléphone) ---------- */

const TABS = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/commandes", label: "Commandes", icon: "🧾" },
  { href: "/scraping", label: "Scraping", icon: "🔎" },
  { href: "/produits", label: "Coûts", icon: "💶" },
];
const MORE = [
  { href: "/stock", label: "Stock", icon: "📦" },
  { href: "/depenses", label: "Dépenses", icon: "🧮" },
  { href: "/connexion", label: "Amazon", icon: "⚙️" },
];

export function MobileNav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const moreActive = MORE.some((l) => isActive(path, l.href));

  return (
    <>
      {open && (
        <div className="more-backdrop" onClick={() => setOpen(false)}>
          <div className="more-sheet" onClick={(e) => e.stopPropagation()}>
            {MORE.map((l) => (
              <Link key={l.href} href={l.href} aria-current={isActive(path, l.href) ? "page" : undefined}>
                <span aria-hidden>{l.icon}</span> {l.label}
              </Link>
            ))}
          </div>
        </div>
      )}
      <nav className="mobile-nav" aria-label="Navigation">
        {TABS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={isActive(path, l.href) ? "page" : undefined}>
            <span className="tab-icon" aria-hidden>
              {l.icon}
            </span>
            <span className="tab-label">{l.label}</span>
          </Link>
        ))}
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-current={moreActive ? "page" : undefined}>
          <span className="tab-icon" aria-hidden>
            ☰
          </span>
          <span className="tab-label">Plus</span>
        </button>
      </nav>
    </>
  );
}
