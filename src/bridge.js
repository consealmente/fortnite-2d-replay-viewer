'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BRIDGE_PROJECT = path.join(__dirname, '..', 'bridge', 'bridge.csproj');
const BUNDLED_BRIDGE = path.join(__dirname, '..', 'bridge', 'published', 'bridge');

/**
 * Runs the C# bridge against a `.replay` file and resolves with the parsed
 * viewer model (plain JS object).
 *
 * Uses `dotnet run` so there's no separate build step -- the first run restores
 * packages and compiles the vendored parser (can be 30-60s), every run after is
 * a few seconds. `dotnet run`'s own build chatter goes to stdout; the bridge
 * writes its JSON to a temp file and emits only newline-delimited JSON on
 * stderr ({"progress":n} / {"error":...}), so the two never collide.
 */
function runBridge(replayPath, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `fn2d-${crypto.randomUUID()}.json`);
    const cleanup = () => fs.rm(outPath, { force: true }, () => {});

    const child = spawn(
      process.env.VERCEL ? BUNDLED_BRIDGE : 'dotnet',
      process.env.VERCEL ? [replayPath, outPath] : ['run', '--project', BRIDGE_PROJECT, '-c', 'Release', '--no-launch-profile', '--', replayPath, outPath],
      { windowsHide: true }
    );

    let stdout = '';
    let stderrTail = '';
    let lastError = null;
    let building = true;
    // Heartbeat so the UI moves during the (silent, slow) first-time build.
    let pct = 2;
    const heartbeat = setInterval(() => {
      if (!building) return;
      pct = Math.min(15, pct + 1);
      onProgress(pct);
    }, 1500);

    child.stdout.on('data', (b) => {
      stdout += b;
      if (stdout.length > 20000) stdout = stdout.slice(-20000);
    });

    let stderrBuf = '';
    child.stderr.on('data', (b) => {
      stderrBuf += b;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        stderrTail = (stderrTail + '\n' + trimmed).slice(-4000);
        try {
          const msg = JSON.parse(trimmed);
          if (typeof msg.progress === 'number') {
            building = false;
            onProgress(msg.progress);
          } else if (msg.error) {
            lastError = msg;
          }
        } catch (_) {
          /* non-JSON stderr line (rare) -- kept in stderrTail for diagnostics */
        }
      }
    });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      cleanup();
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            process.env.VERCEL ? 'Bundled replay parser executable was not found in the Vercel deployment.' : "Couldn't run `dotnet`. Install the .NET SDK (https://dotnet.microsoft.com/download) and make sure `dotnet` is on your PATH."
          )
        );
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearInterval(heartbeat);

      if (code !== 0) {
        cleanup();
        if (lastError) {
          console.error('Replay parser exception:', lastError.type, lastError.error, lastError.stack);
          reject(new Error(`Replay parse failed: ${lastError.error}`));
          return;
        }
        const buildErrors = `${stdout}\n${stderrTail}`
          .split('\n')
          .filter((l) => /error (CS|MSB|NU|NETSDK)\d+/.test(l))
          .join('\n');
        reject(
          new Error(
            `The parser bridge exited with code ${code}.\n` +
              (buildErrors ? `Build errors:\n${buildErrors}` : `Output:\n${`${stdout}\n${stderrTail}`.slice(-2000)}`)
          )
        );
        return;
      }

      if (!fs.existsSync(outPath)) {
        cleanup();
        reject(new Error(`Bridge exited 0 but wrote no output. dotnet said:\n${stdout.slice(-1500)}`));
        return;
      }

      try {
        const model = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        cleanup();
        resolve(model);
      } catch (e) {
        cleanup();
        reject(new Error(`Bridge output was not valid JSON: ${e.message}`));
      }
    });
  });
}

module.exports = { runBridge, BRIDGE_PROJECT };
