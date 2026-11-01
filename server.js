'use strict';

const path = require('path');
const express = require('express');
const routes = require('./src/routes');
const { publicGuard } = require('./src/public-guard');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '4mb' }));
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use('/api', publicGuard, routes);
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
// Never cache the static app assets -- this is a local dev tool and stale
// app.js after an edit is pure friction.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));

app.listen(PORT, () => {
  console.log(`\n  Fortnite 2D replay viewer  ->  http://localhost:${PORT}\n`);
  console.log('  The first replay you parse is slow (~30-60s) while the C# parser');
  console.log('  builds. Every one after that is a few seconds.\n');
});
