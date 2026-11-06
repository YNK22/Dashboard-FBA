import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 est un module natif : il doit rester côté serveur, non bundlé.
  serverExternalPackages: ["better-sqlite3"],
  output: "standalone",
  experimental: {
    // Import de flux produits (Scraping) : le corps passe par le proxy (mot de passe), limité à 10 Mo par défaut
    proxyClientMaxBodySize: "200mb",
  },
};

export default nextConfig;
