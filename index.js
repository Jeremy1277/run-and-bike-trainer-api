require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://jeremy1277.github.io/run-and-bike-trainer';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

// --- Coach IA (Claude API) ---
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// --- Stockage : repo GitHub privé (Render efface le disque local à chaque mise en veille) ---
const GITHUB_TOKEN = process.env.GITHUB_STORAGE_TOKEN; // PAT avec scope "repo"
const GITHUB_OWNER = process.env.GITHUB_STORAGE_OWNER || 'Jeremy1277';
const GITHUB_REPO = process.env.GITHUB_STORAGE_REPO || 'run-and-bike-trainer-data';
const GITHUB_BRANCH = process.env.GITHUB_STORAGE_BRANCH || 'main';

const githubApi = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
  },
});

// Lit un fichier JSON depuis le repo de stockage. Renvoie fallback si le fichier n'existe pas encore.
async function readJSON(filePath, fallback) {
  try {
    const res = await githubApi.get(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
      { params: { ref: GITHUB_BRANCH } }
    );
    const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err.response?.status === 404) return fallback;
    throw err;
  }
}

// Écrit un fichier JSON dans le repo de stockage (pattern fetch SHA -> PUT base64).
async function writeJSON(filePath, data) {
  let sha;
  try {
    const existing = await githubApi.get(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
      { params: { ref: GITHUB_BRANCH } }
    );
    sha = existing.data.sha;
  } catch (err) {
    if (err.response?.status !== 404) throw err;
  }

  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  await githubApi.put(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`, {
    message: `Update ${filePath}`,
    content,
    branch: GITHUB_BRANCH,
    sha,
  });
}

const TOKENS_FILE = 'tokens.json';
const ACTIVITIES_FILE = 'activities.json';
const EXCLUDED_FILE = 'excluded_activities.json';
const COACH_FILE = 'coach_advice.json';
const DATE_OVERRIDES_FILE = 'date_overrides.json';

function getTokens() {
  return readJSON(TOKENS_FILE, null);
}

function saveTokens(tokens) {
  return writeJSON(TOKENS_FILE, tokens);
}

// --- Rafraîchit l'access_token si nécessaire (expire après 6h) ---
async function getValidAccessToken() {
  const tokens = await getTokens();
  if (!tokens) {
    throw new Error('NOT_CONNECTED');
  }

  const now = Math.floor(Date.now() / 1000);
  if (tokens.expires_at && tokens.expires_at > now + 60) {
    return tokens.access_token;
  }

  // Token expiré ou proche de l'expiration -> refresh
  const response = await axios.post('https://www.strava.com/oauth/token', {
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });

  const newTokens = {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token,
    expires_at: response.data.expires_at,
    athlete: tokens.athlete,
  };
  await saveTokens(newTokens);
  return newTokens.access_token;
}

// --- Route 1 : démarre le flow OAuth ---
app.get('/auth/strava', (req, res) => {
  const redirectUri = `${BACKEND_URL}/callback`;
  const scope = 'read,activity:read_all,profile:read_all';
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&approval_prompt=auto&scope=${scope}`;
  res.redirect(authUrl);
});

