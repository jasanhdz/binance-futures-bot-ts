/**
 * GEN2 PM2 ecosystem — always-on canary services. ADDITIVE: does not touch the
 * live bot's processes. Start:  pm2 start ecosystem.gen2.config.js && pm2 save
 *
 * Secrets live in .env.gen2 (gitignored, same directory); this file injects
 * them into every app at load time so nothing sensitive is committed.
 *
 * Processes:
 *   gen2-bridge     — TS execution bridge (dry-run unless GEN2_EXECUTION_ENABLED=true)
 *   gen2-watcher    — Aegis decision loop --watch --live (paper-only until armed)
 *   gen2-monitor    — ops monitor, cron every 15 min (exit 1 => errored => visible)
 *   gen2-reconciler — second-opinion reconciliation, cron every 30 min
 *
 * The watcher MUST run under /home/jasan/.venv_rocm62/bin/python (the freeze
 * environment); the loop refuses any other interpreter fail-closed.
 */
const fs = require('fs');
const path = require('path');

const TS_REPO = __dirname;
const PY_REPO = path.resolve(__dirname, '..');
const FREEZE_PYTHON = '/home/jasan/.venv_rocm62/bin/python';
const LOG_DIR = path.join(TS_REPO, 'logs', 'gen2');

function loadEnvFile() {
  const envPath = path.join(TS_REPO, '.env.gen2');
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[2] !== '') env[m[1]] = m[2];
    }
  }
  return env;
}

const sharedEnv = loadEnvFile();

module.exports = {
  apps: [
    {
      name: 'gen2-bridge',
      cwd: TS_REPO,
      script: path.join(TS_REPO, 'node_modules', '.bin', 'ts-node'),
      args: 'src/gen2/gen2_bridge_main.ts',
      interpreter: 'none',
      env: sharedEnv,
      autorestart: true,
      restart_delay: 5000,
      exp_backoff_restart_delay: 5000,
      max_memory_restart: '400M',
      out_file: path.join(LOG_DIR, 'bridge.out.log'),
      error_file: path.join(LOG_DIR, 'bridge.err.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'gen2-watcher',
      cwd: PY_REPO,
      script: path.join(PY_REPO, 'aegis_alpha', 'tools', 'gen2_decision_loop.py'),
      args: '--watch --live --interval-seconds 300',
      interpreter: FREEZE_PYTHON,
      env: sharedEnv,
      autorestart: true,
      restart_delay: 15000,
      exp_backoff_restart_delay: 15000,
      max_memory_restart: '1500M',
      kill_timeout: 30000,
      out_file: path.join(LOG_DIR, 'watcher.out.log'),
      error_file: path.join(LOG_DIR, 'watcher.err.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'gen2-monitor',
      cwd: PY_REPO,
      script: path.join(PY_REPO, 'aegis_alpha', 'tools', 'gen2_ops_monitor.py'),
      // always-on: continuously online, re-checks every 15 min (was cron; a
      // cron job shows "stopped" between runs which is indistinguishable from a
      // dead process — the loop stays visibly online for a 24/7 canary).
      args: '--expect-watch-running --loop --interval-seconds 900',
      interpreter: FREEZE_PYTHON,
      env: sharedEnv,
      autorestart: true,
      restart_delay: 10000,
      max_memory_restart: '400M',
      out_file: path.join(LOG_DIR, 'monitor.out.log'),
      error_file: path.join(LOG_DIR, 'monitor.err.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'gen2-reconciler',
      cwd: PY_REPO,
      script: path.join(PY_REPO, 'aegis_alpha', 'tools', 'gen2_canary_exec.py'),
      args: '--mode second-opinion --loop --interval-seconds 1800',
      interpreter: FREEZE_PYTHON,
      env: sharedEnv,
      autorestart: true,
      restart_delay: 15000,
      max_memory_restart: '600M',
      out_file: path.join(LOG_DIR, 'reconciler.out.log'),
      error_file: path.join(LOG_DIR, 'reconciler.err.log'),
      merge_logs: true,
      time: true,
    },
    {
      // Daily SAFE maintenance: segments evidence by month and rotates op logs.
      // NEVER deletes scientific evidence, never touches orders. cron 04:20 UTC.
      name: 'gen2-maintenance',
      cwd: PY_REPO,
      script: path.join(PY_REPO, 'aegis_alpha', 'tools', 'gen2_maintenance.py'),
      args: '--mode compact',
      interpreter: FREEZE_PYTHON,
      env: sharedEnv,
      autorestart: false,
      cron_restart: '20 4 * * *',
      out_file: path.join(LOG_DIR, 'maintenance.out.log'),
      error_file: path.join(LOG_DIR, 'maintenance.err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
