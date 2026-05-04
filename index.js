const express = require('express');
const cors    = require('cors');
const dotenv  = require('dotenv');

dotenv.config();


const app  = express();
app.use(express.static(__dirname));
const PORT = process.env.PORT || 3001;

// ── Middleware ──
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Routes ──
const shopifyRoutes = require('./routes/shopify');
const metaRoutes    = require('./routes/meta');

app.use('/api/shopify', shopifyRoutes);
app.use('/api/meta',    metaRoutes);

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`✅ DataDash backend running on http://localhost:${PORT}`);
});