# polymarket-nvidia-ceo-forecast-01

Entry for [make.fun polymarket-nvidia-ceo-forecast-01](https://make.fun/bounty/polymarket-nvidia-ceo-forecast-01): forecast every trading market of Polymarket's "Next CEO of NVIDIA?" event, one minute at a time, 4 hours ahead, as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95). $250 total prizes, 100 paid places; a prize needs a mean pinball loss strictly below the best house entry.

## Approach

`main.ts` (Node 22, stdlib only) reads one case file, and for each market writes 240 rows of five quantiles to `<id>.out`. The median is the last price (persistence). The spread is calibrated per market and per horizon from that case's own last 12 hours, as a blend of two views of the recent h-minute changes:

1. **Normal view (80%):** sigma(h) from the interquartile range of past h-minute changes — robust to the rare jumps that inflate a plain standard deviation — scaled by 0.6, with the standard normal's quantiles.
2. **Empirical view (20%):** the actual quantiles of those past changes, recentered so their median is 0 (past level shifts do not repeat, so the historical median change is a biased drift and is dropped). This keeps the asymmetry of the real distribution: candidates mostly fade, with occasional upward jumps.

Spreads are interpolated in sqrt(h) from a coarse horizon grid (1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 180, 240) and forced non-decreasing in h. With fewer than 30 observed changes for a horizon, the house baseline's spread (0.0025·sqrt(h)) is used instead. Everything is deterministic: same input bytes give same output bytes.

Things tried in backtests that did **not** make it in: pulling the median toward a short-run mean or a recent trend (spikes here are level shifts, not reversals — median error got worse), a plain standard-deviation sigma (jump-inflated, far too wide), unscaled empirical quantiles (their median extrapolates past fades), and a floor under the spread (the floor cost more than it saved).

## Backtest results

Walk-forward on the six practice cases, each scored against the next case's recorded history (p00–p04; p05's outcomes are not in the kit), mean pinball loss ×100, lower better:

| model | loss | median error | 90% coverage |
|---|---|---|---|
| house baseline (starter) | 0.3985 | 0.1900 | 0.935 |
| **this entry** | **0.3396** | 0.1900 | 0.814 |

Per case: p00 0.484, p01 0.332, p02 0.357, p03 0.316, p04 0.209 (baseline: 0.536, 0.380, 0.408, 0.369, 0.299). On extra in-history checkpoints (the last cases, 4–12 h back) it also beats the baseline, 0.25 vs 0.32.

The bands deliberately undercover the nominal 90%: the realized 4-hour windows are calmer than the 12-hour history that calibrates them, and pinball loss pays for width at every quiet minute. The 20% empirical component is the hedge for jumpier regimes — it keeps some of the real tails' width and asymmetry.

## Validation

- All 6 practice cases run one file at a time (as the grader does): outputs valid — exact market sets, 240 rows × 5 numbers, non-decreasing, in [0, 1], 167–238 KB (limit 1 MiB).
- Runtime 231–389 ms per case (limit 8 s).
- Two runs of p00 and p05 produce byte-identical outputs.

Run locally: `mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts`
