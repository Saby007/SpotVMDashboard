// Pure static host for the Angular SPA.
// All Azure logic now happens in the browser using the signed-in user's ARM token
// (acquired via MSAL). The server no longer needs Entra/Azure SDK dependencies.

const express = require('express');
const path = require('path');

const app = express();

const STATIC_DIR = path.join(__dirname, 'dist/spotvm-dashboard/browser');

app.use(express.static(STATIC_DIR));

// Health probe (cheap, no auth)
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

// SPA fallback — any non-asset GET returns index.html so client-side routing works.
app.get(/^\/(?!healthz).*/, (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Spot VM Dashboard (SPA-only) running on port ${PORT}`);
});
