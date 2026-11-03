import type { Metadata, Viewport } from "next";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dashboard FBA",
  description: "Ventes et rentabilité Amazon FBA : CA TTC/HT, bénéfice, marge, ROI",
  icons: { icon: "/icon.svg" },
  appleWebApp: { capable: true, title: "Dashboard FBA", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef1f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1216" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <span className="brand">📦 Dashboard FBA</span>
            <Nav />
          </div>
        </header>
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
