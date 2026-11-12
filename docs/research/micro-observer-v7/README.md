# Micro observer V7 — replay evidence archive

This directory preserves the original V7 replay requests, complete JSON reports,
and final human-readable summaries. It intentionally contains no capture data,
SQLite database, exchange credentials, or raw market-data segments.

## Source capture provenance

- Session manifest SHA-256: `a74f0ccd4a6baba15e55b0e4a00a6eb91fe7d2fba8ecb65a229c2e926151dcb0`
- Producer commit: `b64de6b3588f83132aeaefe6ad01f15d5119d740`
- Producer artifact SHA-256: `7c2d70030fadcfe3bf5e081ba368eb6247e4c2385841391acda73a0571524b84`
- Capture config SHA-256: `3951e1bf44910ee2dbd4b84e30f2e08d5d270c5e89b4c4154134124516282ef2`
- Capture range (local receive): `1794462733091–1794462974194`
- Experiment contract SHA-256: `6fd9cab7fb47bfabc2706c9e32b574fcacc9a5503b2428d436f2a29300aadb67`

## Requests and report integrity

The request files preserve the effective V7 requests; their `requestSha256` values
are the replay contract identity used for before/after comparisons. `outputDir` is
execution-specific and does not change that effective identity.

| File | SHA-256 | Effective request SHA-256 |
| --- | --- | --- |
| `sol-request.json` | `998b55e28dc844527d5a72a3c0708e66c2e4ee7c5d737cd0eb061747f9b25251` | `1b3784fe50963f2972ae125d98f3c4331b2864a7a86989ed5c99967e7d19b81d` |
| `avax-request.json` | `7070c756bfef292ec9d16ba0c96120ec192ee45758c1fe51ddc46fa151f17bd1` | `44e280f5211b78b39a37a169c499984550b40f51bc9029074c8a9b6d00e1b33e` |
| `before-sol-report.json` | `22b3d4c9f219e8c4046e51101b0e6b8959f3571c9a7a1800fccc14a689fc476f` | Baseline at `25ba052`; clean source tree |
| `before-avax-report.json` | `f094cfafa445ace25d681094dff3516e12ab5a260fd6b1d7b3bfce74357eff98` | Baseline at `25ba052`; clean source tree |
| `final-sol-report.json` | `968a714818634b4cbed88681cd68a436e3001d485a8ab72a01259adc8b58c2a3` | Replay before commit `251656a`, with matching source changes in the worktree |
| `final-avax-report.json` | `ca5678d69cef25c2505ee7d363dc1bfcef1a811a11286543d1c7a96ec29962c8` | Replay before commit `251656a`, with matching source changes in the worktree |
| `final-sol-summary.md` | `59c2c992d7fc72b8ad0016e1be50e121fc9d05fb19a5a1ac24a9e8e34cf07979` | Derived from `final-sol-report.json` |
| `final-avax-summary.md` | `7063a4509595fc31a89ed7c273ae603d116c2a8a5bf0a7573d07a0265a4b77` | Derived from `final-avax-report.json` |

The final reports record executor checkout `c4329feeace37b5833126391d70e6720bb045f83`,
`sourceWorktreeDirty: true`, and source tree SHA-256
`eda0481ef04444b8968af4276150ec69778b89756700330257fa1891e6c0fb00`. The uncommitted
source represented by that hash was committed as `251656aa5720f69c46cfd2c5b9e5714874c0770e`.

## Result and limits

Both before reports recorded two technical errors per symbol. In the final reports,
technical errors are zero. All 409 SOL and 405 AVAX point books are verified from
the captured public REST snapshot. SOL has 0/408 interval verifications; AVAX has
10/404. The remainder stay UNKNOWN, primarily because event order relative to the
exchange-clock uncertainty band cannot be proven, no causal depth update is archived
for the interval, or the exchange-clock upper bound regresses. Both final reports
have `NO_ELIGIBLE_EPISODES`, zero modelled executions, and no economic conclusion.

The distinct `unknownFrames` baseline field and final interval counters describe
different units and must not be treated as a directly comparable before/after metric.
V7 itself remains frozen and unmodified.
