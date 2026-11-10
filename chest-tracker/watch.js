#!/usr/bin/env node
'use strict';

// Optional, headless match watcher. Does not use the 2D viewer.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HISTORY = path.join(ROOT, 'data', 'chest-tracker', 'history.json');
const POLL_MS = 15000;
const STABLE_MS = 40000;
const RETRY_MS = 120000;

function options(argv) {
  let folder = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'FortniteGame', 'Saved', 'Demos')
    : null;
  let noServer = false;
  let epicId = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--folder' && argv[i + 1]) folder = argv[++i];
    else if (argv[i] === '--no-server') noServer = true;
    else if (argv[i] === '--epic-id' && argv[i + 1]) epicId = argv[++i];
    else throw new Error('Usage: node chest-tracker/watch.js [--folder <Demos path>] [--no-server] [--epic-id <id>]');
  }
  if (!folder) throw new Error('Specify --folder if LOCALAPPDATA is not defined.');
  return { folder: path.resolve(folder), noServer, epicId };
}

function loadHistory() {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
    if (saved && typeof saved.matches === 'object' && !Array.isArray(saved.matches)) return saved;
  } catch (_) { /* no saved state or invalid JSON */ }
  return { version: 1, matches: {} };
}

function saveHistory(data) {
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  const temp = HISTORY + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, HISTORY);
}

function totals(history) {
  const entries = Object.values(history.matches);
  return {
    matches: entries.filter(e => Number.isInteger(e.chestCount)).length,
    chests: entries.reduce((n, e) => n + (Number.isInteger(e.chestCount) ? e.chestCount : 0), 0)
  };
}

function scanFile(filename, opts) {
  const args = [path.join(__dirname, 'index.js'), filename];
  if (opts.noServer) args.push('--no-server');
  if (opts.epicId) args.push('--epic-id', opts.epicId);
  const child = spawnSync(process.execPath, args, {
    encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 20 * 1024 * 1024
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error((child.stderr || 'Replay scan failed').slice(-500));
  return JSON.parse(child.stdout);
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (!fs.existsSync(opts.folder)) throw new Error('Replay folder does not exist: ' + opts.folder);
  const history = loadHistory();

  console.log('Watching ' + opts.folder);
  console.log('Single-player chest counts. History: ' + HISTORY);
  console.log('Only stable replay files are scanned; press Ctrl+C to stop.');

  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });

  while (!stopping) {
    const files = fs.readdirSync(opts.folder)
      .filter(f => f.toLowerCase().endsWith('.replay'))
      .sort();
    for (const file of files) {
      if (stopping) break;
      const fullPath = path.join(opts.folder, file);
      let stat;
      try { stat = fs.statSync(fullPath); } catch (_) { continue; }
      if (!stat.isFile() || stat.size < 1024 || Date.now() - stat.mtimeMs < STABLE_MS) continue;

      const prior = history.matches[file];
      if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) {
        if (prior.status === 'done' || Date.now() - prior.lastAttemptMs < RETRY_MS) continue;
      }

      console.log('Reading ' + file + '...');
      try {
        const result = scanFile(fullPath, opts);
        history.matches[file] = {
          size: stat.size, mtimeMs: stat.mtimeMs, lastAttemptMs: Date.now(),
          status: 'done',
          sessionId: result.sessionId,
          playerEpicId: result.playerEpicId,
          chestCount: result.chestCount,
          source: result.source,
          playerName: result.playerName,
          localChestCount: result.localChestCount,
          serverChestCount: result.serverChestCount,
          serverAttempt: result.serverAttempt,
          chestEvents: result.chests,
          warnings: result.warnings,
          error: null
        };
        const total = totals(history);
        console.log(file + ': ' +
          (result.chestCount === null ? 'player not identified' : result.chestCount + ' chests') +
          ' (' + result.source + ') | total: ' + total.chests +
          ' chests across ' + total.matches + ' matches');
      } catch (e) {
        history.matches[file] = {
          size: stat.size, mtimeMs: stat.mtimeMs, lastAttemptMs: Date.now(),
          status: 'error', error: String(e.message || e).slice(0, 450)
        };
        console.error(file + ': scan failed; will retry. ' + history.matches[file].error);
      }
      saveHistory(history);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  console.log('Chest watcher stopped.');
}

if (require.main === module) {
  main().catch(e => { console.error(e.message || e); process.exitCode = 1; });
}

module.exports = { options, totals };
