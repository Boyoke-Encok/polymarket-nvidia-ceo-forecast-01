# polymarket-nvidia-ceo-forecast-01

Entry for [make.fun polymarket-nvidia-ceo-forecast-01](https://make.fun/bounty/polymarket-nvidia-ceo-forecast-01): forecast every trading market of Polymarket's "Next CEO of NVIDIA?" event, one minute at a time, 4 hours ahead, as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95). $250 total prizes, 100 paid places; a prize needs a mean pinball loss strictly below the best house entry.

## Approach (v3)

`main.ts` (Node 22, stdlib only) reads one case file, and for each market writes 240 rows of five quantiles to `<id>.out`. The median is the last price (persistence) with two corrections, and the spread is a per-market, per-horizon combination of two volatility views:

**Median**
1. **No fade.** Tested: the slight downward drift is already handled by the board pull; a fade only hurts.
2. **Mean-reversion of one slice only:** the 15-to-60-minute slice of the last hour's move is pulled back by 55%, ramped in over 240 min. The last 15 minutes' move is *not* reverted — backtests show reverting it hurts (that move is noise/momentum, not signal) — and neither is the 60–240-minute slice.
3. **Board pull:** the median is pulled toward the board-normalised level — each market's price divided by the sum of all 24 last prices (the Yes prices sum to ~1.06, so the fair level is price / sum) — with a 180-minute time constant. The pull is part of the median (added as `(target − x) · (1 − exp(−h/180))`), not a post-pass on the rounded median.

**Spread** (interpolated in sqrt(h) from a grid 1–240 min, forced non-decreasing in h)
1. **Robust view:** sigma(h) from the interquartile range of past h-minute changes over the last 24 h, scaled by 0.30 (the past is jumpier than the next 4 h). Markets with fewer than 30 observed changes for a horizon fall back to their own 1-minute IQR volatility scaled by sqrt(h) — the house baseline's 0.0025 was far too narrow for markets moving 0.04–0.08/min.
2. **Fast-scale guard:** the winsorised (capped at 0.05) exponentially weighted 1-minute volatility with a 30-minute half-life, scaled by 1.0 and sqrt(h), combined with the IQR sigma **in quadrature**. It only bites when recent trading is hot, so bands widen in volatile regimes instead of staying stuck at the calm 24-hour IQR level.
3. **Asymmetric shape:** the band is widened on the outside (q05 ×1.4, q95 ×1.3) and narrowed on the inner high side (q75 ×0.9) — down moves are fatter-tailed than up moves here.

No empirical-quantile blend: once the guard is in, the empirical part only adds noise. Everything is deterministic: same input bytes give same output bytes.

## Backtest results

Walk-forward on the six practice cases, each scored against the next case's recorded history (p00–p04; p05's outcomes are not in the kit), mean pinball loss ×100, lower better. The program was also scored on four extra mature in-history checkpoints (08:00/12:00/16:00/20:00 UTC, 12 Nov) to avoid overfitting the five practice cases; the combined selection metric (p01–p04 + extras) is the COMB column. A mature-only subset (p03, p04 + extras, the closest analogue to the final, whose markets are all 27+ hours old) is the MAT column.

| model | loss (p00–p04) | COMB | MAT | median error |
|---|---|---|---|---|
| house baseline (starter) | 0.3925 | 0.3922 | — | 0.901 |
| v1 entry (submitted, dev 0.292) | 0.3325 | 0.3175 | — | 0.901 |
| v2 (submitted) | 0.2964 | 0.2952 | 0.2881 | 0.868 |
| **v3 (this program)** | **0.2851** | **0.2801** | **0.2752** | **0.812** |

Per case (v3): p00 0.443, p01 0.288, p02 0.306, p03 0.251, p04 0.174 (v2: 0.446, 0.288, 0.350, 0.249, 0.187). Extra checkpoints (v3): X08 0.238, X12 0.549 (Colette Kress jump), X16 0.272, X20 0.214 (v2: 0.264, 0.580, 0.270, 0.220). The gain over v2 is broad: it beats v2 on every leave-one-case-out recomputation of the pooled score (by 0.013–0.017 each time), and on 7 of the 9 individual cases.

Honest expectation for the live grade: the v1 entry's live dev loss (0.292) tracked its backtest (0.333) only loosely, and the loss is dominated by unpredictable news level-shifts — the oracle median alone would score 0.116, while the best tested median gets 0.81. If the backtest gain transfers, v3 lands near ~0.28 live (rank roughly #1000–1400, vs v2's expected ~0.29), still far from #1 (0.213). The median error improved 0.868 → 0.812; the top-10 live entries sit at 0.60–0.68, and no tested signal closes that gap.

Things tried in backtests that did **not** make it in: reverting the last 5 or 15 minutes' move (hurts); any direct jump/spike give-back correction (up-jumps reverse almost fully, but nearly all of the reversal happens within minutes, before the checkpoint, so correcting for it double-counts); board-sum-change and leader-rotation terms (no signal once the level pull is in); a fade for young markets (helps only the early practice cases, whose markets are young — the final's markets are all 27+ hours old, so it cannot fire there); per-market age splits on the reversion (hurts); log-price changes and a pure empirical-quantile kernel (both worse); EWMA / realised-volatility as the *primary* sigma (jump-inflated even winsorised, far worse than IQR); a plain standard-deviation sigma; smoothing the median toward a short-run mean (worse — the last price is the best level estimate); board-sum normalisation without a cap (the +24% factor on the 19-market case blows up); blending with the house baseline or the v2 model (both worse).

## Validation

- All 6 practice cases run one file at a time (as the grader does), plus the 4 extra checkpoints: outputs valid — exact market sets, 240 rows × 5 numbers, non-decreasing, in [0, 1], 202–267 KB (limit 1 MiB).
- The TypeScript output reproduces the Python reference model bit-exactly: pooled practice loss 0.2851 and combined loss 0.2801, identical to the Python sweep; max absolute difference vs the Python model on p00 is 0.000000.
- Runtime 0.10–0.11 s per case (limit 8 s).
- Two runs of all 10 cases produce byte-identical outputs.

Run locally: `mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts`
