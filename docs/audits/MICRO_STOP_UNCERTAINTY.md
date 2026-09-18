# Bounded Durable Micro Stop Uncertainty

Source base: `429de245146c671fa15f5ba51b7f0358662bada3`. This is a local safety
change, not deployment authorization or a production change.

## Root Cause And Evidence

`PositionProtectionService` had a recovery deadline for the legacy submission
latch, but not for a journaled initial stop whose current protection could not be
confirmed. Its durable branch could return UNKNOWN indefinitely. Admission already
gates pending mutations, and `TradingService.managePositionByOwner` already returns
on UNKNOWN without running strategic exits. Neither behavior was the defect.

The local September 18 log and read-only journal inspection for SHORT trade
`MICRO-BURST-ADAUSDT-20260918-125038-730` show:

- Entry admitted at 12:50:38.730 UTC; entry order `68028077468`, quantity 3064.
- Stop `bot_sl_bca83a2ae5a46f20ccdd350a379b`, price 0.2154, PREPARED at
  12:50:45.410, SUBMITTED at 12:50:46.766, OPEN_CONFIRMED at 12:50:52.204.
- Entry application reported BRACKETS_FAILED at 12:50:47.567, before confirmation.
- Strategic HOLD observations at 22,835, 44,918, and 68,721 ms retained the original
  entry clock. EARLY_FAILURE was observed at 97,847 ms, at 12:52:15.785.
- Durable close PREPARED at 12:52:18.863, CLOSED at 12:52:45.660; net settlement
  verified at 12:53:08.754.

This SHORT is not evidence of indefinite UNKNOWN. No ADA
`micro_stop_supervision_unknown` event was found in that local day log. No older
LONG evidence is used to attribute a failure to this SHORT.

## Contract

- The first unconfirmed, identity-matched journaled initial-stop observation saves
  `microStopUncertainty`: parent trade/order, exact stop client ID, start, fixed
  deadline, and recovery transition flag. The existing default recovery timeout is
  30 seconds. Evaluation and restart reuse the saved deadline, not the entry clock.
- Every evaluation reconciles the same stop request first. Positive current stop
  evidence clears uncertainty even after the deadline; it does not reset economic
  entry timestamps or change strategy policy.
- Expiry is an uncertainty policy, not proof of stop absence. It requires validated
  matching journal identity, durable state, a fresh position with the same side,
  quantity and entry price, unchanged local identity, and the durable close coordinator.
- The existing close coordinator rechecks position identity before preparing and
  sending its single identified market close. In one-way mode it is reduce-only;
  hedge mode is side-bound. Lost ACK recovery remains observation-only. No stop
  resend, legacy-close fallback, or pre-close cancellation is introduced.
- Persistence/identity/position-read failures retain quarantine. A newer trade is
  not overwritten by the protection or management continuation. Start, confirmation,
  and expiry transitions log the trade and stop identity plus evidence.
- Operational close clears uncertainty alongside other protection state, with the
  existing failed-persistence rollback. Uncertainty also independently gates admission.

## Limits And Verification

The timer applies to an identified initial stop. Unjournaled legacy latches, journal
failure, request mismatch, and replacement stops retaining old coverage keep their
existing fail-closed handling. There is no automatic close on an unverified position.
Unavailable prerequisite reads or storage can delay escalation beyond the deadline;
the deadline is not a guaranteed exchange liquidation time.

A never-confirmed stop can remain pending after a verified market close. Empty
listings do not prove that a delayed stop cannot appear. The existing retirement
protocol must establish exact terminal evidence before releasing that admission
block; accounting remains separately quarantined. Exchange reads are not atomic
with outside account activity.

Regression coverage uses real temporary state/journal files and simulated exchange
responses: lost stop ACK with visible protection, never-confirmed stop, fixed deadline
across restart, late confirmation preserving entry time, durable close ACK recovery,
malformed state, failed reads/flush, changed position/parent/stop identity, stale
management continuation, and no duplicate stop or close sends. Existing replacement,
emergency-close, manual-bracket and strategic-exit tests are retained unchanged.
