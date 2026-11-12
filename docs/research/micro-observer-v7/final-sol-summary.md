# Micro paired archive replay

- Status: **NO_ELIGIBLE_EPISODES**
- Authority: OFFLINE_DESCRIPTIVE_RESEARCH_ONLY
- Execution kind: MODELLED_BOOK_VWAP_NOT_REAL_FILL
- Session manifest: `a74f0ccd4a6baba15e55b0e4a00a6eb91fe7d2fba8ecb65a229c2e926151dcb0`
- Contract: `6fd9cab7fb47bfabc2706c9e32b574fcacc9a5503b2428d436f2a29300aadb67`
- Selection: SOLUSDT, 1794462733091–1794462974194 local receive ms
- Decisions: 814; symbol decisions: 409; unique episodes: 0
- Frames built: 409; point books: 409 verified ({"PUBLIC_REST_DEPTH_SNAPSHOT":409}), 0 unknown
- Intervals: 0 verified ({}), 408 unknown, 1 not evaluated (408 considered); technical errors: 0

## Terminal outcomes

No eligible episodes were observed.

## Modelled economics

- CURRENT closed denominator: 0; mean net USDT: n/a
- PULLBACK closed denominator: 0; mean net USDT: n/a
- Paired closed episodes: 0; mean paired delta USDT: n/a
- Excluded from paired delta: 0

## Limitations

- Historical CURRENT inputs are re-evaluated by this executor and must agree with the stored decision; this is not a claim that the historical binary was rerun.
- Verified depth continuity proves archived updates and decision endpoints, not complete exchange-feed delivery or every intrainterval exit-policy context.
- Modeled VWAP is not an exchange fill; latency, queue position, impact, margin, liquidation, and actual protection behavior are not reproduced.
- The common research risk budget is not LIVE margin-fraction sizing.
- Incomplete and UNKNOWN episodes have no terminal PnL; they remain in terminal counts and are excluded explicitly from closed-pair metrics.

