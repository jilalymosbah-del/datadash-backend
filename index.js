const express = require('express');
const cors    = require('cors');
const dotenv  = require('dotenv');
const path    = require('path');
dotenv.config();

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Middleware ──
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname, { etag: false, maxAge: 0 }));

// ── Routes ──
const shopifyRoutes = require('./routes/shopify');
const metaRoutes    = require('./routes/meta');
const lsRoutes      = require('./routes/lemonsqueezy');

app.use('/api/shopify', shopifyRoutes);
app.use('/api/meta',    metaRoutes);
app.use('/api/ls',      lsRoutes);

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

app.get('/connected.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'connected.html'));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`✅ DataDash backend running on http://localhost:${PORT}`);
});