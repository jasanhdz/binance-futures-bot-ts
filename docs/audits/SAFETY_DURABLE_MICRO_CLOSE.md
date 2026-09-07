# Identified Durable Managed Micro Closes

## Scope

Local, uncommitted increment. No commit, push, bot startup, authenticated exchange
access, real order, or environment-file edit. Existing fallback-candle and startup
wording changes were preserved. This is not deployment authorization.

Covered: the intelligent exit callback registered by TradingService and the explicit
runtime protection RECOVERY_REQUIRED emergency, for already-managed BOT-owned
MICRO_BURST_V1 positions. A read/persistence error alone is not an emergency verdict.
The policy that chooses an intelligent exit is unchanged.

Not covered: Shared pre-handoff emergencies, Aegis/Momentum closes, universal
bracket mutation, full exposure inventory, monetary reservations, or an attributable
fill/cost/PnL ledger. General safety phases, including Phase 9, remain PARTIAL.

## Production Route

`StrategyComposition -> TradingService -> DurableCloseCoordinator ->
ExecutionJournal + IdentifiedClosePort/BinanceExchange`.

- Production always composes the coordinator. Missing identified send, exact lookup,
  or fresh position capability fails startup closed, not back to the legacy transport.
- Direct constructors without the coordinator retain existing unit-test/legacy seams;
  these are not an alternative production wiring or a durable-close guarantee.
- Construction is disk-lazy. Startup opens the unique, ancestor-fsynced writer at
  `data/runtime/close-mutations-binance-futures-bot-primary-{production|testnet}.jsonl`.
  Scope is the existing single-account project convention, not discovered exchange
  account identity. Credential/account changes require operator intervention.
- Stop/cancel startup precedes close recovery, then entry recovery. Close recovery is
  independent of the entry switch, runs at startup and on the existing watchdog, and
  can run from pending Micro management. It does not start market-data producers.
- Shared admission consumes `closeMutationBlockedReason`; it blocks synchronously
  while close work is active and while any unresolved close or coordinator failure
  remains. Pending work is exclusion, NOT a computed monetary reserve.
- Shutdown drains runtime work, then entry, close, and stop coordinators in that
  order. Close recovery may still need the stop/cancel writer while draining. Each
  close coordinator waits for startup and its transport/recovery tasks before flush
  and close, preserving both failures through RuntimeShutdownError.

## Request And Evidence

One attempt per scope and parentTradeId. `operationId = close:<sha256>` and
`clientOrderId = bot_cl_<first 28 hex>` are stable; changing symbol, side, quantity,
parent order or local ownership cannot obtain another attempt for that parent.
Pending requests also fence their symbol against a replacement local parent.

PREPARED persists MICRO_CLOSE_V1, scope, parent trade/order, symbol, strategy, side,
positionSide, exact quantity and entry price, original local identity, CID and
notBeforeMs. The expected state comes from the caller's decision context, not a
reinterpretation of whatever newer trade exists after waiting. Local and fresh
exchange quantity/entry/mode must match exactly. A smaller residual is not rounded
or closed by a new attempt.

Only the invocation creating durable PREPARED may call sendMarketCloseOnce. It
revalidates local identity and fresh exchange position after persistence. PREPARED
recovered from disk is lookup-only, including when no send actually happened.
State quarantine is flushed before PREPARED; journal append and flush must succeed
before send. Storage failure blocks the instance, not just the current call.

An initial fresh-position read rejection, before any pending request, state write or
PREPARED, returns false without setting the global failure flag. The synchronous
busy gate is released; neither the same nor unrelated symbols remain close-blocked.
Existing protection/accounting flags are preserved exactly, not cleared or newly
quarantined. A later invocation may retry preflight. This exception is scoped only
to that exchange read: startup/journal failures and post-preparation uncertainty
retain their existing fail-closed handling and never authorize a resend.

The adapter sends one SDK futuresOrder MARKET request with stable newClientOrderId,
exact quantity and positionSide. BOTH requires reduceOnly=true; hedge sends the
explicit LONG/SHORT side without reduceOnly. There is no mode discovery, fallback,
sizing retry or rejection-code resend. Signed timestamp/recvWindow are transport
concerns, not persisted secrets. ACK is deliberately not a fill verdict: every send
is followed by UNKNOWN and exact lookup, even when the transport returns normally.

Lookup uses futuresGetOrder with origClientOrderId. Evidence requires exact symbol,
CID, safe positive order ID, MARKET type, closing direction, exact positionSide,
explicit correct reduceOnly semantics, original quantity, finite executed quantity,
recognized status, and creation/update times compatible with the request. FILLED
requires the entire requested quantity; contradictory or incomplete fields fail
closed. Error, absence, timeout, NEW, CANCELED or EXPIRED alone cannot settle a close.
The installed SDK's authenticated transport performs one fetch; tests mock the SDK,
not an exchange. No operational API compatibility certification is claimed.

## Flat, Cleanup And Accounting

- Exact full-fill evidence is necessary but not sufficient. Fresh, uncached flat
  observations must precede protective cleanup; timeout/undefined is not flat.
- An observed partial fill or post-fill residual records a durable RECOVERY_REQUIRED
  quarantine and is not automatically retried or cleared on a later flat snapshot.
