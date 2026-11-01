'use strict';

const fs = require('fs');
const path = require('path');

const REPLAY_DIR = path.join(process.env.VERCEL ? '/tmp' : path.join(__dirname, '..', 'data'), 'replays');

/**
 * Downloads a replay by its code (the 32-char session/match id, the same thing
 * the in-game "watch by code" field takes) using xNocken's
 * `fortnite-replay-downloader`, which talks to the unofficial Epic endpoint the
 * game itself uses. Auth is a public game-client credential baked into the
 * package -- no login. Works most reliably for tournament (Showdown/FNCS)
 * replays; older pubs may have been purged server-side.
 *
 * Returns the path to the written `.replay` file. If the file is already on
 * disk it is reused (replay contents never change).
 */
async function downloadReplay(code, onProgress = () => {}) {
  fs.mkdirSync(REPLAY_DIR, { recursive: true });
  const outPath = path.join(REPLAY_DIR, `${code}.replay`);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    onProgress(100);
    return outPath;
  }

  let downloader;
  try {
    downloader = require('fortnite-replay-downloader');
  } catch (e) {
    throw new Error("fortnite-replay-downloader isn't installed. Run `npm install`.");
  }

  const buffer = await downloader.downloadReplay({
    matchId: code,
    eventCount: 1000,
    dataCount: 1000,
    checkpointCount: 1000,
    updateCallback: (data) => {
      const parts = [data.header, data.dataChunks, data.eventChunks, data.checkpointChunks].filter(Boolean);
      const total = parts.reduce((a, p) => a + (p.max || 0), 0);
      const done = parts.reduce((a, p) => a + (p.current || 0), 0);
      if (total > 0) onProgress(Math.round((done / total) * 100));
    },
  });

  if (!Buffer.isBuffer(buffer)) {
    throw new Error(
      `fortnite-replay-downloader returned ${typeof buffer}, not a Buffer -- the ` +
        'package API may have changed, or Epic returned nothing for this code.'
    );
  }
  if (buffer.length < 1024) {
    throw new Error(
      'The downloaded replay is suspiciously small -- Epic may have no data for ' +
        `this code (${code}). Double-check the code, or try a tournament replay.`
    );
  }

  fs.writeFileSync(outPath, buffer);
  onProgress(100);
  return outPath;
}

module.exports = { downloadReplay, REPLAY_DIR };
