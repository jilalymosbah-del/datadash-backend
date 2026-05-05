require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sert ton fichier HTML DataDash
app.use(express.static(path.join(__dirname, 'public')));

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_SCOPES,
  META_APP_ID,
  META_APP_SECRET,
  HOST,
  PORT
} = process.env;

// Stockage en mémoire (remplace par une DB en production)
const sessions = {};

// ══ SHOPIFY AUTH ══

// Étape 1 : Le marchand installe l'app → on le redirige vers Shopify OAuth
app.get('/auth', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Paramètre shop manquant');

  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${HOST}/auth/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES}&state=${state}&redirect_uri=${redirectUri}`;

  res.cookie('shopify_state', state);
  res.redirect(installUrl);
});

// Étape 2 : Shopify nous renvoie le code → on l'échange contre un token
app.get('/auth/callback', async (req, res) => {
  const { shop, code, state } = req.query;

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code
      })
    });

    const data = await response.json();
    const accessToken = data.access_token;

    // Sauvegarde le token (en mémoire pour l'instant)
    sessions[shop] = { accessToken, shop };

    // Redirige vers le dashboard avec le shop en paramètre
    res.redirect(`/?shop=${shop}`);
  } catch (err) {
    console.error('Erreur OAuth Shopify:', err);
    res.status(500).send('Erreur authentification Shopify');
  }
});

// ══ API SHOPIFY — Données pour le dashboard ══

// Commandes
app.get('/api/shopify/orders', async (req, res) => {
  const { shop } = req.query;
  const session = sessions[shop];
  if (!session) return res.status(401).json({ error: 'Non authentifié' });

  try {
    const response = await fetch(
      `https://${shop}/admin/api/2024-01/orders.json?status=any&limit=250`,
      { headers: { 'X-Shopify-Access-Token': session.accessToken } }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clients
app.get('/api/shopify/customers', async (req, res) => {
  const { shop } = req.query;
  const session = sessions[shop];
  if (!session) return res.status(401).json({ error: 'Non authentifié' });

  try {
    const response = await fetch(
      `https://${shop}/admin/api/2024-01/customers.json?limit=250`,
      { headers: { 'X-Shopify-Access-Token': session.accessToken } }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Produits
app.get('/api/shopify/products', async (req, res) => {
  const { shop } = req.query;
  const session = sessions[shop];
  if (!session) return res.status(401).json({ error: 'Non authentifié' });

  try {
    const response = await fetch(
      `https://${shop}/admin/api/2024-01/products.json?limit=250`,
      { headers: { 'X-Shopify-Access-Token': session.accessToken } }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ META ADS AUTH ══

// Étape 1 : Redirige vers Facebook Login
app.get('/meta/auth', (req, res) => {
  const { shop } = req.query;
  const redirectUri = `${HOST}/meta/callback`;
  const scope = 'ads_read,ads_management,business_management';
  const state = Buffer.from(shop).toString('base64');

  const url = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}`;
  res.redirect(url);
});

// Étape 2 : Facebook nous renvoie le code
app.get('/meta/callback', async (req, res) => {
  const { code, state } = req.query;
  const shop = Buffer.from(state, 'base64').toString('utf8');
  const redirectUri = `${HOST}/meta/callback`;

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}&redirect_uri=${redirectUri}`
    );
    const data = await response.json();

    // Échange contre un long-lived token (60 jours)
    const longLivedRes = await fetch(
      `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${data.access_token}`
    );
    const longLived = await longLivedRes.json();

    if (sessions[shop]) {
      sessions[shop].metaToken = longLived.access_token;
    }

    res.redirect(`/?shop=${shop}&meta=connected`);
  } catch (err) {
    console.error('Erreur OAuth Meta:', err);
    res.status(500).send('Erreur authentification Meta');
  }
});

// ══ API META — Données publicitaires ══

// Comptes publicitaires
app.get('/api/meta/accounts', async (req, res) => {
  const { shop } = req.query;
  const session = sessions[shop];
  if (!session?.metaToken) return res.status(401).json({ error: 'Meta non connecté' });

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/me/adaccounts?fields=name,account_id,currency&access_token=${session.metaToken}`
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Insights (dépenses, ROAS, impressions)
app.get('/api/meta/insights', async (req, res) => {
  const { shop, account_id, date_preset = 'last_30d' } = req.query;
  const session = sessions[shop];
  if (!session?.metaToken) return res.status(401).json({ error: 'Meta non connecté' });

  try {
    const fields = 'spend,impressions,clicks,cpm,cpc,actions,action_values,roas';
    const response = await fetch(
      `https://graph.facebook.com/v18.0/act_${account_id}/insights?fields=${fields}&date_preset=${date_preset}&access_token=${session.metaToken}`
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Campagnes
app.get('/api/meta/campaigns', async (req, res) => {
  const { shop, account_id } = req.query;
  const session = sessions[shop];
  if (!session?.metaToken) return res.status(401).json({ error: 'Meta non connecté' });

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/act_${account_id}/campaigns?fields=name,status,daily_budget,lifetime_budget,insights{spend,impressions,clicks,roas}&access_token=${session.metaToken}`
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ STATUS — vérifie si shop et meta sont connectés ══
app.get('/api/status', (req, res) => {
  const { shop } = req.query;
  const session = sessions[shop];
  res.json({
    shopify: !!session?.accessToken,
    meta: !!session?.metaToken,
    shop: shop || null
  });
});

app.listen(PORT, () => {
  console.log(`DataDash backend démarré sur le port ${PORT}`);
  console.log(`URL d'installation : ${HOST}/auth?shop=TONSHOP.myshopify.com`);
});
