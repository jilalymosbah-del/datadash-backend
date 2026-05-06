const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';

// Stockage des licenses (en mémoire pour l'instant)
const licenses = {};

// ── Webhook LemonSqueezy ──
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  // Vérifier la signature
  const signature = req.headers['x-signature'];
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  if (signature !== hmac) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body);
  const eventName = event.meta?.event_name;

  if (eventName === 'order_created' || eventName === 'license_key_created') {
    const licenseKey  = event.data?.attributes?.license_key || 
                        event.meta?.custom_data?.license_key;
    const email       = event.data?.attributes?.user_email;
    const productName = event.data?.attributes?.product_name || 'DataDash Pro';

    if (licenseKey) {
      licenses[licenseKey] = {
        email,
        active: true,
        activations: 0,
        maxActivations: 1,
        createdAt: new Date().toISOString()
      };
      console.log(`✅ License créée : ${licenseKey} pour ${email}`);
    }
  }

  res.json({ received: true });
});

// ── Valider une license key ──
router.post('/validate', express.json(), (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key manquante' });

  const license = licenses[key];
  if (!license) return res.status(404).json({ valid: false, error: 'License introuvable' });
  if (!license.active) return res.status(403).json({ valid: false, error: 'License inactive' });
  if (license.activations >= license.maxActivations) {
    return res.status(403).json({ valid: false, error: 'Limite d\'activation atteinte' });
  }

  license.activations++;
  res.json({ valid: true, email: license.email });
});

module.exports = router;