- Cleanup reuses PositionProtectionService.cleanupMicroCloseOrders and the existing
  DurableStopCoordinator cancel protocol. It requires its own fresh flat checks,
  exact BOT protective targets, confirmed cancellation and no BOT survivors. Foreign
  orders are not canceled. A pending cancel keeps the close pending.
- The final fresh flat check and immutable identity precede the existing
  persistMicroOperationalClose. All identified close outcomes remain
  microBurstPnlUnverified=true. Opposite-side recent fills are NOT used as attributable
  accounting. Existing accounting quarantine is never cleared by close success.
- CLOSE_PENDING -> CLOSED settles this mutation only after operational-close
  persistence; metadata records exact fill/flat observation and UNVERIFIED accounting.
  CLOSED is historical evidence, not a guarantee of future position flatness.
- Restart validates all histories, including terminal request identity and terminal
  evidence. A crash between operational persistence and terminal journal persistence
  reobserves the exchange using the original request and the matching IDLE accounting
  marker before completing. No send is replayed.
- Missing-position reconciliation checks the close gate before and after awaits.
  Flat/list absence, an altered local parent or a missing managed projection cannot
  discard an unresolved close. A lost projection remains operator-blocked, not rebuilt
  by guessing fill ownership.

## Deliberate Limits

The durable route records the generic operational reason
MICRO_IDENTIFIED_CLOSE_ACCOUNTING_PENDING. It does not call the legacy aggregate-fill
PnL/notifyExit branch. Per-trigger exit reporting and an attributable close ledger
remain follow-up work; intelligent exit selection itself still drives the close.
This slice does not claim verified PnL, commissions, loss-streak updates, or automatic
release of the accounting gate. No arbitrary timeout frees a pending close.

Unseen PREPARED, permanently unavailable exchange history, partial/residual
quarantines, changed/missing identity and account-scope changes require explicit
operator recovery. There is no automatic reset/retry API. The filesystem locking
policy is unchanged: no orphan-lock takeover, multihost fencing or account-wide
inventory reconciliation. Exchange observations and local persistence are not an
atomic transaction; subsequent external trades remain outside this guarantee.

Stop retirement still requires its own exact canceled-stop/flat protocol. A triggered
stop is not automatically retired by treating this market close as its execution.
Monetary reserve release and an attributable ledger remain separate work.

## Authority And Validation

The architecture mutation scanner now recognizes sendMarketCloseOnce and grants
only that method to DurableCloseCoordinator. It does not grant legacy market close,
market open or direct cancel authority. Source digests for Exchange.ts,
BinanceAdapter.ts and TradingService.ts were updated with justification for this
port/transport/routing change, preserving the prior candle/startup changes. These
are reviewed source checkpoints, not scientific approval hashes or LIVE permission.

Coverage includes real journal lost ACK/restart, never-sent PREPARED, fsync failure
and reopen, synchronous concurrency, stale decision identity, identity changes during
PREPARED, new parent on a pending symbol, partial/residual quarantine, fresh-read
timeout, durable protective cancellation, interruption after operational persistence,
scope conflicts, pending-transport drain and combined shutdown failures. Adapter tests
exercise BOTH/LONG/SHORT and contradictory lookup fields. Both real TradingService
callbacks recover lost ACK at startup with entry OFF. Composition tests cover lazy
writer exclusivity, environment isolation and missing-capability failure.

Previous post-review validation: `AEGIS_ENABLED=true npm run test:safety` PASS.
Build PASS; 192 main test files / 2,384 tests, plus the separate ConfigLoader file /
46 tests: **2,430 tests, zero failures**, and git diff --check PASS. The override
applied only to the test process; no env files were changed. This includes 21 close
coordinator tests, three close composition tests, three BOTH/hedge adapter cases
with strict-field matrices, and two real TradingService integration cases.

Review tightened symbol fencing after cold replay and after local parent changes,
and revalidated local identity before recovery state writes. An earlier focused
integration run found a test fixture's eagerly opened but unstarted stop journal
still held its lock; the fixture now starts that coordinator before exercising
shutdown. No lock policy or safety assertion was weakened. The earlier full pass
had 2,429 tests; the post-review regression above includes the added fencing case.

Independent-review preflight fix: two regression cases cover initially unset and
already-set quarantine flags, zero journal operations/sends/lookups/cancels on the
failed read, released same/unrelated-symbol gates, unchanged state, and subsequent
own retry followed by lost-ACK reconciliation with exactly one send. They invoke
the real protective supervisor and verify its position read remains reachable
(fixture returns MISSING); this is not a new end-to-end TradingService scheduling
test or proof of live stop placement. The fsync regression additionally verifies
same-instance retry/reconciliation remain blocked after storage becomes available.
Other observation failures after preparation are outside this narrow recovery fix.

Validation after the independent-review preflight fix:
`AEGIS_ENABLED=true npm run test:safety` PASS; build, 192 main files / 2,386 tests
and separate ConfigLoader / 46 tests: **2,432 tests, zero failures**, including
23 close coordinator tests. `git diff --check` PASS; the untracked close coordinator,
its tests and this audit were also checked with `git diff --no-index --check`.
No commit, push, environment-file edit, bot startup or live exchange operation.
