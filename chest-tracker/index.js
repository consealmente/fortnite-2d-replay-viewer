#!/usr/bin/env node
'use strict';

// Standalone CLI: replay file -> local player chest count -> optional server replay.
// Intentionally no dependency on the 2D viewer UI.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chooseResult, normalizeSessionId } = require('./result');

const PROJECT = path.join(__dirname, 'chest-tracker.csproj');

function usage() {
  console.error('Usage: node chest-tracker/index.js <file.replay> [--no-server] [--epic-id <id>]');
  console.error('The result is printed as JSON; informational messages go to stderr.');
}

function scan(file, epicId) {
  const cmd = ['run', '--project', PROJECT, '-c', 'Release', '--no-launch-profile',
    '--', file];
  if (epicId) cmd.push('--epic-id', epicId);
  // .NET may print restore/build messages before the result on a first run.
  const output = execFileSync('dotnet', cmd, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });
  const line = output.trim().split(/\r?\n/).reverse().find(s => s.trim().startsWith('{'));
  if (!line) throw new Error('Chest parser did not return JSON: ' + output.slice(-1000));
  return JSON.parse(line);
}

async function main(argv) {
  if (!argv.length || argv[0].startsWith('--')) {
    usage();
    process.exitCode = 2;
    return;
  }
  const replayFile = path.resolve(argv[0]);
  if (!fs.existsSync(replayFile) || !replayFile.toLowerCase().endsWith('.replay')) {
    throw new Error('Not an existing .replay file: ' + replayFile);
  }

  let attemptServer = true, epicId = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--no-server') attemptServer = false;
    else if (argv[i] === '--epic-id' && argv[i + 1]) epicId = argv[++i];
    else throw new Error('Unknown or incomplete argument: ' + argv[i]);
  }

  console.error('Scanning local replay for session ID and chest events...');
  const local = scan(replayFile, epicId);
  const code = normalizeSessionId(local.sessionId);
  let server = null;
  const serverAttempt = {
    status: attemptServer ? 'skipped' : 'disabled',
    reason: null,
  };

  if (attemptServer && !code) {
    serverAttempt.reason = 'No valid 32-character match session ID found in local replay.';
  } else if (attemptServer) {
    try {
      console.error('Trying Epic replay download using session ID ' + code + '...');
      const { downloadReplay } = require('../src/downloader');
      const downloaded = await downloadReplay(code);
      serverAttempt.status = 'downloaded';

      // A server replay may have a different recorder. Always match the specific
      // player from the LOCAL replay; never count the server replay recorder.
      const playerEpicId = epicId || local.targetEpicId;
      if (!playerEpicId) {
        serverAttempt.status = 'downloaded-no-identity';
        serverAttempt.reason = 'Local replay did not identify an Epic ID to match on the server replay.';
      } else {
        console.error('Scanning downloaded replay for the same Epic account...');
        server = scan(downloaded, playerEpicId);
        if (server.playerResolved) serverAttempt.status = 'parsed';
        else {
          serverAttempt.status = 'player-not-found';
          serverAttempt.reason = 'Player could not be mapped in the downloaded replay.';
        }
      }
    } catch (err) {
      serverAttempt.status = 'unavailable';
      serverAttempt.reason = String(err.message || err).slice(0, 350);
    }
  }

  const chosen = chooseResult(local, server);
  console.log(JSON.stringify({
    sessionId: local.sessionId || null,
    matchCode: code,
    playerEpicId: epicId || local.targetEpicId || null,
    playerName: chosen.data.playerName || local.playerName || null,
    source: chosen.source,
    chestCount: chosen.data.count,
    chests: chosen.data.chestEvents,
    localChestCount: local.count,
    serverChestCount: server?.count ?? null,
    serverAttempt,
    warnings: [
      ...[local.warning].filter(Boolean),
      ...(chosen.source === 'local' && server && server.count != null
        && local.count != null && server.count < local.count
        ? ['Downloaded replay observed fewer chests than local replay; used local count.']
        : [])
    ]
  }, null, 2));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error('Chest scan failed:', err.message || err);
    process.exitCode = 1;
  });
}

module.exports = { main, scan };
