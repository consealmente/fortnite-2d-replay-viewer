'use strict';

const express = require('express');
const { startJob, getJob, getModel, clearCache, jobView, normalizeCode, activeJobs } = require('./store');
const { getBoard, saveBoard } = require('./board');

const router = express.Router();

// The home-screen board (categories + saved games). The client owns the model
// and PUTs the whole document; we just validate and persist it.
router.get('/board', (_req, res) => {
  if (process.env.PUBLIC_WEBSITE === '1') return res.json({categories:[]});
  res.json(getBoard());
});

router.put('/board', (req, res) => {
  if (process.env.PUBLIC_WEBSITE === '1') return res.status(403).json({error:'Boards are saved in each visitor browser.'});
  try {
    res.json(saveBoard(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not save the board.' });
  }
});

// Wipe every downloaded + parsed replay from data/ (the board is left alone).
router.delete('/replays', (_req, res) => {
  if (process.env.PUBLIC_WEBSITE === '1') return res.status(403).json({error:'Cache clearing disabled on public website.'});
  res.json(clearCache());
});

// Kick off (or re-attach to) a download+parse for a replay code.
router.post('/replays', (req, res) => {
  if (process.env.PUBLIC_WEBSITE === '1' && getJob(req.body?.code)?.status !== 'done' && activeJobs() >= Number(process.env.MAX_ACTIVE_REPLAYS || 3)) return res.status(503).json({error:'Replay processing is busy. Please try again shortly.'});
  const raw = (req.body && req.body.code) || '';
  if (!normalizeCode(raw)) {
    return res.status(400).json({
      error: 'That doesn\'t look like a replay code. It should be 32 hex characters, e.g. 4e7a286c6ecf490597fb387b51871edb.',
    });
  }
  const job = startJob(raw);
  res.json(jobView(job));
});

// Poll job status.
router.get('/replays/:code/status', (req, res) => {
  const job = getJob(req.params.code);
  if (!job) return res.status(404).json({ error: 'No job for that code. POST /api/replays first.' });
  res.json(jobView(job));
});

// The parsed viewer model (large). Streamed straight from the cache file.
router.get('/replays/:code/model', (req, res) => {
  const json = getModel(req.params.code);
  if (!json) return res.status(404).json({ error: 'Not parsed yet.' });
  res.type('application/json').send(json);
});

module.exports = router;
