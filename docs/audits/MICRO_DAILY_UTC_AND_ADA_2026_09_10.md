# Micro Daily UTC Pause And ADA Accounting

## Requested Policy

Three confirmed consecutive net losses within one UTC day pause new Micro entries
until 00:00 UTC. The process and position management must continue. A positive net
result resets the streak before the pause; an exact zero remains neutral, matching
existing behavior. Once paused, a later win cannot release the same-day pause.

The ledger now derives the economic close date from the final closing fill, not
the callback or local flat-observation date. Late previous-day confirmation cannot
increment today's streak or release today's pause. Calendar transitions persist a
revisioned audit record without changing epochs, signed operator commands, account
scope, keys, trade identities or evidence. Migration rebuilds the daily projection
from existing verified evidence. Unverified/conflicting settlements remain global
admission blockers across midnight. Initialization still requires an externally
signed command. Invalid/backward observed local clock readings fail closed.

Production uses Binance server time advanced with monotonic elapsed time, not
the local wall clock. Authority is refreshed every 30 seconds when queried and
expires after 60 seconds. Missing authority blocks admission and retries reads;
invalid timestamps, slow samples over two seconds, monotonic rollback and exchange
clock jumps over five seconds fail closed. No clock is trusted before the first
successful read. These checks do not stop position management.

## Verified ADA Economics

Read-only historical requests on 2026-09-10 established the following for
`MICRO-BURST-V1-ADAUSDT-20260907-110659-277`:

| Field               | Exchange Evidence                                          |
| ------------------- | ---------------------------------------------------------- |
| Side / quantity     | SHORT / 3295 ADA                                           |
| Entry order / fill  | 67663831129 / 1917969115                                   |
| Entry timestamp UTC | 2026-09-07 11:07:34.197                                    |
| Entry price         | 0.2189                                                     |
| Close order / fill  | 67665430845 / 1918003222                                   |
| Close timestamp UTC | 2026-09-07 12:51:01.051                                    |
| Close price         | 0.2233                                                     |
| Gross realized PnL  | -14.498 USDT                                               |
| Entry commission    | 0.36063775 USDT                                            |
| Close commission    | 0.36788675 USDT                                            |
| Funding             | 0 USDT; exhaustive empty response for the holding interval |
| Net realized PnL    | -15.2265245 USDT                                           |

Both exact orders were FILLED, with matching side, BOTH position mode and original/
executed quantities. The bounded historical trade response contained only the two
matched fills. Both fresh position-side reads established flat ADA exposure.
Evidence observation server time was 1789022195320 ms.

No current-policy version, episode or source commit was retroactively assigned to
the legacy trade. The new `readHistoricalMicroSettlement` path shares the existing
bounded, budgeted GET-only settlement reader. It does not write an accounting
ledger, projection, entry journal or stop journal and does not place/cancel orders.

The audit can be repeated without application bootstrap:

```bash
node -r ts-node/register -r dotenv/config scripts/micro-burst-audit-historical-close.ts MICRO-BURST-V1-ADAUSDT-20260907-110659-277 ADAUSDT SHORT 3295 67663831129 67665430845 2026-09-07T11:07:34.197Z 2026-09-07T12:51:01.051Z
```

## Operational Boundary

Verified economics are not yet a completed durable legacy reconciliation. The old
entry remains OPEN_CONFIRMED with an occupied recovery projection, and the old
structural-stop request has ambiguous evidence. The closing fill alone does not
identify the parent algo or prove that every old conditional order is terminal.
Fresh exact GET lookup for `bot_sl_85aea7fd3b94b9d54d0df2cd4728` returned HTTP
400 / Binance `-2013` (order not found). This is not terminal cancellation evidence
and must not be converted into permission to clear the unknown stop or resend it.
No quarantine flags, active locks or journal records were manually cleared.

At source validation this change was not yet deployed. The existing PM2 trading process was online
as PID 141813; the Aegis API remained stopped. Historical accounting must still be
integrated with the runtime-owned reconciliation protocol before claiming that ADA
is eligible. Deployment and monitoring must complete before the UTC pause is live.

## Validation

TypeScript compiled outside the live `dist` directory. The expanded Micro,
execution, position, bootstrap and Binance settlement/protection selection passed
1063 tests across 61 files. The tests cover daily rollover in-process and after
restart, calendarless ledger migration, late settlements, final-fill attribution,
pending/conflicting evidence, zero-PnL neutrality, signed initialization, expired
clock authority and clock jumps. No production Aegis process was activated.

At 06:52:27 UTC the restricted read-only client reported zero positions, zero
regular open orders and zero algo open orders. The production ledger was inspected
read-only: initialized, revision 1, epoch 1, zero trades, zero streak and no halt.
Deployment authorization retains the existing 90% margin sizing, 20x/30x leverage,
canonical Micro configuration hash and all unresolved recovery gates. It does not
authorize treating `-2013` as a cancellation receipt or promoting ADA eligibility.
