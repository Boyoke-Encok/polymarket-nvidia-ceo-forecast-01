# polymarket-nvidia-ceo-forecast-01

Entry for [make.fun polymarket-nvidia-ceo-forecast-01](https://make.fun/bounty/polymarket-nvidia-ceo-forecast-01): forecast every trading market of Polymarket's "Next CEO of NVIDIA?" event, one minute at a time, 4 hours ahead, as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95). $250 total prizes, 100 paid places; a prize needs a mean pinball loss strictly below the best house entry.

## Approach (v2)

`main.ts` (Node 22, stdlib only) reads one case file, and for each market writes 240 rows of five quantiles to `<id>.out`. The median is the last price (persistence) with three small corrections, and the spread is a per-market, per-horizon combination of two volatility views:

**Median**
1. **Fade:** the median is multiplied by `exp(-0.01 · h/60)` — prices drift down slightly on average over 4 h.
2. **Mean-reversion:** the last hour's move is pulled back by 30%, ramped in over 240 min (up-jumps in these markets mostly reverse; down moves mostly continue, so a symmetric pull on the 60-min change is the robust form).
3. **Board pull:** the median drifts toward the board-normalised level — each market's price divided by the sum of all 24 last prices (the Yes prices sum to ~1.06, so the fair level is price / sum) — as an Ornstein-Uhlenbeck process with a 480-minute time constant. Bands shift with the median, unchanged in width.

**Spread** (interpolated in sqrt(h) from a grid 1–240 min, forced non-decreasing in h)
1. **Robust view:** sigma(h) from the interquartile range of past h-minute changes over the last 24 h, scaled by 0.35 (the past is jumpier than the next 4 h). Markets with fewer than 30 observed changes for a horizon fall back to their own 1-minute IQR volatility scaled by sqrt(h) — the house baseline's 0.0025 was far too narrow for markets moving 0.04–0.08/min.
2. **Fast-scale guard:** the winsorised (capped at 0.05) exponentially weighted 1-minute volatility with a 30-minute half-life, scaled by 0.8 and sqrt(h), combined with the IQR sigma **in quadrature**. It only bites when recent trading is hot, so bands widen in volatile regimes instead of staying stuck at the calm 24-hour IQR level.
3. **Asymmetric shape:** the band is widened on the outside (q05 ×1.4, q95 ×1.3) and narrowed on the inner high side (q75 ×0.9) — down moves are fatter-tailed than up moves here.

No empirical-quantile blend: once the guard is in, the empirical part only adds noise. Everything is deterministic: same input bytes give same output bytes.

## Backtest results

Walk-forward on the six practice cases, each scored against the next case's recorded history (p00–p04; p05's outcomes are not in the kit), mean pinball loss ×100, lower better. The v2 program was also scored on four extra mature in-history checkpoints (08:00/12:00/16:00/20:00 UTC, 12 Nov) to avoid overfitting the five practice cases; the combined selection metric (p01–p04 + extras) is 0.2830.

| model | loss (p00–p04) | median error | 90% coverage |
|---|---|---|---|
| house baseline (starter) | 0.3925 | 0.901 | 0.950 |
| v1 entry (submitted, dev 0.292) | 0.3325 | 0.901 | 0.814 |
| **v2 (this program)** | **0.2964** | **0.890** | **0.845** |

Per case (v2): p00 0.446, p01 0.288, p02 0.350, p03 0.249, p04 0.187 (v1: 0.484, 0.332, 0.357, 0.316, 0.209). Every practice case improves. Extra checkpoints (v2): X08 0.264, X12 0.580 (Colette Kress jump), X16 0.244, X20 0.142 — pooled 0.305.

Things tried in backtests that did **not** make it in: log-price changes and a pure empirical-quantile kernel (both worse); EWMA / realised-volatility as the *primary* sigma (jump-inflated even winsorised, far worse than IQR); a plain standard-deviation sigma; spike/jump give-back corrections (double-count oscillations); smoothing the median toward a short-run mean (worse — the last price is the best level estimate); board-sum normalisation without a cap (the +24% factor on the 19-market case blows up); blending with the house baseline (its bands are wrong in the wrong places). The loss is dominated by unpredictable news level-shifts, so the realistic gain is in the bands, not the median — the oracle median would be 0.116, but no tested median signal gets close to it.

## Validation

- All 6 practice cases run one file at a time (as the grader does): outputs valid — exact market sets, 240 rows × 5 numbers, non-decreasing, in [0, 1], 202–266 KB (limit 1 MiB).
- The TypeScript output reproduces the Python reference model exactly: pooled practice loss 0.2964 and extra-checkpoint loss 0.3050, identical to the Python sweep.
- Runtime 0.33–0.36 s per case (limit 8 s).
- Two runs of p00 produce byte-identical outputs.

Run locally: `mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts`
