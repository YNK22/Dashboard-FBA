# Connecter le dashboard à Amazon (SP-API) — guide pas à pas

Ce guide vous emmène de zéro jusqu'à vos vraies ventes dans le dashboard. Comptez **30 minutes de votre côté**, plus le délai de validation d'Amazon (de quelques heures à quelques jours).

Vous allez récupérer **3 identifiants** :

| Identifiant | Ressemble à | Où le trouver |
|---|---|---|
| `SPAPI_CLIENT_ID` | `amzn1.application-oa2-client.1a2b3c…` | Étape 4 |
| `SPAPI_CLIENT_SECRET` | `amzn1.oa2-cs.v1.9f8e7d…` | Étape 4 |
| `SPAPI_REFRESH_TOKEN` | `Atzr\|IwEBI…` | Étape 5 |

> 🔒 Ces identifiants donnent accès à vos données de vente. Ne les envoyez à personne, ne les mettez jamais dans Git (le fichier `.env` est déjà exclu par `.gitignore`).

---

## Comment ça marche

```
 Seller Central ──(vous autorisez votre propre app)──► refresh token
                                                          │
 Dashboard ──refresh token──► Login with Amazon ──► access token (1 h)
     │                                                    │
     └──────────── appels API avec l'access token ────────┘
         • Orders API v2026-01-01   → commandes, prix, statut
         • Finances API v2024-06-19 → frais réels, remboursements, frais divers
         • Product Fees API v0      → estimation des frais des commandes pas encore réglées
         • FBA Inventory API v1     → stock FBA
         • Fulfillment Inbound v0   → envois FBA (lots d'achat FIFO)
         • Sellers API v1           → test de connexion
```

Vous créez une application **privée** : elle n'est utilisée que par votre propre compte vendeur. Pas besoin de la publier sur l'Appstore Amazon, ni d'un compte AWS (Amazon a supprimé l'obligation de signature AWS en 2023).

---

## Étape 0 — Prérequis

