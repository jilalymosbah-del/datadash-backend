const express = require('express');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
const router  = express.Router();

// ── Config OAuth ──
const SHOPIFY_CLIENT_ID     = '4ab51015937afc8302534d659e4b7a85';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.SHOPIFY_REDIRECT_URI || '';
const SCOPES                = 'read_orders,read_products,read_customers';

// Stockage temporaire des états OAuth et tokens (en mémoire)
const oauthStates  = {};
const shopTokens   = {};

// ── 1. Initier le flux OAuth ──
router.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: 'Paramètre shop manquant' });

  const state = crypto.randomBytes(16).toString('hex');
  oauthStates[state] = { shop, createdAt: Date.now() };

  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${SHOPIFY_CLIENT_ID}&` +
    `scope=${SCOPES}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `state=${state}`;

  res.redirect(authUrl);
});

// ── 2. Callback OAuth — Shopify redirige ici après autorisation ──
router.get('/callback', async (req, res) => {
  const { code, shop, state, hmac } = req.query;

  // Vérifier le state
  if (!oauthStates[state]) {
    return res.status(403).send('State OAuth invalide ou expiré.');
  }
  delete oauthStates[state];

  try {
    // Échanger le code contre un access token
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      })
    });

    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      return res.status(400).send('Échec récupération token : ' + JSON.stringify(tokenData));
    }

    // Stocker le token
    shopTokens[shop] = tokenData.access_token;

    // Rediriger vers le dashboard avec succès
    res.redirect(`/api/shopify/success?shop=${shop}`);

  } catch (err) {
    res.status(500).send('Erreur OAuth : ' + err.message);
  }
});

// ── 3. Page de succès — redirige vers le HTML avec le token ──
router.get('/success', (req, res) => {
  const { shop } = req.query;
  const token = shopTokens[shop];
  if (!token) return res.status(404).send('Token introuvable pour cette boutique.');

  // Injecter shop + token dans la page HTML via paramètres URL
  res.send(`
    <html><body>
    <script>
      // Envoyer les infos à la fenêtre parente (DataDash)
      if (window.opener) {
        window.opener.postMessage({
          type: 'SHOPIFY_CONNECTED',
          shop: '${shop}',
          token: '${token}'
        }, '*');
        window.close();
      } else {
        // Fallback si pas de popup
       window.location.href = '/datadash-dashboard.html?shopify_shop=${shop}&shopify_token=${token}';
      }
    </script>
    <p>Connexion réussie ! Fermeture en cours...</p>
    </body></html>
  `);
});

// ── 4. Récupérer le token stocké pour une boutique ──
router.get('/token', (req, res) => {
  const { shop } = req.query;
  const token = shopTokens[shop];
  if (!token) return res.status(404).json({ error: 'Boutique non connectée' });
  res.json({ shop, token });
});

// ── 5. Proxy Shopify API ──
router.get('/proxy', async (req, res) => {
  const { domain, token, endpoint } = req.query;
  if (!domain || !token || !endpoint) {
    return res.status(400).json({ error: 'Paramètres manquants : domain, token, endpoint requis' });
  }

  const url = `https://${domain}/admin/api/2024-01/${endpoint}`;
  try {
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    });
    if (response.status === 401) return res.status(401).json({ error: 'Token invalide ou permissions insuffisantes' });
    if (response.status === 404) return res.status(404).json({ error: 'Boutique introuvable — vérifiez le domaine' });
    if (!response.ok) return res.status(response.status).json({ error: 'Erreur Shopify : ' + response.statusText });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
});

module.exports = router;