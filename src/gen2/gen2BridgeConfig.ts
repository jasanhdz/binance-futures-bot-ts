/**
 * Pure, side-effect-free helpers for reading the shared gen2_config.yaml.
 * Extracted from gen2_bridge_main.ts (which self-executes main() on import and
 * so cannot be safely unit-tested directly) so these can be tested in isolation.
 *
 * SINGLE SOURCE OF TRUTH: gen2_config.yaml drives both execution enablement and
 * the executable symbol allowlist — the SAME list Aegis analyzes and ranks, so
 * the bridge can never diverge from what Aegis is scoring. Env vars can only
 * DENY execution (emergency), never enable it and never expand/replace symbols.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export interface ConfigExecutionResult {
  enabled: boolean;
  valid: boolean;
  reason: string;
}

/** repoRoot = the binance-futures-bot-ts directory. gen2_config.yaml lives at
 * .../aegis_gen2/gen2_config.yaml, a SIBLING of trading_system (per GEN2_ROOT
 * in aegis_alpha/tools/gen2_d3_common.py) -> two levels up, not one. */
export function resolveConfigPath(repoRoot: string, envOverride?: string): string {
  return envOverride || path.resolve(repoRoot, '..', '..', 'aegis_gen2', 'gen2_config.yaml');
}

export function readConfigExecutionEnabled(configPath: string): ConfigExecutionResult {
  try {
    if (!fs.existsSync(configPath)) return { enabled: false, valid: false, reason: 'CONFIG_MISSING' };
    const cfg = yaml.load(fs.readFileSync(configPath, 'utf-8')) as any;
    if (!cfg || typeof cfg !== 'object') return { enabled: false, valid: false, reason: 'CONFIG_INVALID' };
    return { enabled: cfg.execution_enabled === true, valid: true, reason: 'OK' };
  } catch (e: any) {
    return { enabled: false, valid: false, reason: `CONFIG_READ_ERROR:${String(e?.message || e).slice(0, 60)}` };
  }
}

/** Fail-closed: config missing/invalid/no symbols array -> empty list (no
 * symbol can execute). */
export function readConfigSymbols(configPath: string): string[] {
  try {
    if (!fs.existsSync(configPath)) return [];
    const cfg = yaml.load(fs.readFileSync(configPath, 'utf-8')) as any;
    const symbols = cfg?.symbols;
    if (!Array.isArray(symbols)) return [];
    return symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  } catch {
    return [];
  }
}

export function emergencyDenyActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.GEN2_EXECUTION_ENABLED;
  return v !== undefined && ['false', '0', 'off', 'no', 'disable', 'disabled'].includes(v.trim().toLowerCase());
}
