const express = require('express');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const router  = express.Router();

const WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ── Webhook LemonSqueezy ──
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-signature'];
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(body).digest('hex');

  if (signature !== hmac) return res.status(401).json({ error: 'Invalid signature' });

  const event = JSON.parse(body.toString());
  const eventName = event.meta?.event_name;

  if (eventName === 'order_created' || eventName === 'license_key_created') {
    const licenseKey = event.data?.attributes?.license_key ||
                       event.meta?.custom_data?.license_key;
    const email      = event.data?.attributes?.user_email;

    if (licenseKey) {
      await supabase.from('licenses').upsert({
        license_key: licenseKey,
        email,
        active: true,
        activations: 0,
        max_activations: 1
      });
      console.log(`✅ License enregistrée : ${licenseKey} pour ${email}`);
    }
  }

  res.json({ received: true });
});

// ── Valider une license key ──
router.post('/validate', express.json(), async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key manquante' });

  const { data: license, error } = await supabase
    .from('licenses').select('*').eq('license_key', key).single();

  if (error || !license) return res.status(404).json({ valid: false, error: 'License introuvable' });
  if (!license.active) return res.status(403).json({ valid: false, error: 'License inactive' });
  if (license.activations >= license.max_activations)
    return res.status(403).json({ valid: false, error: 'Limite activation atteinte' });

  await supabase.from('licenses')
    .update({ activations: license.activations + 1 })
    .eq('license_key', key);

  res.json({ valid: true, email: license.email });
});

module.exports = router;