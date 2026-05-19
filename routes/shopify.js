const express = require('express');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

// ── Config OAuth ──
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_API_KEY || '4ab51015937afc8302534d659e4b7a85';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_CLIENT_SECRET || '';
const REDIRECT_URI          = process.env.SHOPIFY_REDIRECT_URI || '';
const SCOPES                = 'read_orders,read_products,read_customers,read_analytics,read_reports';

// ── Persistance des tokens ──
const TOKENS_FILE = path.join(__dirname, '..', 'shop_tokens.json');
const COGS_FILE   = path.join(__dirname, '..', 'shop_cogs.json');
const SYNC_FILE   = path.join(__dirname, '..', 'shop_sync.json');

function loadJSON(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch(e) {}
  return {};
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {}
}

const oauthStates = {};
let shopTokens = loadJSON(TOKENS_FILE);
let shopCogs   = loadJSON(COGS_FILE);
let shopSync   = loadJSON(SYNC_FILE);

// ── Helper: Shopify API call ──
async function shopifyAPI(shop, token, endpoint) {
  const url = `https://${shop}/admin/api/2024-01/${endpoint}`;
  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);
  return res.json();
}

// ── Initial Sync: fetch all orders + products ──
async function doInitialSync(shop, token) {
  try {
    // Fetch orders (last 250)
    const ordersData = await shopifyAPI(shop, token, 'orders.json?status=any&limit=250');
    const orders = ordersData.orders || [];

    // Fetch products
    const productsData = await shopifyAPI(shop, token, 'products.json?limit=250');
    const products = productsData.products || [];

    // Calculate revenue
    const revenue = orders
      .filter(o => o.financial_status === 'paid')
      .reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);

    // Save sync data
    shopSync[shop] = {
      orders,
      products,
      revenue: parseFloat(revenue.toFixed(2)),
      orderCount: orders.length,
      lastSync: new Date().toISOString()
    };
    saveJSON(SYNC_FILE, shopSync);

    // Register webhook
    await registerWebhook(shop, token);

    return shopSync[shop];
  } catch(err) {
    console.error('Initial sync error:', err.message);
    throw err;
  }
}

// ── Register Webhook ──
async function registerWebhook(shop, token) {
  try {
    const webhookUrl = `${process.env.HOST || 'https://datadash-backend-dhbe.onrender.com'}/api/shopify/webhook/orders`;
    
    // Check existing webhooks
    const existing = await shopifyAPI(shop, token, 'webhooks.json');
    const alreadyExists = (existing.webhooks || []).some(w => 
      w.topic === 'orders/create' && w.address === webhookUrl
    );
    if (alreadyExists) return;

    // Create webhook
    const res = await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhook: { topic: 'orders/create', address: webhookUrl, format: 'json' }
      })
    });
    const data = await res.json();
    console.log('Webhook registered:', data.webhook?.id);
  } catch(err) {
    console.error('Webhook registration error:', err.message);
  }
}

// ── 1. Auth ──
router.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: 'Paramètre shop manquant' });

  const state = crypto.randomBytes(16).toString('hex');
  oauthStates[state] = { shop, createdAt: Date.now() };

  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${SHOPIFY_CLIENT_ID}&scope=${SCOPES}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;

  res.redirect(authUrl);
});

// ── 2. Callback ──
router.get('/callback', async (req, res) => {
  const { code, shop, state } = req.query;

  if (!oauthStates[state]) return res.status(403).send('State OAuth invalide ou expiré.');
  delete oauthStates[state];

  try {
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code })
    });

    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) return res.status(400).send('Échec token: ' + JSON.stringify(tokenData));

    shopTokens[shop] = tokenData.access_token;
    saveJSON(TOKENS_FILE, shopTokens);

    // Initial sync en arrière-plan
    doInitialSync(shop, tokenData.access_token).catch(console.error);

    res.redirect(`/api/shopify/success?shop=${shop}`);
  } catch(err) {
    res.status(500).send('Erreur OAuth: ' + err.message);
  }
});

// ── 3. Success ──
router.get('/success', (req, res) => {
  const { shop } = req.query;
  const token = shopTokens[shop];
  if (!token) return res.status(404).send('Token introuvable.');

  res.send(
    '<html><body><script>' +
    'if (window.opener) {' +
    '  window.opener.postMessage({ type: "SHOPIFY_CONNECTED", shop: "' + shop + '", token: "' + token + '" }, "*");' +
    '  window.close();' +
    '} else { window.location.href = "/"; }' +
    '</script><p>Connexion réussie, fermeture...</p></body></html>'
  );
});

// ── 4. Token ──
router.get('/token', (req, res) => {
  shopTokens = loadJSON(TOKENS_FILE);
  const { shop } = req.query;
  const token = shopTokens[shop];
  if (!token) return res.status(404).json({ error: 'Boutique non connectée' });
  res.json({ shop, token });
});

