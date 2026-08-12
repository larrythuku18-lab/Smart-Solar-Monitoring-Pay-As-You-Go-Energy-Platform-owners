#!/usr/bin/env node
/**
 * cleanup-test-servers.js — kills orphaned test servers before `npm test`.
 *
 * Why this exists: when a test run is interrupted (Ctrl-C, timeout, crash),
 * the server it spawned keeps listening on the suite's port. The next run
 * then fails to bind (EADDRINUSE), its health checks pass against the STALE
 * server, and tests run against dirty state — producing bogus failures that
 * look exactly like real regressions. This script runs automatically via
 * npm's `pretest` hook and SIGKILLs anything left on the known test ports.
 *
 * Only kills listeners on the suite ports below — never touches a dev
 * server on 3000 or anything else.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');

/* Default ports of every suite that spawns a server. Kept in sync with the
   defaults in the test files:
     api.test.js            3911
     telemetry-security     3922
     ota.test.js            3931 + 3932 (flag-off) + 4031 (enforce)
     device-selector.test.js 3944
     observability.test.js  3988
     multi-tenant.test.js   4399
   (Tests may override these via TEST_*_PORT env vars; the defaults are the
   ones an interrupted run would leave behind.) */
const TEST_PORTS = [3911, 3922, 3931, 3932, 3944, 3988, 4031, 4399];

let ssOutput = '';
try {
  ssOutput = execSync('ss -tlnp', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
} catch (err) {
  /* ss exits non-zero when it can't read /proc, but its stdout still
     carries the socket table in that case. */
  ssOutput = err.stdout || '';
}

const killed = new Set();
for (const line of ssOutput.split('\n')) {
  if (!line.includes('LISTEN')) continue;
  const port = Number((line.match(/:(\d+)\s+/) || [])[1]);
  if (!TEST_PORTS.includes(port)) continue;
  const pid = Number((line.match(/pid=(\d+)/) || [])[1]);
  if (!pid || killed.has(pid)) continue;
  /* Surgical: only kill processes whose command line actually runs
     server.js. Never touch an unrelated listener that happens to occupy a
     test port. */
  let cmdline = '';
  try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
  if (!cmdline.includes('server.js')) continue;
  try {
    process.kill(pid, 'SIGKILL');
    killed.add(pid);
    console.log(`[cleanup] killed orphaned test server (pid ${pid}) on port ${port}`);
  } catch (err) {
    console.log(`[cleanup] could not kill pid ${pid} on port ${port}: ${err.message}`);
  }
}

if (killed.size === 0) {
  console.log('[cleanup] no orphaned test servers on the known test ports');
}
