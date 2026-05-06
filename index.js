const express = require('express');
const cors    = require('cors');
const dotenv  = require('dotenv');
const path    = require('path');
dotenv.config();

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));

// ── Routes API ──
const shopifyRoutes = require('./routes/shopify');
const metaRoutes    = require('./routes/meta');
const lsRoutes      = require('./routes/lemonsqueezy');

app.use('/api/shopify', shopifyRoutes);
app.use('/api/meta',    metaRoutes);
app.use('/api/ls',      lsRoutes);

app.use(express.json());

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ── Fichiers HTML explicites ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'datadash-dashboard.html')));
app.get('/connected.html', (req, res) => res.sendFile(path.join(__dirname, 'connected.html')));
app.get('/datadash-dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'datadash-dashboard.html')));

// ── Start ──
app.listen(PORT, () => {
  console.log(`✅ DataDash backend running on http://localhost:${PORT}`);
});