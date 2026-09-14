# Local BTC scheduling and input observability implementation

This implementation follows the frozen findings in [offline input forensics](micro-burst-offline-input-forensics.md). That report describes the pre-fix source and its historical reproduction; its source-identity statements are historical, not assertions about this worktree after this change. Research inputs, pattern experiments and prior strategy edits were preserved.

## Scheduling

`MarketDataCandleProvider` now pairs its pre-candle exchange sample with the local receipt of that sample, separately from candle completion. `BtcMicroContextProvider` advances this reference by elapsed local time, including actual candle-read latency, before calculating the next boundary +250 ms. A 6-second read starting at minute +30 seconds now schedules the next request at +60.250 seconds, instead of +66.250 seconds. A read crossing the boundary triggers a bounded delayed-publication retry.

There are at most three short retries (1, 2, 4 seconds) per exchange-estimated interval, then the next regular boundary. Reads are single-flight. Stop invalidates in-flight results; restart waits for an old read to settle before starting its own read. An unresolved upstream promise cannot be cancelled by this port: restart waits rather than overlapping requests. No freshness limits or economic parameters changed.

Server-request elapsed time is recorded as sample uncertainty, not proof of clock accuracy. Server-time caching, asymmetric latency and local wall-clock changes remain uncertainties. Legacy candle ports lacking the optional sample pairing retain the completion-time fallback; the corrected path requires `MarketDataCandleProvider` metadata.

The Binance candle adapter applies a 15-second consumer timeout and shares one in-flight request per
symbol and interval. A timed-out caller does not start a replacement while the underlying SDK
request remains unresolved, so the adapter fails boundedly without creating overlapping transport
requests. The SDK path does not expose cancellation; a permanently unresolved transport request
can therefore retain its in-flight slot until process restart.

## Freshness reporting

The builder's additive `dataQuality.btcFreshness` exposes RECEIVE age/status on LOCAL_WALL and EVENT age/status on EXCHANGE_SNAPSHOT. Legacy `btcAgeMs` and `btcStatus` retain their receive semantics. `microEligibleAtSnapshot` means BTC-only eligibility at the builder snapshot, not entry approval: the reaction policy still checks the evaluation exchange upper bound. Event uncertainty is explicitly unknown (`null`). The evaluator carries this object into existing telemetry; exact replay retains the context object.

Runtime health and periodic health reporting include provider freshness separately from the existing `btcHealthy`. The runtime estimate advances the pre-read exchange sample with local elapsed time. It reports definite freshness ineligibility or `REQUIRES_EVALUATION_CLOCK`, never entry eligibility. The runtime diagnostic uses the default Micro freshness limit; symbol-specific evaluation remains authoritative. Existing readiness semantics are retained.

## Candle provenance

`CandleProvenance` attaches constant-size immutable metadata to the exact adapter-returned array using weak keys. It records local adapter call start/completion, normalized-candle cache HIT/MISS, and the original adapter read start/completion retained across cache hits. No OHLCV copies, transport payloads, unbounded history or new logs are introduced.

**MISS means normalized adapter cache miss, not a demonstrated network fetch.** `transportCache: UNKNOWN` explicitly covers SDK/raw transport response reuse; original adapter completion is not claimed as original network packet receipt. Sources that do not attach metadata report UNKNOWN cache origin. Array-copying wrappers must explicitly propagate metadata or attribution is lost and reported unknown.

The neutral series includes provenance and the builder captures it before detaching arrays into `inputSources.timing.candleReads`. BTC context also carries its series provenance into exact inputs. Each classification names `closeTime <= exchangeSnapshotTimeMs` and the actual exchange classification timestamp. `exchangeFinalization: UNKNOWN` is intentional. `CandleIntegrity` remains the same validator/filter: equality is application-closed, values are not repaired or reconciled across reads. A cached forming value can become application-closed without another network observation.

Provenance is currently available for successful series observations; unavailable/anomalous early returns may omit it. Adapter enqueue/dequeue, actual transport receipt and exchange publication/finalization are not measured. These additions cannot retroactively attribute historical XRP/SUI revisions or SOL/BNB refresh delays.

## Verification

Targeted suites cover variable 400/6,000/35,000 ms reads through the real neutral provider, minute crossing, failure retry bounds, overlap, stop/restart, closure equality and cached forming-to-closed provenance through Binance normalization → neutral provider → CandleIntegrity. Builder tests explicitly distinguish healthy RECEIVE from stale EVENT; runtime tests preserve legacy health separately from Micro ineligibility.

No environment settings are added. This change is prepared for deployment authorization; no
deployment or process restart has occurred.

Completed checks: **207 tests passed in 9 suites** (BTC provider 65, Binance candles 3, neutral candles 37, integrity 29, builder 12, evaluator 8, runtime 29, temporal contracts 23, exact replay CLI 1). After adding BTC provenance to exact context, the affected provider/temporal/replay suites passed again (**89 tests in 3 suites**). `npx tsc --noEmit`, targeted Prettier formatting and `git diff --check` passed.
