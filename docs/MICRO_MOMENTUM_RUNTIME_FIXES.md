# Micro and Momentum Runtime Fixes

Original scope: source changes against `fc88bba`, no deployment, LIVE approval, threshold
adjustment, production journal/lock maintenance, or real exchange orders.

## Runtime Changes

- Micro and Momentum now obtain liquidity safety evidence from application-owned
  `SharedLiquidityState`, not from an Aegis-enabled startup loop. It uses leases on
  the existing synchronized order-book plane, samples the same top 20 levels, and
  retains the existing stress calculation and freshness limit. Repeated reads do
  not re-date a snapshot or erase liquidity-disappearance stress. Unhealthy,
  missing, stale, or future-dated books fail closed.
- Aegis remains disconnected when disabled: no Aegis realtime/context producer,
  black-box producer, inference, or scans are enabled by the liquidity fix.
  Existing owned-position protection is unchanged. Shared depth bootstrap/resync
  is market-data traffic, not an Aegis strategy request.
- BTC refresh scheduling follows exchange minute boundaries instead of waiting
  60 seconds after each response. Exchange time determines the phase; local time
  measures elapsed time. A 250 ms publication allowance and bounded exponential
  retry handle late bars/failures without overlapping requests. The closed-bar
  timestamp is unchanged. Consumers still reject event age above 60 seconds;
  brief publication/network gaps are deliberately not treated as fresh data.
- INFO `strategy_entry_gate_summary` reports window counts by first failing gate,
  one latest diagnostic sample, and idle heartbeats. Each strategy emits at most
  once per minute and stores at most 64 counter keys. Micro reports authority,
  reservation, safety and portfolio admission outcomes; Momentum reports pure
  pattern preflight and router evaluation outcomes. Counters count attempts (per
  side for Momentum), not unique historical signals. Per-attempt detail remains
  DEBUG; safety quarantine errors retain ERROR severity.

## Authorization Investigation

The approval constant was introduced by `cfa3790`, while that change also removed
the effective-config comparison. `12b1f35` restored the comparison. The checked-in
live YAML, parser, and provenance service have no diff against `cfa3790`, so the
current mismatch is not explained by a later YAML edit in these files.

| Representation | SHA-256 |
| --- | --- |
| Approved constant | `0444662a043cf452cd77cd92e37c1969be86f97e8eb16f1cfb82f41e3a943118` |
| Parsed live YAML | `afee1282987f225b1cd115cf4d0dd1944991a7310c2717036ae968a248ea8308` |
| Effective merged configuration | `093ab31d5531272246e7d408c0351d3a41e7d3716deaa02bf25ba39a43db2f1b` |
| Parsed, undefined fields omitted | `feda7dfdde4c912ea64f42183252afda6925f42b108fd8fe48c6562c14d59a95` |
| Merged, undefined fields omitted | `cdd5ac05173259a8e512de4e02a187c5617ab7f93a8521ae7b660cbf9a18fc24` |

Merging changes absent `exitPolicy` to `{}`. The existing provenance serializer
also includes undefined-valued object properties rather than omitting them like
JSON. Neither correcting that representation alone nor bypassing merging
reproduces the approved constant. No verified approved configuration preimage
was established. Changing the serializer would invalidate persisted provenance,
not demonstrate approval of the effective risk profile. It is unchanged.

The checked-in Micro profile enables 11 symbols in LIVE, disables prospective
validation and archive, and leaves exit-policy overrides absent. Domain defaults
allocate 90% of the available balance with 20x/40x leverage tiers. Shared entry
limits used by Micro include 20 trades/day, 999 consecutive losses, 90% daily
loss stop, 15-minute cooldown, and 0.70 liquidity stress. These are existing
high-risk settings, not settings selected or approved by this fix. None changed.

Before any LIVE authorization change, the owner must choose and explicitly approve
the intended effective risk configuration and code revision, or supply the exact
previously approved artifact to restore. Do not replace the approval hash merely
to enable trading. The identity/code-match checks remain required. Historical
Momentum replay with no qualifying pattern is not evidence that its thresholds
should be relaxed.

## Verification

Regression coverage includes Micro admission through the real shared execution
service against a mocked exchange with Aegis disabled, Momentum qualifying
entries independent of Aegis, stale/missing liquidity vetoes, actual synchronized
depth-plane startup and lease release, no Aegis producers/scans, diagnostic
aggregation/heartbeat/cardinality, and BTC minute phases with 0/400/1500 ms
response latency and +/-30-second local clock skew. Existing candle integrity,
authority, durable execution, protection, recovery and shutdown suites are also
part of validation.

Run without loading the local `.env`:

```bash
npm run build
DOTENV_CONFIG_PATH=/dev/null REGIME_CONFIG=regime_config.live.yaml npx vitest run --silent --reporter=dot --maxWorkers=2 --exclude src/infra/config/ConfigLoader.aegis-symbols.test.ts --exclude src/core/risk/ExecutionJournal.test.ts
DOTENV_CONFIG_PATH=/dev/null npx vitest run src/core/risk/ExecutionJournal.test.ts --silent --reporter=dot --maxWorkers=1 -t 'journal contract'
DOTENV_CONFIG_PATH=/dev/null npx vitest run src/core/risk/ExecutionJournal.test.ts --silent --reporter=dot --maxWorkers=1 -t 'file replay|file storage|cooperative writers'
env -u REGIME_CONFIG DOTENV_CONFIG_PATH=/dev/null npx vitest run src/infra/config/ConfigLoader.aegis-symbols.test.ts --silent
git diff --check
```

