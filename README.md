# Run & Bike Trainer API

Backend Node.js / Express qui gère la connexion OAuth Strava, stocke les tokens
et synchronise les activités (vélo + course) pour l'app Run & Bike Trainer.

## Architecture de stockage

Le service tourne sur le free tier de Render, qui efface le disque local à
chaque mise en veille (après 15 min d'inactivité). Pour ne pas perdre les
tokens Strava à chaque réveil, ils sont stockés dans un **repo GitHub privé**
(`gravel-trainer-data`) via l'API GitHub — le même pattern que celui utilisé
pour FlowPilot Studio (fetch SHA -> PUT base64).

Ce choix évite tout coût d'hébergement : pas de carte bancaire, pas de volume
payant, juste un repo GitHub privé gratuit qui sert de petite base de données.

## Développement local

```bash
npm install
cp .env.example .env
# Remplis STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET et les variables GITHUB_STORAGE_*
node index.js
```

Le serveur démarre sur http://localhost:3000

Avant de lancer en local :
1. Crée un repo **privé** vide sur GitHub nommé `gravel-trainer-data`
   (juste vide, pas besoin de fichiers dedans, le backend les créera)
2. Génère un Personal Access Token classic sur
   https://github.com/settings/tokens avec le scope `repo` uniquement
3. Mets ce token dans `GITHUB_STORAGE_TOKEN` dans ton `.env`

Pour tester le flow OAuth en local, configure temporairement dans Strava
(https://www.strava.com/settings/api) :
- Authorization Callback Domain : `localhost`

Puis va sur http://localhost:3000/auth/strava dans ton navigateur.

## Déploiement sur Render

1. Crée un compte Render (gratuit, sans carte bancaire) sur render.com,
   connecte ton GitHub (Jeremy1277)
2. New > Web Service, sélectionne le repo `run-and-bike-trainer-api`
   (Render détecte automatiquement `render.yaml`)
3. Dans Settings > Environment, ajoute les variables :
   - `STRAVA_CLIENT_ID`
   - `STRAVA_CLIENT_SECRET`
   - `FRONTEND_URL` (ex: https://jeremy1277.github.io/gravel-trainer)
   - `BACKEND_URL` (l'URL Render donnée après le premier déploiement,
     ex: https://run-and-bike-trainer-api.onrender.com)
   - `GITHUB_STORAGE_TOKEN` (le PAT créé plus haut)
   - `GITHUB_STORAGE_OWNER` = Jeremy1277
   - `GITHUB_STORAGE_REPO` = gravel-trainer-data
   - `GITHUB_STORAGE_BRANCH` = main
4. Dans Strava (https://www.strava.com/settings/api), mets à jour
   "Authorization Callback Domain" avec le domaine Render (sans https://, sans path)
   ex: `run-and-bike-trainer-api.onrender.com`

## Limite du free tier Render à connaître

Le service free se met en veille après 15 minutes sans trafic, et le réveil
prend environ 1 minute. Pour ton usage (1-2 syncs par semaine après une
sortie), c'est sans conséquence : tu attends une minute la première fois,
puis le service reste réactif pendant ta session.

## Routes disponibles

| Route | Description |
|---|---|
| `GET /auth/strava` | Démarre la connexion OAuth, redirige vers Strava |
| `GET /callback` | Callback Strava, échange le code, stocke les tokens |
| `GET /api/status` | Indique si un compte Strava est connecté |
| `GET /api/sync` | Récupère toutes les activités depuis Strava et les stocke |
| `GET /api/activities` | Renvoie les activités stockées (rapide, pas d'appel Strava) |
| `GET /api/activities/:id` | Détail d'une activité (zones, streams) |

## Notes

- Le rate limit Strava est de 200 requêtes / 15 min et 2000 / jour. Le flow
  prévu (sync manuel ou sync 1x/jour) reste très loin de ces limites.
- Le rate limit GitHub API est de 5000 requêtes/heure pour un token
  authentifié — largement suffisant pour ce volume d'écriture/lecture.
- `/api/sync` doit être appelé après chaque sortie pour rafraîchir les données ;
  on pourra automatiser ça plus tard (cron, ou bouton "Sync" dans le frontend).

