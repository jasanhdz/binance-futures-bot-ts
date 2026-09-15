import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  HISTORICAL_EXTERNAL_SYMBOLS,
  retireHistoricalExternalState,
  sha256Text,
} from '../src/tooling/micro-burst/HistoricalExternalStateMigration';

const APPLY = process.argv.includes('--apply');
const evidencePath = argument('--evidence');
const planPath = argument('--plan');
const outputPath = argument('--output') ?? '/tmp/opencode/micro-historical-migration-plan.json';
const targetSymbols = HISTORICAL_EXTERNAL_SYMBOLS;
if (!evidencePath)
  throw new Error('Uso: ... --evidence READONLY_AUDIT_JSON [--apply --plan PLAN_JSON]');

const evidenceText = readFileSync(resolve(evidencePath), 'utf8');
const evidence = JSON.parse(evidenceText) as Record<string, unknown>;
const account = evidence.account_audit as Record<string, unknown> | undefined;
const accountAudit = account ?? evidence;
const preconditionErrors = verifyEvidence(accountAudit);
const states = Object.fromEntries(targetSymbols.map((symbol) => [symbol, readState(symbol)]));
for (const [symbol, state] of Object.entries(states)) {
  if (!state) preconditionErrors.push(`${symbol}:LOCAL_STATE_MISSING`);
  else if (
    state.mode !== 'IDLE' ||
    state.marketOpenAmbiguous !== true ||
    state.positionOwner !== 'EXTERNAL' ||
    state.tradeOrigin !== 'MANUAL_EXTERNAL'
  )
    preconditionErrors.push(`${symbol}:STATE_CHANGED_OR_NOT_EXTERNAL_IDLE`);
}
for (const file of journalFiles()) {
  if (existsSync(`${file}.lock`)) preconditionErrors.push(`JOURNAL_LOCK_PRESENT:${file}`);
  for (const row of readJsonLines(file)) {
    const symbol = String(row.symbol ?? row.metadata?.request?.intent?.symbol ?? '');
    if ((targetSymbols as readonly string[]).includes(symbol))
      preconditionErrors.push(
        `TARGET_JOURNAL_ACTIVITY:${symbol}:${String(row.event ?? 'UNKNOWN')}`,
      );
  }
}

const migrationId = `historical-external-retirement-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID()}`;
const authorizedAt = new Date().toISOString();
const evidenceSha256 = sha256Text(evidenceText);
const plan = {
  schema_id: 'micro-burst-historical-external-migration-plan-v1',
  migrationId,
  authorizedAt,
  symbols: targetSymbols,
  evidencePath,
  evidenceSha256,
  preconditionErrors,
  states: Object.fromEntries(
    Object.entries(states).map(([symbol, state]) => [
      symbol,
      state ? { sha256: sha256Text(JSON.stringify(state)), state } : null,
    ]),
  ),
  apply: false,
};
if (!APPLY) {
  mkdirSync(dirname(resolve(outputPath)), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(outputPath), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...plan, planPath: outputPath }, null, 2));
  process.exit(preconditionErrors.length ? 2 : 0);
}
if (!planPath) throw new Error('HISTORICAL_MIGRATION_PLAN_REQUIRED_FOR_APPLY');
const recorded = JSON.parse(readFileSync(resolve(planPath), 'utf8')) as typeof plan;
if (
  recorded.schema_id !== plan.schema_id ||
  recorded.evidenceSha256 !== evidenceSha256 ||
  recorded.preconditionErrors.length > 0
)
  throw new Error('HISTORICAL_MIGRATION_PLAN_INVALID');
if (preconditionErrors.length)
  throw new Error(`HISTORICAL_MIGRATION_PRECONDITION_FAILED:${preconditionErrors.join(',')}`);

const archiveDir = resolve('data/runtime/migrations', migrationId);
mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
for (const symbol of targetSymbols) {
  const path = statePath(symbol);
  const before = readFileSync(path, 'utf8');
  const current = JSON.parse(before) as Parameters<typeof retireHistoricalExternalState>[0];
  const expected = recorded.states[symbol]?.sha256;
  if (!expected || sha256Text(JSON.stringify(current)) !== expected)
    throw new Error(`STATE_CHANGED:${symbol}`);
  writeFileSync(resolve(archiveDir, `${symbol}.before.json`), before, { mode: 0o600 });
  const next = retireHistoricalExternalState(current, {
    migrationId,
    authorizedAt,
    evidenceSha256,
    previousStateSha256: sha256Text(before),
  });
  atomicWrite(path, JSON.stringify(next, null, 2) + '\n');
  writeFileSync(resolve(archiveDir, `${symbol}.after.json`), JSON.stringify(next, null, 2) + '\n', {
    mode: 0o600,
  });
}
writeFileSync(resolve(archiveDir, 'evidence.json'), evidenceText, { mode: 0o600 });
writeFileSync(
  resolve(archiveDir, 'manifest.json'),
  JSON.stringify({ ...plan, apply: true, archiveDir }, null, 2) + '\n',
  { mode: 0o600 },
);
console.log(
  JSON.stringify({ migrationId, archiveDir, symbols: targetSymbols, status: 'APPLIED' }, null, 2),
);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function statePath(symbol: string): string {
  return resolve(`data/state_PROD_AEGIS_STATE_JSON_${symbol}.json`);
}
function readState(symbol: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(statePath(symbol), 'utf8'));
  } catch {
    return null;
  }
}
function journalFiles(): string[] {
  return [
    'entry-mutations-binance-futures-bot-primary-production.jsonl',
    'stop-mutations-binance-futures-bot-primary-production.jsonl',
    'close-mutations-binance-futures-bot-primary-production.jsonl',
  ].map((name) => resolve('data/runtime', name));
}
function readJsonLines(path: string): Record<string, any>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}
function verifyEvidence(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (value.account_mode !== 'ONE_WAY') errors.push('ACCOUNT_MODE_NOT_ONE_WAY');
  if (value.audit_completeness !== 'COMPLETE') errors.push('ACCOUNT_AUDIT_INCOMPLETE');
  if (!Array.isArray(value.active_positions) || value.active_positions.length !== 0)
    errors.push('ACTIVE_POSITIONS_PRESENT');
  if (!Array.isArray(value.regular_orders) || value.regular_orders.length !== 0)
    errors.push('REGULAR_ORDERS_PRESENT');
  if (!Array.isArray(value.algo_orders) || value.algo_orders.length !== 0)
    errors.push('ALGO_ORDERS_PRESENT');
  return errors;
}
function atomicWrite(path: string, content: string): void {
  const temp = `${path}.migration-${process.pid}`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