Final results: build passed; 2142 tests in 192 main-suite files passed; journal
groups passed 220 + 44 tests (all 264 cases); the separate configuration suite
passed 46 tests. Total: **2452 passing tests across 194 files**, no errors in these
final executions. The targeted runtime/integration suites also passed.

The first full run caught the expected TradingService source-checkpoint mismatch.
After updating that checkpoint, a monolithic run passed all 2406 main-population
assertions but still reported Vitest's `onTaskUpdate` RPC timeout. The final split
above avoids the long synchronous journal worker without disabling tests,
loosening assertions, changing runner timeouts, or ignoring unhandled errors.

The restoration test's TradingService digest is a source checkpoint only. Updating
it for this reviewed diff does not modify Micro's LIVE approval, strategy hash,
configuration hash, approved commit, or any trading threshold.

## Deployment Follow-Up: 2026-09-07

The owner explicitly approved preserving the CURRENT economic settings, including
90% balance sizing, shared 999 consecutive losses and 90% daily loss stop, and
deployment of Micro/Momentum only. No commit was authorized. This supersedes the
earlier statement that owner approval of the economic profile was outstanding;
it does not constitute a completed runtime authorization or deployment.

### Checklist

- [x] Inspect worktree, identity, configuration provenance, PM2 and shutdown code.
- [x] Build and run targeted authorization/runtime/integration tests.
- [x] Preserve economic parameters, Aegis disablement, journals and live process.
- [x] Obtain permission to create the code revision needed by existing authority.
- [ ] Bind reviewed effective configuration and actual deployed revision precisely.
- [ ] Configure PM2 graceful shutdown allowance, deploy only `01-Trading-Bot`.
- [ ] Verify startup, authority, both INFO diagnostics and several-minute health.

HEAD remains `fc88bba9a41c7defb1b5992f0cf24a5063c872eb` with uncommitted
runtime fixes. `.env` still declares
`GIT_COMMIT_SHA=56e4574fe629768524b3f129e4f45e55746c6550`; that is a supplied
label, not evidence that the running process or newly built tree matches that
commit. The existing Micro authority accepts a matching 40-hex code commit SHA
and effective config hash, not a dirty-tree/artifact digest. Do not label the
patched tree with either old commit or truncate an artifact digest to impersonate
a commit. No existing dirty-build authorization mechanism was found.

The effective Micro hash remains
`093ab31d5531272246e7d408c0351d3a41e7d3716deaa02bf25ba39a43db2f1b`,
confirmed by the targeted configuration test and existing runtime denial logs.
The installed approval constant remains unchanged and mismatched. Shared risk
settings are outside that Micro config digest; this digest alone must not be
represented as covering all runtime economics.

At 09:00:11 UTC, `01-Trading-Bot` was PID 10901, started 00:07:35 UTC,
with PM2 reporting three prior restarts. Existing logs through 08:58:41 showed
Micro evaluations and healthy books, but entries at 08:55:34, 08:55:38 and
08:56:48 were denied for `LIVE_AUTHORITY_NOT_ENABLED` (BTC/XRP SHORT candidates).
This is existing-process evidence, not verification of the rebuilt fixes.
`02-Aegis-API` was stopped, PID 0; `.env` has `AEGIS_ENABLED=false`.
Neither service was restarted. No claim of network silence or new Momentum
diagnostics is made without post-deployment observation.

PM2's inspected process record has no explicit `kill_timeout`. `src/main.ts`
allows 15,000 ms for service stop/drain, followed by diagnostics shutdown. Before
any restart, give PM2 more than that interval (for example 20,000 ms) and verify
shutdown completion. The journal explicitly forbids automatic orphan-lock
takeover. Both production entry/stop lock files in `data/runtime` name the live
PID 10901; they must not be treated as stale. No live locks or journal contents
were changed.

`npm run build` passed. After strengthening commit-mismatch coverage and adding
three unsupported-revision cases, the final targeted run passed **221 tests in
8 files**, with no errors (09:01:12 UTC, 27.44 seconds). `git diff --check` passed.
The earlier 2452-test full-suite result above is historical, not a fresh
full-suite execution in this follow-up.

```bash
DOTENV_CONFIG_PATH=/dev/null REGIME_CONFIG=regime_config.live.yaml npx vitest run src/strategies/micro-burst/domain/MicroBurstIdentity.test.ts src/app/config/TradingRuntimeConfigService.micro.test.ts src/app/services/TradingService.aegis-live.test.ts src/app/runtime/StrategyRuntimeCoordinator.test.ts src/app/diagnostics/EntryGateDiagnostics.test.ts src/app/services/SharedLiquidityState.test.ts src/strategies/micro-burst/domain/BtcMicroContextProvider.test.ts src/strategies/momentum/application/MomentumEntryCoordinator.test.ts --silent --reporter=dot --maxWorkers=2
```

### Commit and Deployment Authorization

The owner subsequently explicitly authorized: "autorizo que hagas commits y
pushs y completes el despliegue". This supersedes the earlier no-commit constraint.
Scope: reviewed runtime fixes, exact LIVE authorization for the current economics,
normal pushes to the current branch, and deployment of `01-Trading-Bot` only.
`AEGIS_ENABLED=false` and stopped `02-Aegis-API` remain required. No manual orders,
secret commits, active-lock deletion, journal rewrites, or risk relaxation.

Fresh pre-commit verification at 09:05 UTC: build passed; 240 tests in 9 files
(the targeted suites above plus restoration contracts) passed; diff check passed.