// --- Route 2 : callback Strava, échange le code contre les tokens ---
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${FRONTEND_URL}?strava_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.status(400).send('Code OAuth manquant');
  }

  try {
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });

    const tokens = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_at: response.data.expires_at,
      athlete: response.data.athlete,
    };
    await saveTokens(tokens);

    res.redirect(`${FRONTEND_URL}?connected=true`);
  } catch (err) {
    console.error('Erreur échange token:', err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}?strava_error=token_exchange_failed`);
  }
});

// --- Route 3 : statut de connexion ---
app.get('/api/status', async (req, res) => {
  try {
    const tokens = await getTokens();
    res.json({
      connected: !!tokens,
      athlete: tokens?.athlete
        ? { id: tokens.athlete.id, firstname: tokens.athlete.firstname, lastname: tokens.athlete.lastname }
        : null,
    });
  } catch (err) {
    console.error('Erreur status:', err.response?.data || err.message);
    res.status(500).json({ error: 'status_failed' });
  }
});

// --- Route 4 : synchronise les activités depuis Strava ---
app.get('/api/sync', async (req, res) => {
  try {
    const accessToken = await getValidAccessToken();
    const perPage = 100;
    let page = 1;
    let allActivities = [];

    while (true) {
      const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { per_page: perPage, page },
      });

      if (response.data.length === 0) break;
      allActivities = allActivities.concat(response.data);
      if (response.data.length < perPage) break;
      page++;
      if (page > 20) break; // garde-fou
    }

    await writeJSON(ACTIVITIES_FILE, { last_sync: new Date().toISOString(), activities: allActivities });

    res.json({ synced: allActivities.length, last_sync: new Date().toISOString() });

    // Génère les conseils coach en arrière-plan, sans bloquer la réponse du sync.
    // Ne fait planter rien si ça échoue (ex: clé API manquante) — juste loggé.
    generateCoachAdvice(allActivities).catch((err) => {
      console.error('Coach (arrière-plan) — erreur non bloquante:', err.response?.data || err.message);
    });
  } catch (err) {
    if (err.message === 'NOT_CONNECTED') {
      return res.status(401).json({ error: 'not_connected' });
    }
    console.error('Erreur sync:', err.response?.data || err.message);
    res.status(500).json({ error: 'sync_failed' });
  }
});

// --- Route 5 : sert les activités stockées au frontend ---
app.get('/api/activities', async (req, res) => {
  try {
    const data = await readJSON(ACTIVITIES_FILE, { last_sync: null, activities: [] });
    res.json(data);
  } catch (err) {
    console.error('Erreur lecture activités:', err.response?.data || err.message);
    res.status(500).json({ error: 'read_failed' });
  }
});

// --- Route 6 : détail d'une activité (zones FC, streams) ---
app.get('/api/activities/:id', async (req, res) => {
  try {
    const accessToken = await getValidAccessToken();
    const response = await axios.get(
      `https://www.strava.com/api/v3/activities/${req.params.id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    res.json(response.data);
  } catch (err) {
    if (err.message === 'NOT_CONNECTED') {
      return res.status(401).json({ error: 'not_connected' });
    }
    console.error('Erreur détail activité:', err.response?.data || err.message);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

// --- Route 7 : exclure une activité de l'analyse (doublon GPS/Strava, etc.) ---
app.post('/api/activities/:id/exclude', async (req, res) => {
  try {
    const excluded = await readJSON(EXCLUDED_FILE, { ids: [] });
    const id = Number(req.params.id);
    if (!excluded.ids.includes(id)) excluded.ids.push(id);
    await writeJSON(EXCLUDED_FILE, excluded);
    res.json({ excluded: excluded.ids });
  } catch (err) {
    console.error('Erreur exclusion:', err.response?.data || err.message);
    res.status(500).json({ error: 'exclude_failed' });
  }
});

// --- Route 8 : ré-inclure une activité précédemment exclue ---
app.post('/api/activities/:id/include', async (req, res) => {
  try {
    const excluded = await readJSON(EXCLUDED_FILE, { ids: [] });
    const id = Number(req.params.id);
    excluded.ids = excluded.ids.filter((x) => x !== id);
    await writeJSON(EXCLUDED_FILE, excluded);
    res.json({ excluded: excluded.ids });
  } catch (err) {
    console.error('Erreur ré-inclusion:', err.response?.data || err.message);
    res.status(500).json({ error: 'include_failed' });
  }
});

// --- Route 9 : liste des activités exclues ---
app.get('/api/excluded', async (req, res) => {
  try {
    const excluded = await readJSON(EXCLUDED_FILE, { ids: [] });
    res.json(excluded);
  } catch (err) {
    console.error('Erreur lecture exclusions:', err.response?.data || err.message);
    res.status(500).json({ error: 'read_failed' });
  }
});

// --- Corrections de date locales : Strava n'expose pas de modification de start_date via API,
// donc on stocke une surcharge côté backend, appliquée uniquement à l'affichage/aux calculs. ---
app.post('/api/activities/:id/date', async (req, res) => {
  try {
    const { date } = req.body;
    if (!date || isNaN(new Date(date).getTime())) {
      return res.status(400).json({ error: 'invalid_date' });
    }
    const overrides = await readJSON(DATE_OVERRIDES_FILE, {});
    overrides[req.params.id] = date;
    await writeJSON(DATE_OVERRIDES_FILE, overrides);
    res.json({ id: req.params.id, date });
  } catch (err) {
    console.error('Erreur correction de date:', err.response?.data || err.message);
    res.status(500).json({ error: 'date_override_failed' });
  }
});

app.delete('/api/activities/:id/date', async (req, res) => {
  try {
    const overrides = await readJSON(DATE_OVERRIDES_FILE, {});
    delete overrides[req.params.id];
    await writeJSON(DATE_OVERRIDES_FILE, overrides);
    res.json({ id: req.params.id });
  } catch (err) {
    console.error('Erreur suppression correction de date:', err.response?.data || err.message);
    res.status(500).json({ error: 'date_override_failed' });
  }
});

app.get('/api/date-overrides', async (req, res) => {
  try {
    const overrides = await readJSON(DATE_OVERRIDES_FILE, {});
    res.json(overrides);
  } catch (err) {
    console.error('Erreur lecture corrections de date:', err.response?.data || err.message);
    res.status(500).json({ error: 'read_failed' });
  }
});

// --- Construit un résumé compact des données pour limiter les tokens envoyés à Claude ---
function buildAthleteSummary(activities, excludedIds) {
  const usable = activities.filter((a) => !excludedIds.includes(a.id));

  const bySport = { Ride: [], Run: [] };
  usable.forEach((a) => {
    const sport = a.type === 'Run' ? 'Run' : a.type === 'Ride' ? 'Ride' : null;
    if (sport) bySport[sport].push(a);
  });

  function summarizeSport(arr) {
    const sorted = [...arr].sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
    const last10 = sorted.slice(0, 10).map((a) => ({
      date: a.start_date.slice(0, 10),
      nom: a.name,
      distance_km: +(a.distance / 1000).toFixed(1),
      d_plus_m: Math.round(a.total_elevation_gain || 0),
      duree_min: Math.round(a.moving_time / 60),
      vitesse_moy_kmh: +((a.average_speed || 0) * 3.6).toFixed(1),
      fc_moy: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      fc_max: a.max_heartrate ? Math.round(a.max_heartrate) : null,
    }));
    return { nombre_total: arr.length, dix_dernieres_sorties: last10 };
  }

  return {
    velo: summarizeSport(bySport.Ride),
    course: summarizeSport(bySport.Run),
  };
}

// --- Génère les conseils coach via Claude pour UN sport donné, en sortie JSON structurée. ---
async function generateCoachAdviceForSport(sport, activities, completedSeanceIds) {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY manquante côté serveur.');
  }

  const excluded = await readJSON(EXCLUDED_FILE, { ids: [] });
  const fullSummary = buildAthleteSummary(activities || [], excluded.ids || []);
  const sportData = sport === 'velo' ? fullSummary.velo : fullSummary.course;

  const sportLabel = sport === 'velo' ? 'cyclisme gravel' : 'course à pied';
  const contextNote = sport === 'velo'
    ? 'Point faible identifié : grosse perte de vitesse dès que ça grimpe (FC qui sature en montée), bonne aisance sur plat/descente.'
    : 'Prépare un semi-marathon en octobre 2026, 2 sorties par semaine actuellement.';

  const speedHint = sport === 'velo'
    ? 'vitesse en km/h (ex: 16-18 km/h en montée, 25-28 km/h sur plat)'
    : 'allure en min/km (ex: 6:30-7:00 min/km en endurance, 5:30 min/km en seuil)';

  const prompt = `Tu es un coach sportif expérimenté, spécialisé en ${sportLabel} pour adultes amateurs reprenant une pratique régulière. Ton coaching doit être chiffré et exécutable sur le terrain — jamais une généralité du type "sortie facile" sans dire combien de temps, combien de km, à quelle FC et à quel rythme exactement.

Profil de l'athlète : 48 ans, 85 kg, pratique depuis mars 2026 (quasi débutant avant). ${contextNote}

Voici ses dernières sorties ${sportLabel} (JSON, avec distance, D+, durée, vitesse moyenne et FC moyenne/max par sortie) :
${JSON.stringify(sportData, null, 2)}

Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après, sans balises markdown, selon ce schéma exact :
{
  "constat": "3-4 phrases factuelles en français, tutoiement, sur la tendance récente observée dans les données, avec au moins un chiffre concret tiré des sorties (ex: ta FC moyenne est passée de X à Y bpm)",
  "seances": [
    {
      "titre": "Titre court de la séance (ex: Sortie seuil en côte)",
      "type_terrain": "plat" | "vallonne" | "montagneux",
      "duree_min": nombre en minutes,
      "distance_cible_km": nombre, distance totale visée pour toute la séance, déduite de la durée et d'une allure réaliste pour cet athlète,
      "zone_fc_cible": "ex: Z3 (138-155 bpm)",
      "objectif": "1 phrase expliquant pourquoi cette séance maintenant",
      "explication": "4-6 phrases en tutoiement expliquant le déroulé de la séance, pourquoi cette structure compte tenu de ses données récentes, et comment ajuster en temps réel si la FC dérive au-dessus ou en-dessous de la cible",
      "blocs": [
        {
          "phase": "Échauffement",
          "duree_min": nombre,
          "distance_km": nombre approximatif,
          "zone_fc": "ex: Z1-Z2 (100-120 bpm)",
          "rythme_cible": "${speedHint}",
          "description": "ce qu'il faut faire pendant ce bloc, en une phrase concrète et actionnable"
        }
      ]
    }
  ],
  "vigilance": "1-2 phrases sur un point de vigilance (surcharge, récupération, risque), avec un chiffre si pertinent (ex: ta FC moyenne dépasse Z4 sur 60% du temps de tes 3 dernières sorties), ou null si rien à signaler"
}

Chaque bloc doit avoir : sa durée en minutes, sa distance approximative en km, sa zone de FC avec les bpm exacts (déduits des données de fréquence cardiaque déjà observées chez cet athlète, pas des zones théoriques génériques), et son rythme cible (vitesse km/h pour le vélo, allure min/km pour la course). Découpe en étapes chronologiques réelles : échauffement, puis répétitions d'efforts si pertinent avec leurs récup intercalées, puis retour au calme. La somme des duree_min et distance_km des blocs doit être cohérente avec duree_min et distance_cible_km de la séance globale. Adapte le nombre de blocs à la séance (une sortie d'endurance longue peut n'avoir que 2-3 blocs, une séance de fractionné peut en avoir 6-8 en répétant le motif effort/récup).

Propose entre 2 et 4 séances, dans un ordre logique de progression (la première à faire en premier). Reste factuel et basé sur les données fournies — utilise les vraies FC et vitesses déjà observées chez cet athlète pour calibrer tes cibles, ne sors pas des zones FC standard de manuel si les données montrent un profil différent. Si les données sont insuffisantes, dis-le dans le constat plutôt que d'inventer, et propose des séances prudentes avec des chiffres de débutant raisonnables (FC sous 140 bpm, allure très modérée).`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const rawText = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  let parsed;
  try {
    // Au cas où Claude entoure malgré tout sa réponse de ```json ... ```
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Réponse du coach IA non parsable en JSON: ${e.message}`);
  }

  // ID stable basé sur le contenu (sport + titre + terrain), pas sur l'horodatage :
  // ainsi, si le coach repropose une séance similaire après un sync, son état "fait"
  // précédent est retrouvé au lieu d'être perdu à chaque régénération automatique.
  function stableId(sport, titre, terrain) {
    const raw = `${sport}::${titre}::${terrain}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = (hash << 5) - hash + raw.charCodeAt(i);
      hash |= 0;
    }
    return `${sport}-${Math.abs(hash)}`;
  }

  const seances = (parsed.seances || []).map((s) => {
    const id = stableId(sport, s.titre, s.type_terrain);
    return {
      id,
      done: !!completedSeanceIds?.[id],
      ...s,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    constat: parsed.constat || '',
    seances,
    vigilance: parsed.vigilance || null,
  };
}

// --- Génère et sauvegarde les conseils pour les deux sports. Réutilisée par le sync auto et la route manuelle. ---
async function generateCoachAdvice(activities) {
  const existing = await readJSON(COACH_FILE, { velo: null, course: null, seances_status: {} });
  const status = existing.seances_status || {};

  const [veloAdvice, courseAdvice] = await Promise.all([
    generateCoachAdviceForSport('velo', activities, status).catch((err) => {
      console.error('Coach vélo — erreur:', err.message);
      return null;
    }),
    generateCoachAdviceForSport('course', activities, status).catch((err) => {
      console.error('Coach course — erreur:', err.message);
      return null;
    }),
  ]);

  const result = {
    velo: veloAdvice,
    course: courseAdvice,
    seances_status: status,
  };

  await writeJSON(COACH_FILE, result);
  return result;
}

// --- Route 10 : génère (ou régénère) les conseils du coach IA manuellement, pour les deux sports ---
app.post('/api/coach/generate', async (req, res) => {
  try {
    const data = await readJSON(ACTIVITIES_FILE, { activities: [] });
    const advice = await generateCoachAdvice(data.activities || []);
    if (!advice.velo && !advice.course) {
      return res.status(503).json({ error: 'coach_not_configured', message: 'ANTHROPIC_API_KEY manquante ou erreur de génération côté serveur.' });
    }
    res.json(advice);
  } catch (err) {
    if (err.message?.includes('ANTHROPIC_API_KEY')) {
      return res.status(503).json({ error: 'coach_not_configured', message: err.message });
    }
    console.error('Erreur coach:', err.response?.data || err.message);
    res.status(500).json({ error: 'coach_failed' });
  }
});

// --- Route 11 : récupère les derniers conseils générés (sans relancer Claude) ---
app.get('/api/coach', async (req, res) => {
  try {
    const advice = await readJSON(COACH_FILE, null);
    res.json(advice || { velo: null, course: null, seances_status: {} });
  } catch (err) {
    console.error('Erreur lecture coach:', err.response?.data || err.message);
    res.status(500).json({ error: 'read_failed' });
  }
});

// --- Route 12 : marque une séance comme faite / pas faite (persisté pour survivre aux régénérations) ---
app.post('/api/coach/seance/:id/toggle', async (req, res) => {
  try {
    const advice = await readJSON(COACH_FILE, { velo: null, course: null, seances_status: {} });
    const id = req.params.id;
    const status = advice.seances_status || {};
    status[id] = !status[id];

    ['velo', 'course'].forEach((sport) => {
      if (advice[sport]?.seances) {
        advice[sport].seances = advice[sport].seances.map((s) =>
          s.id === id ? { ...s, done: status[id] } : s
        );
      }
    });

    advice.seances_status = status;
    await writeJSON(COACH_FILE, advice);
    res.json({ id, done: status[id] });
  } catch (err) {
    console.error('Erreur toggle séance:', err.response?.data || err.message);
    res.status(500).json({ error: 'toggle_failed' });
  }
});

app.get('/', (req, res) => {
  res.send('Run & Bike Trainer API — OK');
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
