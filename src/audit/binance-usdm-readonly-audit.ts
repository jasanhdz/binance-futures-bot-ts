import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  AUDIT_MODE,
  BinanceUsdmReadOnlyAuditClient,
  type AuditNetworkCounters,
} from './binance-usdm-readonly-audit-client';
import {
  reconcileAuditResponses,
  reconcileLocalExchangeState,
  type LocalStateSummary,
} from './binance-usdm-readonly-reconciliation';

interface CliArguments {
  targetService: string;
  outputRoot: string;
  mode: string;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const value = (name: string): string => {
    const index = argv.indexOf(name);
    if (index < 0 || !argv[index + 1]) throw new Error(`AEGIS_AUDIT_ARGUMENT_REQUIRED:${name}`);
    return argv[index + 1];
  };
  return {
    targetService: value('--target-pm2-service'),
    outputRoot: resolve(value('--output-root')),
    mode: value('--mode'),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('AEGIS_AUDIT_CANONICALIZATION_FAILED');
  return encoded;
}

function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, `${canonicalJson(value)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function assertZeroMutationCounters(counters: AuditNetworkCounters): void {
  if (
    counters.non_get_attempts !== 0 ||
    counters.non_allowlisted_endpoint_attempts !== 0 ||
    counters.mutation_requests !== 0 ||
    counters.trade_requests !== 0 ||
    counters.order_requests !== 0 ||
    counters.cancellation_requests !== 0 ||
    counters.leverage_margin_mutation_requests !== 0 ||
    counters.money_movement_requests !== 0
  ) {
    throw new Error('AEGIS_LIVE_AUDIT_MUTATION_ATTEMPT');
  }
}

export function scanLocalState(stateRoot: string): LocalStateSummary {
  const summary: LocalStateSummary = {
    state_file_count: 0,
    managed_position_count: 0,
    pending_order_count: 0,
    mutation_in_flight: false,
    incomplete_state_count: 0,
    managed_position_files: [],
    pending_order_files: [],
  };
  if (!existsSync(stateRoot)) {
    summary.incomplete_state_count = 1;
    return summary;
  }
  const names = readdirSync(stateRoot).filter(
    (name) => name.startsWith('state_PROD_AEGIS_STATE_JSON') && name.endsWith('.json'),
  );
  summary.state_file_count = names.length;
  summary.mutation_in_flight = readdirSync(stateRoot).some(
    (name) => name.startsWith('state_PROD_AEGIS_STATE_JSON') && name.includes('.tmp'),
  );
  for (const name of names) {
    try {
      const value = JSON.parse(readFileSync(resolve(stateRoot, name), 'utf8')) as Record<
        string,
        unknown
      >;
      if (typeof value.mode !== 'string') {
        summary.incomplete_state_count += 1;
        continue;
      }
      if (value.mode !== 'IDLE') {
        summary.managed_position_count += 1;
        summary.managed_position_files.push(basename(name));
      }
      const bracket = String(value.lastBracketStatus ?? '').toUpperCase();
      if (['PENDING', 'SUBMITTING', 'PARTIALLY_FILLED', 'UNKNOWN'].includes(bracket)) {
        summary.pending_order_count += 1;
        summary.pending_order_files.push(basename(name));
      }
    } catch {
      summary.incomplete_state_count += 1;
    }
  }
  return summary;
}

export async function runBoundedAudit(
  args: CliArguments,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (args.mode !== AUDIT_MODE) throw new Error('AEGIS_AUDIT_MODE_INVALID');
  if (args.targetService !== '01-Trading-Bot') throw new Error('AEGIS_AUDIT_TARGET_INVALID');
  mkdirSync(args.outputRoot, { recursive: true, mode: 0o700 });
  chmodSync(args.outputRoot, 0o700);
  const apiKey = environment.BINANCE_API_KEY ?? '';
  const apiSecret = environment.BINANCE_API_SECRET ?? '';
  const client = new BinanceUsdmReadOnlyAuditClient({ apiKey, apiSecret, mode: AUDIT_MODE });
  const responses: Partial<{
    account: Awaited<ReturnType<typeof client.getAccountInformationV3>>;
    positions: Awaited<ReturnType<typeof client.getPositionInformationV3>>;
    mode: Awaited<ReturnType<typeof client.getCurrentPositionMode>>;
    regularOrders: Awaited<ReturnType<typeof client.getAllOpenOrders>>;
    algoOrders: Awaited<ReturnType<typeof client.getAllOpenAlgoOrders>>;
  }> = {};
  let failureCode: string | null = null;
  try {
    responses.account = await client.getAccountInformationV3();
    responses.positions = await client.getPositionInformationV3();
    responses.mode = await client.getCurrentPositionMode();
    responses.regularOrders = await client.getAllOpenOrders();
    responses.algoOrders = await client.getAllOpenAlgoOrders();
  } catch (error) {
    failureCode = error instanceof Error ? error.message : 'AEGIS_AUDIT_ENDPOINT_FAILURE';
  }
  assertZeroMutationCounters(client.counters);
  writePrivateJson(resolve(args.outputRoot, 'readonly_audit_network_counters.json'), {
    schema_id: 'aegis-binance-usdm-readonly-network-counters-v1',
    target_service: args.targetService,
    mode: AUDIT_MODE,
    ...client.counters,
  });
  if (failureCode || Object.keys(responses).length !== 5) {
    writePrivateJson(resolve(args.outputRoot, 'unmanaged_live_read_only_account_audit.json'), {
      schema_id: 'aegis-unmanaged-live-readonly-account-audit-v1',
      audit_completeness:
        client.counters.authentication_failures > 0
          ? 'INCOMPLETE_AUTHENTICATION'
          : 'INCOMPLETE_ENDPOINT_FAILURE',
      failure_codes: [failureCode ?? 'AEGIS_AUDIT_ENDPOINT_FAILURE'],
      credential_status: apiKey && apiSecret ? 'PRESENT' : 'ABSENT',
      raw_responses_persisted: false,
    });
    return 2;
  }
  const result = reconcileAuditResponses(responses as Required<typeof responses>);
  const local = scanLocalState(resolve(process.cwd(), 'data'));
  const localConsistency = reconcileLocalExchangeState(local, result);
  const base = {
    schema_id: 'aegis-unmanaged-live-readonly-account-audit-v1',
    target_service: args.targetService,
    credential_status: 'PRESENT',
    raw_responses_persisted: false,
    ...result,
  };
  writePrivateJson(resolve(args.outputRoot, 'unmanaged_live_read_only_account_audit.json'), base);
  writePrivateJson(resolve(args.outputRoot, 'unmanaged_live_position_reconciliation.json'), {
    schema_id: 'aegis-unmanaged-live-position-reconciliation-v1',
    audit_completeness: result.audit_completeness,
    account_mode: result.account_mode,
    active_positions: result.active_positions,
    active_position_count: result.counters.active_position_count,
  });
  writePrivateJson(resolve(args.outputRoot, 'unmanaged_live_order_reconciliation.json'), {
    schema_id: 'aegis-unmanaged-live-order-reconciliation-v1',
    audit_completeness: result.audit_completeness,
    regular_orders: result.regular_orders,
    algo_orders: result.algo_orders,
    ...result.counters,
  });
  writePrivateJson(resolve(args.outputRoot, 'unmanaged_live_local_exchange_consistency.json'), {
    schema_id: 'aegis-unmanaged-live-local-exchange-consistency-v1',
    audit_completeness: result.audit_completeness,
    local_state: local,
    exchange_active_position_count: result.counters.active_position_count,
    exchange_open_order_count:
      result.counters.regular_open_order_count + result.counters.algo_open_order_count,
    consistency_classification: localConsistency,
    safe_retirement_gate:
      result.safe_retirement_exchange_gate && localConsistency === 'CONSISTENT_FLAT',
  });
  return result.audit_completeness === 'COMPLETE' ? 0 : 3;
}

if (require.main === module) {
  runBoundedAudit(parseArguments(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const safeMessage = error instanceof Error ? error.message : 'AEGIS_AUDIT_FAILED';
      process.stderr.write(`${safeMessage}\n`);
      process.exitCode = 1;
    });
}
