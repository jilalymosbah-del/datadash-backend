const express = require('express');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
const router  = express.Router();

const META_APP_ID     = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const REDIRECT_URI = process.env.META_REDIRECT_URI || 'http://localhost:3001/api/meta/callback';
// Stockage temporaire des states et tokens
const oauthStates = {};
const metaTokens  = {};

// ── 1. Initier le flux OAuth Meta ──
router.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates[state] = { createdAt: Date.now() };

  const authUrl = 'https://www.facebook.com/v18.0/dialog/oauth?' +
    `client_id=${META_APP_ID}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `state=${state}&` +
    `scope=ads_read,ads_management,business_management`;

  res.redirect(authUrl);
});

// ── 2. Callback OAuth Meta ──
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send(`<html><body><script>
      if(window.opener) { window.opener.postMessage({type:'META_ERROR',error:'${error}'},'*'); window.close(); }
    </script><p>Erreur : ${error}</p></body></html>`);
  }

  if (!oauthStates[state]) {
    return res.status(403).send('State OAuth invalide ou expiré.');
  }
  delete oauthStates[state];

  try {
    // Échanger le code contre un access token
    const tokenResp = await fetch('https://graph.facebook.com/v18.0/oauth/access_token?' +
      `client_id=${META_APP_ID}&` +
      `client_secret=${META_APP_SECRET}&` +
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
      `code=${code}`
    );

    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      return res.status(400).send('Échec token Meta : ' + JSON.stringify(tokenData));
    }

    // Récupérer les infos du user
    const userResp = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${tokenData.access_token}`);
    const userData = await userResp.json();

    // Récupérer les comptes pub
    const accountsResp = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?fields=id,name,account_id&access_token=${tokenData.access_token}`);
    const accountsData = await accountsResp.json();

    const userId = userData.id || 'user';
    metaTokens[userId] = {
      access_token: tokenData.access_token,
      user:         userData,
      adaccounts:   accountsData.data || []
    };

    // Renvoyer les données au dashboard via postMessage
    res.send(`
      <html><body><script>
        const data = ${JSON.stringify({ type: 'META_CONNECTED', userId: userId, user: userData, adaccounts: accountsData.data || [], token: tokenData.access_token })};
        if(window.opener) {
          window.opener.postMessage(data, '*');
          window.close();
        } else {
          document.body.innerHTML = '<p>Connecté ! Retourne sur DataDash.</p>';
        }
      </script><p>Connexion Meta réussie...</p></body></html>
    `);

  } catch(err) {
    res.status(500).send('Erreur OAuth Meta : ' + err.message);
  }
});

// ── 3. Récupérer le token stocké ──
router.get('/token', (req, res) => {
  const { userId } = req.query;
  const data = metaTokens[userId];
  if (!data) return res.status(404).json({ error: 'Utilisateur non connecté' });
  res.json(data);
});

// ── 4. Proxy Meta Ads API ──
router.get('/proxy', async (req, res) => {
  const { access_token, account_id, fields, date_preset, time_range } = req.query;

  if (!access_token || !account_id) {
    return res.status(400).json({ error: 'Paramètres manquants : access_token, account_id requis' });
  }

  let url = `https://graph.facebook.com/v18.0/act_${account_id}/insights?` +
    `fields=${fields || 'spend,impressions,clicks,actions,cpm,cpc,ctr'}&` +
    `access_token=${access_token}`;

  if (time_range) {
    url += `&time_range=${time_range}`;
  } else {
    url += `&date_preset=${date_preset || 'last_30d'}`;
  }

  try {
    const response = await fetch(url);
    const data     = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch(err) {
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
});

module.exports = router;