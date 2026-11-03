# Déployer le dashboard sur Portainer

Le dashboard est un seul conteneur, avec un volume pour la base SQLite. Il se synchronise tout seul avec Amazon toutes les 15 minutes.

Il y a deux façons de faire :

| | **A. Image prête (recommandé)** | **B. Construction sur le serveur** |
|---|---|---|
| Qui construit l'image ? | GitHub Actions, à chaque push | Votre serveur, à chaque déploiement |
| Fichier de stack | `docker-compose.portainer.yml` | `docker-compose.yml` |
| Ressources serveur | Faibles | ~1,5 Go de RAM pendant le build |
| Mise à jour | « Re-pull image » dans Portainer | « Pull and redeploy » dans Portainer |

Les deux fonctionnent sur des serveurs **x86 (amd64)** et **ARM (arm64, Raspberry Pi 4/5, Oracle Ampere…)**.

---

## Option A — Image publiée sur GitHub (ghcr.io)

### A.1 Vérifier que l'image existe

À chaque push sur GitHub, le workflow **« Image Docker »** (`.github/workflows/docker.yml`) lance les tests, construit l'image et la publie sur :

```
ghcr.io/ynk22/dashboard-fba:latest                                   ← branche principale (main)
ghcr.io/ynk22/dashboard-fba:claude-sales-dashboard-amazon-api-tl99rc ← une branche précise
```

Vérifiez sur GitHub : onglet **Actions** du dépôt (le workflow doit être vert), puis sur votre profil → **Packages** → `dashboard-fba`.

> Tant que le code n'est pas fusionné dans `main`, le tag `latest` n'existe pas : utilisez le tag de la branche dans la stack (`image: ghcr.io/ynk22/dashboard-fba:claude-sales-dashboard-amazon-api-tl99rc`).

### A.2 Donner à Portainer l'accès à l'image (dépôt privé)

Si votre dépôt est privé, l'image l'est aussi. Créez un jeton GitHub en lecture seule :

1. GitHub → photo de profil → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**.
2. Nom : `portainer-ghcr`, expiration au choix, cochez **uniquement `read:packages`**. Générez et copiez le jeton (`ghp_…`).
3. Dans Portainer : **Registries** → **Add registry** → **Custom registry** :
   - Name : `GitHub`
   - Registry URL : `ghcr.io`
   - Authentication : activée · Username : votre identifiant GitHub · Password : le jeton `ghp_…`

> Alternative : rendre le package public (GitHub → Packages → dashboard-fba → Package settings → Change visibility). L'image ne contient aucun secret : vos identifiants Amazon sont dans les variables de la stack, pas dans l'image.

### A.3 Créer la stack

1. Portainer → votre environnement → **Stacks** → **Add stack**.
2. Name : `dashboard-fba`.
3. Build method : **Web editor**. Collez le contenu de [`docker-compose.portainer.yml`](../docker-compose.portainer.yml).
4. Section **Environment variables** → **Advanced mode**, collez puis complétez :

   ```ini
   SPAPI_CLIENT_ID=amzn1.application-oa2-client.xxxxxxxx
   SPAPI_CLIENT_SECRET=amzn1.oa2-cs.v1.xxxxxxxx
   SPAPI_REFRESH_TOKEN=Atzr|xxxxxxxx
   DASHBOARD_PASSWORD=un-mot-de-passe-solide
   MARKETPLACES=FR,DE,IT,ES,NL,BE
   VAT_REGISTERED=true
   HOST_PORT=3000
   ```

   Les autres réglages (`SYNC_INTERVAL_MINUTES`, `SYNC_INITIAL_DAYS`, `FX_RATES`, `TIMEZONE`…) sont optionnels. Ils sont décrits dans [`.env.example`](../.env.example).

5. **Deploy the stack**.

Ouvrez `http://IP-du-serveur:3000`. Le navigateur demande un identifiant (n'importe lequel) et le mot de passe `DASHBOARD_PASSWORD`.

### A.4 Mettre à jour

Quand une nouvelle version est publiée : **Stacks** → `dashboard-fba` → **Editor** → **Update the stack** en cochant **Re-pull image and redeploy**. Vos données (volume) sont conservées.

---

## Option B — Construire l'image sur le serveur depuis le dépôt Git

1. Si le dépôt est privé, créez un jeton GitHub (comme en A.2, mais avec le droit **`repo`**, ou un *fine-grained token* en lecture seule sur ce dépôt : *Contents: Read-only*).
2. Portainer → **Stacks** → **Add stack** → Build method : **Repository** :
   - Repository URL : `https://github.com/YNK22/Dashboard-FBA`
   - Repository reference : `refs/heads/main` (ou `refs/heads/claude/sales-dashboard-amazon-api-tl99rc` tant que ce n'est pas fusionné)
   - Compose path : `docker-compose.yml`
   - Authentication : activée, avec votre identifiant GitHub et le jeton
   - Si votre version de Portainer le propose : **GitOps updates** pour redéployer automatiquement après chaque push.
3. **Environment variables** : les mêmes qu'en A.3.
4. **Deploy the stack**. Le premier build prend quelques minutes.

---

## Après le déploiement

1. Ouvrez la page **Amazon** du dashboard → **Tester la connexion** : chaque étape doit être ✅. Les erreurs sont expliquées dans [GUIDE-CONNEXION-AMAZON.md](GUIDE-CONNEXION-AMAZON.md#en-cas-derreur).
2. La première synchronisation démarre seule environ 10 secondes après le lancement. Elle récupère les 60 derniers jours (`SYNC_INITIAL_DAYS`). Pour remonter plus loin : **Ré-importer l'historique**, par exemple 365 jours.
3. Page **Produits** : saisissez vos prix d'achat, ou **⬆ Importer un CSV** (`sku;prix_achat;cout_annexe`).
4. Suivi : Portainer → **Containers** → `dashboard-fba` → **Logs** (lignes `[sync]`). L'état *healthy* vient du healthcheck `/api/health`.

### Accès depuis l'extérieur (HTTPS)

Ne publiez pas le port 3000 directement sur Internet. Passez par votre reverse proxy :

- **Nginx Proxy Manager** : Proxy Host `fba.mondomaine.fr` → `dashboard-fba:3000` (ou `IP:3000`), avec un certificat SSL Let's Encrypt.
- **Traefik** : décommentez le bloc `labels` / `networks` dans `docker-compose.portainer.yml`, adaptez le domaine et le nom du réseau, puis retirez `ports`.
- **Cloudflare Tunnel** ou **Tailscale** : aucun port à ouvrir. Tailscale est idéal si vous seul y accédez.

Gardez toujours `DASHBOARD_PASSWORD` défini.

### Sauvegarde

Tout (commandes, frais, prix d'achat, dépenses) est dans le volume `dashboard-fba_dashboard-fba-data`, fichier `dashboard.db`. Les ventes peuvent toujours être ré-importées depuis Amazon, mais **vos prix d'achat et vos dépenses n'existent que là**. Pensez à le sauvegarder, par exemple :

```bash
docker run --rm -v dashboard-fba_dashboard-fba-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/dashboard-fba-$(date +%F).tar.gz -C /data .
```

### Utiliser les scripts en ligne de commande

L'image de production ne contient que le serveur. Tout se fait depuis l'interface (page **Amazon**, import CSV). Si vous voulez les scripts (`npm run sync`, `npm run check-amazon`…), lancez-les depuis une copie du dépôt sur votre machine.
