import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, extractLinks, extractProduct, isValidEan, normalizeEan, parseRobots, parseSitemap, robotsAllows } from "../src/lib/scraper/extract";
import { urlFilter } from "../src/lib/scraper/run";

test("entités HTML accentuées", () => {
  assert.equal(decodeEntities("Cl&eacute; m&acirc;le &Agrave; &ccedil;a &amp; &#233;t&eacute; &rsquo;"), "Clé mâle À ça & été ’");
});

test("EAN : clé de contrôle", () => {
  assert.equal(isValidEan("3148511238257"), true);
  assert.equal(isValidEan("3148511238258"), false);
  assert.equal(isValidEan("4902505106446"), true);
  assert.equal(normalizeEan("03148511238257"), "3148511238257"); // GTIN-14 avec 0 en tête
  assert.equal(normalizeEan("abc"), null);
});

test("fiche produit JSON-LD : titre, EAN, prix, URL canonique", () => {
  const html = `<html><head><link rel="canonical" href="/p/cle-facom-6mm">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},
      {"@type":"Product","name":"Facom Clé m&acirc;le 6 mm","gtin13":"3148511238257","sku":"X1",
       "offers":{"@type":"Offer","price":"12,90","priceCurrency":"EUR"}}]}</script></head><body></body></html>`;
  const p = extractProduct(html, "https://shop.example/p/cle-facom-6mm?utm_source=x");
  assert.deepEqual(p, { title: "Facom Clé mâle 6 mm", ean: "3148511238257", price: 12.9, currency: "EUR", url: "https://shop.example/p/cle-facom-6mm" });
});

test("EAN dans le SKU, offres multiples (AggregateOffer)", () => {
  const html = `<script type="application/ld+json">[{"@type":["Product"],"name":"Stylo Pilot","sku":"4902505106446",
    "offers":{"@type":"AggregateOffer","lowPrice":3.5,"priceCurrency":"EUR"}}]</script>`;
  const p = extractProduct(html, "https://shop.example/stylo");
  assert.equal(p?.ean, "4902505106446");
  assert.equal(p?.price, 3.5);
});

test("microdonnées et Open Graph quand il n'y a pas de JSON-LD", () => {
  const html = `<meta property="og:type" content="product"><meta property="og:title" content="Bouchon de baignoire">
    <div itemscope itemtype="https://schema.org/Product"><span itemprop="gtin13" content="5060134334285"></span>
    <meta itemprop="price" content="8.95"></div>`;
  const p = extractProduct(html, "https://shop.example/bouchon");
  assert.equal(p?.title, "Bouchon de baignoire");
  assert.equal(p?.ean, "5060134334285");
  assert.equal(p?.price, 8.95);
});

test("page qui n'est pas une fiche produit : null", () => {
  assert.equal(extractProduct("<html><title>Catégorie bricolage</title><a href='/p/1'>x</a></html>", "https://shop.example/c/bricolage"), null);
});

test("liens internes seulement, sans fragments, fichiers ni paramètres de suivi", () => {
  const html = `<a href="/p/1#avis">1</a><a href="https://www.shop.example/p/2?utm_source=fb">2</a><a href="https://autre.fr/x">x</a>
    <a href="/img/a.jpg">img</a><a href="mailto:a@b.fr">m</a><a href="/c/bricolage?page=2">page 2</a>`;
  assert.deepEqual(extractLinks(html, "https://shop.example/c/"), [
    "https://shop.example/p/1",
    "https://www.shop.example/p/2",
    "https://shop.example/c/bricolage?page=2",
  ]);
});

test("sitemap : index et URLs", () => {
  assert.deepEqual(parseSitemap(`<sitemapindex><sitemap><loc>https://s.fr/sm-1.xml</loc></sitemap></sitemapindex>`), { sitemaps: ["https://s.fr/sm-1.xml"], urls: [] });
  assert.deepEqual(parseSitemap(`<urlset><url><loc>https://s.fr/p/1?a=1&amp;b=2</loc></url></urlset>`).urls, ["https://s.fr/p/1?a=1&b=2"]);
});

test("robots.txt : règles du groupe *, Allow plus précis, sitemaps, délai", () => {
  const r = parseRobots(`User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /panier\nDisallow: /*?filtre=\nAllow: /panier/aide\nCrawl-delay: 2\nSitemap: https://s.fr/sitemap.xml`);
  assert.deepEqual(r.sitemaps, ["https://s.fr/sitemap.xml"]);
  assert.equal(r.crawlDelay, 2);
  assert.equal(robotsAllows(r, "https://s.fr/p/1"), true);
  assert.equal(robotsAllows(r, "https://s.fr/panier/123"), false);
  assert.equal(robotsAllows(r, "https://s.fr/panier/aide"), true);
  assert.equal(robotsAllows(r, "https://s.fr/c/x?filtre=rouge"), false);
});

test("filtre d'URL produit : texte simple ou expression régulière", () => {
  assert.equal(urlFilter("/produit/")("https://s.fr/produit/abc"), true);
  assert.equal(urlFilter("-p\\d+\\.html$")("https://s.fr/cle-p123.html"), true);
  assert.equal(urlFilter("-p\\d+\\.html$")("https://s.fr/cle.html"), false);
  assert.equal(urlFilter("")("https://s.fr/x"), true);
});

test("page anti-robots détectée, vraie page non", async () => {
  const { isBotChallenge } = await import("../src/lib/scraper/extract");
  assert.equal(isBotChallenge("<html><title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/x.js'></script></html>"), true);
  assert.equal(isBotChallenge("<!doctype html><html><head><title>Cdiscount</title><script>var x=1</script></head><body><a href='/'>x</a></body></html>"), true);
  const real = `<html><a href="/c/1">1</a><a href="/c/2">2</a><a href="/p/3">3</a><script>analytics()</script></html>`;
  assert.equal(isBotChallenge(real), false);
});

test("page normale avec reCAPTCHA (newsletter) ou script DataDome : pas une page anti-robots", async () => {
  const { isBotChallenge } = await import("../src/lib/scraper/extract");
  const page = `<html><script src="https://js.datadome.co/tags.js"></script><a href="/c/1">1</a><a href="/c/2">2</a>
    <form><div class="g-recaptcha"></div></form></html>`;
  assert.equal(isBotChallenge(page), false);
});
