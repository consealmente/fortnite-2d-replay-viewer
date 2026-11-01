'use strict';

const fs = require('fs');
const path = require('path');
const { downloadReplay, REPLAY_DIR } = require('./downloader');
const { runBridge } = require('./bridge');

const PARSED_DIR = path.join(__dirname, '..', 'data', 'parsed');
fs.mkdirSync(PARSED_DIR, { recursive: true });

/** In-flight and recently-finished jobs, keyed by normalized code. */
const jobs = new Map();

function normalizeCode(raw) {
  const c = String(raw || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  return /^[0-9a-f]{32}$/.test(c) ? c : null;
}

function modelPath(code) {
  return path.join(PARSED_DIR, `${code}.json`);
}

function jobView(job) {
  return {
    code: job.code,
    status: job.status, // queued | downloading | parsing | done | error
    progress: job.progress,
    phase: job.phase,
    error: job.error || null,
    meta: job.meta || null,
  };
}

async function run(job) {
  try {
    job.status = 'downloading';
    job.phase = 'Downloading replay from Epic';
    job.progress = 0;
    await downloadReplay(job.code, (p) => {
      job.progress = p;
    }).then((p) => {
      job.replayPath = p;
    });

    job.status = 'parsing';
    job.phase = 'Parsing replay';
    job.progress = 0;
    const model = await runBridge(job.replayPath, (p) => {
      job.progress = p;
    });

    fs.writeFileSync(modelPath(job.code), JSON.stringify(model));
    job.status = 'done';
    job.phase = 'Ready';
    job.progress = 100;
    job.meta = model.meta;
  } catch (err) {
    job.status = 'error';
    job.phase = 'Failed';
    job.error = err.message || String(err);
  }
}

/**
 * Returns the job for `code`, kicking off download+parse if it isn't already
 * cached or running. `null` if the code isn't a valid replay code.
 */
function startJob(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;

  if (fs.existsSync(modelPath(code))) {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(modelPath(code), 'utf8')).meta;
    } catch (_) {
      /* corrupt cache -- fall through and re-parse */
    }
    if (meta) {
      const done = { code, status: 'done', progress: 100, phase: 'Ready', meta };
      jobs.set(code, done);
      return done;
    }
    fs.rmSync(modelPath(code), { force: true });
  }

  const existing = jobs.get(code);
  if (existing && existing.status !== 'error') return existing;

  const job = { code, status: 'queued', progress: 0, phase: 'Queued', error: null };
  jobs.set(code, job);
  run(job);
  return job;
}

function getJob(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const job = jobs.get(code);
  if (job) return job;
  if (fs.existsSync(modelPath(code))) {
    return { code, status: 'done', progress: 100, phase: 'Ready' };
  }
  return null;
}

function getModel(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code || !fs.existsSync(modelPath(code))) return null;
  return fs.readFileSync(modelPath(code), 'utf8'); // raw JSON string -- streamed straight through
}

/**
 * Deletes every downloaded `.replay` and every parsed `.json` from `data/`, and
 * forgets all tracked jobs. The board (`data/board.json`) is untouched -- its
 * games just re-download and re-parse the next time they're opened. A file that
 * can't be removed (e.g. a parse is mid-flight and holding it open on Windows)
 * is skipped rather than aborting the sweep.
 */
function clearCache() {
  let replays = 0;
  let parsed = 0;
  for (const [dir, ext, isReplay] of [
    [REPLAY_DIR, '.replay', true],
    [PARSED_DIR, '.json', false],
  ]) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue; // dir doesn't exist yet -- nothing to clear
    }
    for (const f of files) {
      if (!f.toLowerCase().endsWith(ext)) continue;
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        if (isReplay) replays++;
        else parsed++;
      } catch {
        /* locked / vanished -- leave it */
      }
    }
  }
  jobs.clear();
  return { replays, parsed };
}

function activeJobs() { return [...jobs.values()].filter(j => ['queued','downloading','parsing'].includes(j.status)).length; }
module.exports = { activeJobs, startJob, getJob, getModel, clearCache, jobView, normalizeCode };