- Un **compte vendeur professionnel** (l'offre Individuel n'a pas accès à l'API).
- Être connecté avec **l'utilisateur principal** du compte (celui qui l'a créé) ou un utilisateur ayant les droits d'administrateur : lui seul peut s'inscrire comme développeur et autoriser une application.
- Sur votre ordinateur : **Node.js 20 ou plus** ([nodejs.org](https://nodejs.org), version LTS).

---

## Étape 1 — Ouvrir l'espace développeur

1. Connectez-vous à **Seller Central** : <https://sellercentral.amazon.fr>
2. Menu ☰ en haut à gauche → **Applications et services** → **Développer des applications**.
   Lien direct : <https://sellercentral.amazon.fr/sellingpartner/developerconsole>
3. Si c'est la première fois, Amazon affiche un bouton **« Accéder au profil développeur »** (*Proceed to Developer Profile*). Cliquez dessus.

> L'interface est parfois en anglais : les noms anglais sont indiqués entre parenthèses.

---

## Étape 2 — Remplir le profil développeur

### 2.1 Type de développeur

Choisissez **« Développeur privé : je développe une ou plusieurs applications pour ma propre entreprise »** (*Private Developer: I build application(s) for my own company only*).

### 2.2 Coordonnées

Nom de l'organisation (votre société), site web (votre site ou votre boutique Amazon), contact technique (vous), adresse.

### 2.3 Accès aux données : les rôles

Cochez **uniquement** ces rôles. Si votre profil est déjà approuvé sans l'un d'eux, ajoutez-le depuis le profil développeur, puis ré-autorisez l'application (étape 5). Sans le rôle *Expédition par Amazon*, le dashboard fonctionne mais sans les pages Stock ni la création automatique des lots.

| Rôle (FR) | Rôle (EN) | Utilisé pour |
|---|---|---|
| ✅ **Finance et comptabilité** | *Finance and Accounting* | Frais Amazon réels, remboursements, abonnement, stockage |
| ✅ **Suivi des stocks et des commandes** | *Inventory and Order Tracking* | Commandes, prix de vente, statuts |
| ✅ **Expédition par Amazon** | *Amazon Fulfillment* | Stock FBA et envois FBA (création automatique des lots d'achat) |
| ✅ **Tarification** | *Pricing* | Estimation des frais (API Product Fees) |

**Ne cochez pas** les rôles « restreints » (adresses des acheteurs, informations fiscales…) : le dashboard n'en a pas besoin, et ils déclenchent un audit de sécurité beaucoup plus long.

### 2.4 Cas d'usage

Amazon demande de décrire ce que fait votre application. Exemple à adapter :

> *Application interne utilisée uniquement par notre entreprise pour suivre nos ventes et notre rentabilité : chiffre d'affaires, frais Amazon, remboursements, bénéfice et marge par produit. Les données sont stockées sur notre propre serveur et ne sont partagées avec aucun tiers.*

### 2.5 Questions de sécurité

Répondez honnêtement. Pour ce dashboard, les réponses habituelles :

- **Partage des données avec des tiers** : non.
- **Stockage** : sur votre ordinateur ou votre propre serveur, accès protégé par mot de passe (`DASHBOARD_PASSWORD`).
- **Données personnelles des clients (PII)** : non collectées. L'application ne demande ni noms, ni adresses, ni e-mails d'acheteurs.
- **Chiffrement** : connexion HTTPS vers Amazon ; disque chiffré conseillé (FileVault / BitLocker / VPS avec disque chiffré).

### 2.6 Envoyer

Validez. Le statut passe à **« En cours d'examen »**. Amazon répond généralement sous **1 à 3 jours ouvrés**, par e-mail et dans cette même page. S'il refuse, il dit pourquoi (souvent une description trop vague) : complétez puis renvoyez.

---

## Étape 3 — Créer l'application

Une fois le profil approuvé, retournez dans **Applications et services → Développer des applications** :

1. Cliquez sur **« Ajouter un nouveau client d'application »** (*Add new app client*).
2. Remplissez :
   - **Nom de l'application** : `Dashboard FBA`
   - **Type d'API** : **SP API**
   - **Type** : **Vendeur** (*Seller*)
   - **Rôles** : cochez les mêmes trois rôles qu'à l'étape 2.3
   - Laissez vides les champs « URI de redirection OAuth » et « URI de connexion » (inutiles pour une application privée).
3. **Enregistrer et quitter**.

---

## Étape 4 — Récupérer le Client ID et le Client Secret

Dans la liste **Développer des applications**, sur la ligne de votre application :

1. Colonne **« Identifiants LWA »** (*LWA credentials*) → cliquez sur **Afficher** (*View*).
2. Copiez :
   - **Identifiant client** (*Client identifier*) → `SPAPI_CLIENT_ID`
   - **Secret client** (*Client secret*) → `SPAPI_CLIENT_SECRET`

---

## Étape 5 — Autoriser l'application et obtenir le refresh token

Toujours sur la ligne de votre application :

1. Cliquez sur la **flèche ▾** à côté de **« Modifier l'application »** (*Edit App*) → **Autoriser** (*Authorize*).
2. Cliquez sur **« Autoriser l'application »** (*Authorize app*).
3. Amazon affiche un **jeton d'actualisation** (*Refresh token*) qui commence par `Atzr|` → c'est `SPAPI_REFRESH_TOKEN`.

> ⚠️ Copiez-le tout de suite : il n'est affiché qu'une fois. Si vous le perdez, refaites cette étape : un nouveau jeton est généré.
>
> ⚠️ Si vous ajoutez un rôle plus tard, vous devez **ré-autoriser** l'application (refaire l'étape 5) pour que le nouveau jeton inclue ce rôle.
>
> Amazon peut demander périodiquement de renouveler l'autorisation (vous êtes prévenu par e-mail / Seller Central) : refaites alors cette étape et remplacez le jeton dans `.env`.

---

## Étape 6 — Configurer le dashboard

> **Vous déployez avec Portainer ?** Mettez ces valeurs dans les *Environment variables* de la stack au lieu d'un fichier `.env`, puis suivez [DEPLOIEMENT-PORTAINER.md](DEPLOIEMENT-PORTAINER.md). Les étapes 7 et 8 se font alors depuis la page **Amazon** du dashboard (boutons **Tester la connexion** et **Ré-importer**).

En local, dans le dossier du projet :

```bash
cp .env.example .env
```

Ouvrez `.env` avec un éditeur de texte et collez vos identifiants :

```ini
SPAPI_CLIENT_ID=amzn1.application-oa2-client.1a2b3c...
SPAPI_CLIENT_SECRET=amzn1.oa2-cs.v1.9f8e7d...
SPAPI_REFRESH_TOKEN=Atzr|IwEBI...
SPAPI_REGION=eu
MARKETPLACES=FR,DE,IT,ES,NL,BE
VAT_REGISTERED=true
```

- **`MARKETPLACES`** : les pays où vous vendez (FR, DE, IT, ES, NL, BE, SE, PL, IE, UK).
- **`VAT_REGISTERED`** : `true` si vous êtes assujetti à la TVA (cas général d'une société) → bénéfice calculé **HT**. `false` si vous êtes en franchise de TVA → la TVA n'est pas récupérable, le bénéfice est calculé **TTC** et la TVA payée sur les frais Amazon est comptée comme un coût.

Les autres réglages sont expliqués dans `.env.example`.

---

## Étape 7 — Tester la connexion

Depuis le dashboard : page **Amazon** → **Tester la connexion**. Ou en ligne de commande :

```bash
npm install
npm run check-amazon
```

Résultat attendu :

```
✅ Identifiants
   présents · région eu · marketplaces FR, DE, IT, ES, NL, BE
✅ Authentification Login with Amazon
   access token obtenu
✅ Compte vendeur (Sellers API)
   vous vendez sur : FR, DE, IT, ES, NL, BE, ...
✅ Commandes (rôle « Suivi des stocks et des commandes »)
   10 commande(s) sur les 3 derniers jours (aperçu limité à 10)
✅ Finances (rôle « Finance et comptabilité »)
   42 transaction(s) sur la première page (7 derniers jours)
```

### En cas d'erreur

| Message | Cause probable | Solution |
|---|---|---|
| `Échec de l'authentification LWA (400/401)` — `invalid_client` | Client ID ou Secret mal copié | Recopiez-les depuis l'étape 4 (attention aux espaces) |
| `invalid_grant` | Refresh token invalide ou révoqué | Refaites l'étape 5 |
| `Accès refusé (403)` sur commandes ou finances | Rôle manquant, ou app pas ré-autorisée après ajout du rôle | Vérifiez les rôles (étape 3) puis refaites l'étape 5 |
| `HTTP 429` | Quota Amazon atteint | Rien à faire : le dashboard patiente et réessaie automatiquement |
| Aucune commande alors que vous avez vendu | Mauvaises marketplaces ou mauvaise région | Vérifiez `MARKETPLACES` et `SPAPI_REGION=eu` |

---

## Étape 8 — Importer vos ventes

Si vous aviez lancé la démo, videz d'abord la base :

```bash
npm run demo -- --clear
```

Puis :

```bash
npm run sync
```

La première synchronisation récupère les `SYNC_INITIAL_DAYS` derniers jours (60 par défaut). Amazon limite le nombre de requêtes (1 page de 100 commandes toutes les 3 minutes une fois les 20 premières pages consommées) : pour quelques milliers de commandes, comptez **quelques minutes à une heure**. C'est à faire une seule fois.

Pour ré-importer une période plus longue : `npm run sync -- --days 180`.

Ensuite, lancez le dashboard :

```bash
npm run build
npm start
```

Ouvrez <http://localhost:3000>. Tant que le serveur tourne, il se synchronise tout seul toutes les `SYNC_INTERVAL_MINUTES` minutes (15 par défaut). Le bouton **↻ Synchroniser** force une mise à jour.

---

## Étape 9 — Saisir vos coûts d'achat

Sans coût d'achat, le dashboard ne peut pas calculer votre bénéfice ni votre ROI. Les produits sans coût sont signalés par **⚠**.

Le coût est calculé en **FIFO par lots**, comme dans Scorasin : chaque vente consomme le lot le plus ancien du SKU.

- **Lots** (page **Coûts**, en haut) : chaque envoi FBA crée automatiquement un lot par SKU (quantité, date). Filtrez sur **Coût à compléter** et saisissez le coût unitaire HT tout compris (achat + prep + transport).
- **Import de lots en CSV** : bouton **⬆ Importer des lots (CSV)**, colonnes `sku;date;quantite;cout_unitaire_ht;envoi_fba`. Les colonnes d'un export Scorasin (`merchant_sku`, `received_at`, `quantity_received`, `unit_cog_ht`, `amazon_shipment_id`, `included_in_fifo`) sont reconnues telles quelles. Avec le n° d'envoi FBA, le coût vient compléter le lot créé automatiquement, sans doublon.
- **Prix par défaut** (page **Coûts**, en bas) : utilisé pour les ventes qu'aucun lot ne couvre, par exemple les ventes antérieures à vos premiers lots. saisissez le prix d'achat unitaire **HT** (TTC si vous n'êtes pas assujetti) et, si besoin, un coût annexe par unité (prep center, transport jusqu'à l'entrepôt Amazon, étiquetage…).
- Ou en masse depuis un tableur exporté en CSV, avec le bouton **⬆ Importer un CSV** de la page Produits (ou en ligne de commande) :

  ```csv
  sku;prix_achat;cout_annexe
  MON-SKU-001;12,50;0,80
  MON-SKU-002;34,90;1,20
  ```

  ```bash
  npm run import-cogs -- prix-achat.csv
  ```

Ajoutez vos dépenses hors Amazon (publicité, logiciels…) dans la page **Dépenses**. Les frais facturés par Amazon (abonnement, stockage, etc.) sont récupérés automatiquement.

---

## Étape 10 — Y accéder depuis votre téléphone

Le dashboard doit tourner sur une machine allumée en permanence pour se synchroniser.

**Option Portainer** : voir [DEPLOIEMENT-PORTAINER.md](DEPLOIEMENT-PORTAINER.md).

**Option A — Votre ordinateur** (le plus simple pour commencer) : `npm start`, puis depuis votre téléphone sur le même Wi-Fi : `http://IP-de-votre-ordinateur:3000`.

**Option B — Un petit serveur (VPS)**, environ 4–6 €/mois (Hetzner, OVH, Scaleway…) avec Docker :

```bash
git clone <votre dépôt> dashboard-fba && cd dashboard-fba
cp .env.example .env    # puis remplissez-le, avec DASHBOARD_PASSWORD obligatoirement
docker compose up -d --build   # les variables sont lues dans .env
```

Mettez-le derrière HTTPS (par exemple [Caddy](https://caddyserver.com) : `caddy reverse-proxy --from dashboard.mondomaine.fr --to localhost:3000`).

> 🔒 Sur un serveur accessible depuis Internet, **définissez toujours `DASHBOARD_PASSWORD`**.

Sur iPhone : Safari → Partager → **Sur l'écran d'accueil**. Sur Android : Chrome → ⋮ → **Ajouter à l'écran d'accueil**. Le dashboard s'ouvre alors comme une application.

---

## Pour aller plus loin

- **Pourquoi les frais sont « estimés » sur les commandes récentes ?** Amazon ne publie les frais réels qu'une fois la commande expédiée et réglée (souvent 24 à 48 h après). En attendant, le dashboard estime les frais à partir de vos ventes précédentes du même produit, ou via l'API Product Fees. Les chiffres se corrigent automatiquement quand les frais réels arrivent.
- **Commandes « en attente »** : Amazon n'indique pas toujours le prix d'une commande en attente de paiement. Le dashboard utilise le dernier prix de vente connu du produit.
- **Vous avez déjà une application SP-API** (repricer, étiquettes, mise en vente…) ? Vous pouvez réutiliser son profil développeur : ajoutez simplement un **nouveau client d'application** « Dashboard FBA » (étape 3) avec les rôles déjà approuvés, puis autorisez-le (étape 5). Avantage : des clés séparées et surtout des **quotas séparés**. Amazon compte les quotas par couple vendeur + application, donc le dashboard ne consommera pas les requêtes de votre repricer.
- **Version des API** : le dashboard utilise les versions actuelles (Orders API v2026-01-01, Finances API v2024-06-19). Les anciennes versions v0 sont dépréciées par Amazon (suppression prévue en 2027).
- Documentation officielle : <https://developer-docs.amazon.com/sp-api/> (rubrique *Register as a private developer* et *Self-authorization*).