// ── 5. Proxy ──
router.get('/proxy', async (req, res) => {
  const { domain, token, endpoint } = req.query;
  if (!domain || !token || !endpoint) return res.status(400).json({ error: 'Paramètres manquants' });

  try {
    const response = await fetch(`https://${domain}/admin/api/2024-01/${endpoint}`, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    });
    if (!response.ok) return res.status(response.status).json({ error: response.statusText });
    res.json(await response.json());
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 6. OAuth Start ──
router.get('/oauth-start', (req, res) => {
  const shop = req.query.shop;
  if (shop) {
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates[state] = { shop, createdAt: Date.now() };
    const authUrl = `https://${shop}/admin/oauth/authorize?` +
      `client_id=${SHOPIFY_CLIENT_ID}&scope=${SCOPES}&` +
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
    return res.redirect(authUrl);
  }
  res.send(`
    <html><body style="font-family:sans-serif;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px;">
      <h2>Connecter Shopify</h2>
      <input id="shop" placeholder="ma-boutique.myshopify.com" style="padding:10px 14px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#fff;font-size:15px;width:260px;" />
      <button onclick="go()" style="background:#5c6ac4;color:#fff;border:none;padding:12px 28px;border-radius:8px;font-size:15px;cursor:pointer;">Connecter →</button>
      <script>
        function go() {
          let shop = document.getElementById('shop').value.trim().replace('https://','').replace(/\\/$/,'');
          if (!shop.includes('.')) shop += '.myshopify.com';
          window.location.href = '/api/shopify/oauth-start?shop=' + encodeURIComponent(shop);
        }
        document.getElementById('shop').addEventListener('keydown', e => { if(e.key==='Enter') go(); });
      </script>
    </body></html>
  `);
});

// ── 7. Dashboard Data (formatted for frontend) ──
router.get('/dashboard', async (req, res) => {
  const { shop, token } = req.query;
  if (!shop || !token) return res.status(400).json({ error: 'shop et token requis' });

  try {
    // Use cached sync data if available
    let syncData = shopSync[shop];
    
    if (!syncData) {
      syncData = await doInitialSync(shop, token);
    }

    const cogs = shopCogs[shop] || {};
    
    // Calculate COGS total
    let cogsTotal = 0;
    (syncData.products || []).forEach(product => {
      const productCogs = cogs[product.id] || 0;
      const sold = (syncData.orders || []).reduce((sum, order) => {
        const lineItem = (order.line_items || []).find(li => li.product_id === product.id);
        return sum + (lineItem ? lineItem.quantity : 0);
      }, 0);
      cogsTotal += productCogs * sold;
    });

    res.json({
      shop,
      revenue: syncData.revenue || 0,
      orderCount: syncData.orderCount || 0,
      products: (syncData.products || []).map(p => ({
        id: p.id,
        title: p.title,
        status: p.status,
        image: p.image?.src || null,
        cogs: cogs[p.id] || 0
      })),
      cogsTotal: parseFloat(cogsTotal.toFixed(2)),
      lastSync: syncData.lastSync
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 8. Net Margin ──
router.get('/margin', (req, res) => {
  const { shop, metaSpend } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop requis' });

  const syncData = shopSync[shop];
  if (!syncData) return res.status(404).json({ error: 'Aucune donnée sync. Connectez Shopify d\'abord.' });

  const cogs = shopCogs[shop] || {};
  let cogsTotal = 0;
  (syncData.products || []).forEach(product => {
    const productCogs = cogs[product.id] || 0;
    const sold = (syncData.orders || []).reduce((sum, order) => {
      const lineItem = (order.line_items || []).find(li => li.product_id === product.id);
      return sum + (lineItem ? lineItem.quantity : 0);
    }, 0);
    cogsTotal += productCogs * sold;
  });

  const revenue   = syncData.revenue || 0;
  const adSpend   = parseFloat(metaSpend || 0);
  const netMargin = revenue - adSpend - cogsTotal;

  res.json({
    revenue:   parseFloat(revenue.toFixed(2)),
    adSpend:   parseFloat(adSpend.toFixed(2)),
    cogs:      parseFloat(cogsTotal.toFixed(2)),
    netMargin: parseFloat(netMargin.toFixed(2)),
    formula:   `${revenue.toFixed(2)} - ${adSpend.toFixed(2)} - ${cogsTotal.toFixed(2)} = ${netMargin.toFixed(2)}`
  });
});

// ── 9. COGS - GET ──
router.get('/cogs', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop requis' });
  res.json({ shop, cogs: shopCogs[shop] || {} });
});

// ── 10. COGS - SET ──
router.post('/cogs', express.json(), (req, res) => {
  const { shop, productId, cost } = req.body;
  if (!shop || !productId || cost === undefined) {
    return res.status(400).json({ error: 'shop, productId et cost requis' });
  }
  if (!shopCogs[shop]) shopCogs[shop] = {};
  shopCogs[shop][productId] = parseFloat(cost);
  saveJSON(COGS_FILE, shopCogs);
  res.json({ success: true, shop, productId, cost: shopCogs[shop][productId] });
});

// ── 11. Webhook orders/create ──
router.post('/webhook/orders', express.raw({ type: 'application/json' }), (req, res) => {
  const hmac      = req.headers['x-shopify-hmac-sha256'];
  const shop      = req.headers['x-shopify-shop-domain'];
  const body      = req.body;

  // Verify webhook signature
  const hash = crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET)
    .update(body, 'utf8').digest('base64');

  if (hash !== hmac) return res.status(401).send('Webhook non autorisé');

  try {
    const order = JSON.parse(body.toString());
    
    if (shopSync[shop]) {
      // Add new order to sync data
      shopSync[shop].orders.unshift(order);
      shopSync[shop].orderCount = shopSync[shop].orders.length;
      
      // Recalculate revenue
      shopSync[shop].revenue = parseFloat(
        shopSync[shop].orders
          .filter(o => o.financial_status === 'paid')
          .reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0)
          .toFixed(2)
      );
      shopSync[shop].lastSync = new Date().toISOString();
      saveJSON(SYNC_FILE, shopSync);
    }

    console.log(`New order received for ${shop}: #${order.order_number}`);
    res.status(200).send('OK');
  } catch(err) {
    res.status(500).send('Erreur webhook: ' + err.message);
  }
});

// ── 12. Manual Sync ──
router.post('/sync', express.json(), async (req, res) => {
  const { shop, token } = req.body;
  if (!shop || !token) return res.status(400).json({ error: 'shop et token requis' });

  try {
    const data = await doInitialSync(shop, token);
    res.json({ success: true, ...data });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;