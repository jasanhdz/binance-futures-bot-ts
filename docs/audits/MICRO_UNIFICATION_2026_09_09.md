# Canonical Micro Integration

## Scope

Continued the existing uncommitted integration over
`0f4e96b35ecbdd17121df617c46d4d9a84d63d7a`. No baseline checkout, journal rewrite,
ledger reset, key generation or new strategy branch was used. The historical Git
branch name is not a runtime strategy selector.

The operator authorizes the current Micro policy in LIVE with a 90% available-wallet
allocation including fee reserve, 20x/30x heuristic confidence tiers, and a persistent
halt after three confirmed consecutive net losses. No separate USDT risk budget is
introduced. The 25-USDT integration account is synthetic, not a live balance claim.

## Contract

- New routes, strategy identities, trade IDs, runtime policy diagnostics and entry
  evaluation use `MICRO_BURST` / `MICRO`. YAML version/entry selectors are rejected.
  There is no active baseline or research-policy fallback for new entries.
- Historical identity recognition remains at read/recovery boundaries. Signed ledger
  metadata, command signatures, trade-policy digests, exchange client IDs and journal
  operation IDs retain their original bytes. Historical net outcomes remain included
  in account-wide reconstruction, and old/new daily Micro counts share one projection.
- Causal episode hashes retain their historical hash input. Before preparing a new
  canonical entry, the durable coordinator checks the corresponding historical
  operation as well. Renaming does not reopen a terminal or unknown episode.
- Entry sizing requires signed commission/account evidence, one-way isolated margin,
  continuous maintenance-bracket coverage, conservative stressed liquidation geometry,
  executable depth and explicit fee reserve. Margin plus reserve fits within the
  approved allocation. Confidence scores are not calibrated probabilities.
- Current policy snapshots and episode identity precede durable PREPARED. Exit economics
  use full-quantity executable VWAP, net MFE and adaptive giveback, with one bounded
  target extension and a persisted blind-feed deadline. Stops never widen.
- Stop adjustment persists the exact old cancellation targets before submitting the
  new quantity-bound reduce-only order. It confirms exact replacement identity and
  current quantity before durably preparing old-order cancellation. Unknown submission
  or cancellation remains observation-only across restart. Final projection checks
  prevent an asynchronous flush from overwriting a newer trade.
- Missing replacement protection permits only the existing identified durable close
  after repeated successful inventories and fresh unchanged position evidence. Unknown
  reads do not imply missing protection. Offline fixtures do not prove Binance accepts
  overlapping protection on this account.
- The existing ledger keeps initialization, revision, streak and halt across the rename.
  Missing state fails closed. Midnight, restart or post-halt wins do not reset the halt;
  reset requires a valid external operator signature and complete accounting.

## Reviewed Configuration

Effective canonical Micro config SHA-256:
`132879584379e97474309df05d99552a6b835fecdcbe38d3b586b7bfb76633e1`

YAML source SHA-256:
`5935f7cbf9c1837efa82e84e226dcb9f4e7e4a182ff06b975f98ebae6ce97a1e`

The approved config is explicit: `MARGIN_FRACTION`, `margin_fraction: 0.9`, leverage
20/30, loss count 3, `SIGNED_OPERATOR`, 14-bps fee reserve and 10-bps stop stress.
The runtime commit approval remains separate from the observed source commit.
Source-integrity checkpoints cover the reviewed changes; they are not artifact
attestations. Architecture exceptions name only the exact durable policy/settlement
contract imports, not arbitrary strategy implementations or mutation authority.

## Verification

All test invocations use `AEGIS_ENABLED=false`. The final serial run passed 2,747 tests in
208 files. Four Aegis-specific suites were excluded because their tests expect enabled
Aegis behavior: `TradingService.aegis-gate.test.ts`, `TradingService.aegis.test.ts`,
`TradingService.exit-eye.test.ts`, and `AegisMLAdapter.test.ts`. The preceding full
run failed those expectations, source/architecture checkpoints and one worker RPC
timeout; it is not a passing full-suite result. A later parallel run passed all 2,747
assertions but repeated the RPC timeout; only the clean serial result is accepted.
Checkpoints and canonical fixtures
were subsequently corrected. No operational Aegis process was activated.

The final stop-projection follow-up adds two newer-trade/flush-failure cases; all 15
simulated production-flow cases passed. TypeScript no-emit and external compilation
passed; the staging output is `/tmp/opencode/micro-canonical-20260909-build`.
The full orchestrator fixture starts shared depth/trade/candle feeds with Aegis disabled,
reports canonical Micro decisions, retains ADA quarantine and releases subscriptions.
These are offline contract tests, not profitability or exchange acceptance evidence.

## Read-Only Operational Evidence

At `2026-09-09T04:46:47.983Z`, the existing production ledger passed SQLite integrity,
scope, pinned-public-key and signature checks: initialized, revision 1, epoch 1,
streak 0, halt false, zero pending settlements and one signed command. Public/private
key permissions were both `0600`. No initialization or reset was performed.

The allowlisted audit completed five signed GET requests with zero mutations, retries,
redirects or non-allowlisted requests: one-way account, zero active positions, zero
regular orders and zero algo orders. Files are under
`/tmp/opencode/micro-readonly-audit-20260909/`.

Historical ADA reads returned two fills and exact FILLED orders:

| Order       | Side | Quantity | Price  | Commission USDT |
| ----------- | ---- | -------- | ------ | --------------- |
| 67663831129 | SELL | 3295     | 0.2189 | 0.36063775      |
| 67665430845 | BUY  | 3295     | 0.2233 | 0.36788675      |

The closing fill reports gross realized PnL `-14.498` USDT. The bounded funding query
for the known entry-to-flat interval returned no rows and was not saturated. These
observations imply `-15.2265245` USDT after the two reported commissions for those
matched fills, but do not reconstruct a missing policy/episode or authorize clearing
quarantine. The fill-reader command returned evidence before its adapter background
timer kept the process alive until timeout; the subsequent exact-order/funding read
completed at `2026-09-09T04:55:06.523Z`. No manual real-money test order was sent.

ADA remains IDLE with `marketOpenAmbiguous` and `microBurstPnlUnverified`, without
policy/settlement provenance. Additional historical symbol ambiguity flags also remain.
Flat exchange state is not proof of an unknown stop's terminal identity or permission
to erase accounting state. New deployment selection must be distinguished from entry
admission while those protections remain in force.

## Deployment Boundary

Before deployment PM2 reported trading PID 1908 and Aegis API stopped. This differs
from older documents' PID 627698; neither PID is an artifact attestation. Deployment
requires a clean committed source, explicit matching config/commit approval, graceful
shutdown with natural journal-lock release, a matching compiled artifact, and a fresh
monitoring interval. This source document alone does not assert deployment completion.
