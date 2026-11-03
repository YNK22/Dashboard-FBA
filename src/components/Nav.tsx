"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/commandes", label: "Commandes" },
  { href: "/stock", label: "Stock" },
  { href: "/produits", label: "Coûts" },
  { href: "/depenses", label: "Dépenses" },
  { href: "/connexion", label: "Amazon" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
