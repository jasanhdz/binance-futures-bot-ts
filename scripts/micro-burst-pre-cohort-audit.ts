#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createMicroBurstV1Identity } from '../src/domain/strategies/micro-burst/MicroBurstIdentity';
import { assessMicroBurstReadiness } from '../src/domain/strategies/micro-burst/MicroBurstReadiness';

const root = resolve(__dirname, '..');
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const configPath = resolve(root, 'config/micro-burst-m3_2_2-soak.yaml');
const configHash = createHash('sha256').update(readFileSync(configPath)).digest('hex');
const identity = createMicroBurstV1Identity(git('rev-parse', 'HEAD'));
const mutationAuditAvailable = existsSync(resolve(root, 'src/infra/telegram/TelegramMutationAuditWriter.ts'));

// This command only inspects local files. Runtime/archive evidence is intentionally unknown.
const readiness = assessMicroBurstReadiness({
  codeSha: identity.codeCommitSha,
  configHash,
  strategyVersion: identity.strategyVersion,
  mode: 'SHADOW',
  enabled: true,
  enabledSymbolCount: 2,
  archiveEnabled: true,
  archiveAvailable: false,
  preregistrationEnabled: true,
  mutationAuditAvailable,
});

console.log(JSON.stringify({ ...readiness, readyForSoak: readiness.ready }, null, 2));
