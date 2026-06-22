require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://jeremy1277.github.io/gravel-trainer';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

// --- Stockage : repo GitHub privé (Render efface le disque local à chaque mise en veille) ---
const GITHUB_TOKEN = process.env.GITHUB_STORAGE_TOKEN; // PAT avec scope "repo"
const GITHUB_OWNER = process.env.GITHUB_STORAGE_OWNER || 'Jeremy1277';
const GITHUB_REPO = process.env.GITHUB_STORAGE_REPO || 'gravel-trainer-data';
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

app.get('/', (req, res) => {
  res.send('Gravel Trainer API — OK');
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
