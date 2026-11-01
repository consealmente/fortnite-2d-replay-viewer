'use strict';

// The upstream downloader writes its OAuth cache inside node_modules, which is
// read-only in Vercel Functions. Redirect only that cache to writable /tmp.
const fs = require('fs');
const path = require('path');
const target = path.join(__dirname, '..', 'node_modules', 'fortnite-replay-downloader', 'src', 'getAccessToken.js');
if (!fs.existsSync(target)) {
  console.log('Downloader not installed; skipping cache patch');
  process.exit(0);
}
const source = fs.readFileSync(target, 'utf8');
const original = "${module.path}/../cache.json";
const replacement = "${require('os').tmpdir()}/fortnite-replay-downloader-cache.json";
if (!source.includes(original) && !source.includes(replacement)) {
  throw new Error('Downloader cache implementation changed; update patch before deploying');
}
if (source.includes(original)) {
  fs.writeFileSync(target, source.split(original).join(replacement));
  console.log('Redirected downloader token cache to temporary storage');
}
