// polymarket-nvidia-ceo-forecast-01 entry (Node 22, standard library only).
//
// Approach (v3): persistence median with NO fade and NO reversion of the last
// 15 minutes' move — the recent move is noise/momentum, not signal — but a
// strong mean-reversion (-0.55) of the 15-to-60-minute slice, pulled toward
// the board-normalised level (the 24 Yes prices sum to ~1.06, so each
// market's fair level is its price divided by the board sum) with a
// 180-minute time constant. The spread is per-market and per-horizon, from
// two volatility views combined in quadrature:
//
//   1. a robust view: sigma(h) from the interquartile range of past h-minute
//      changes over the last 24 h, scaled by 0.30. Young markets fall back
//      to their own 1-minute IQR volatility scaled by sqrt(h) instead of the
//      house baseline's tiny 0.0025, which was far too narrow for markets
//      moving 0.04-0.08/min.
//   2. a fast-scale guard: the winsorised (capped at 0.05) exponentially
//      weighted 1-minute volatility with a 30-minute half-life, scaled by
//      1.0 and sqrt(h). It only bites when recent trading is hot, so bands
//      widen in volatile regimes instead of staying stuck at the calm
//      24-hour IQR level.
//
// The band is asymmetric (outer low quantile x1.4, outer high x1.3, inner
// high x0.9): down moves are fatter-tailed than up moves here, and the upper
// tail needs more room. Spreads are interpolated in sqrt(h) from a coarse
// horizon grid and forced non-decreasing in h. No empirical-quantile blend:
// once the guard is in, the empirical part only adds noise.
//
// What was tried and rejected on the walk-forward backtest: reverting the
// last 5 or 15 minutes (hurts — that move is not mean-reverting), any direct
// jump correction (up-jumps reverse ~fully, but almost all of the reversal
// happens within minutes, before the checkpoint, so correcting for it
// double-counts), board-sum-change and leader-rotation terms (no signal
// once the level pull is in), a fade for young markets (helps only the
// early practice cases, whose markets are young; the final's markets are
// all 27+ hours old, so it cannot fire there), and blends with the house
// baseline or the v2 model.
//
// Backtest (walk-forward on the practice cases, scored against the next
// case's history; mean pinball loss x100, lower better): this program 0.285
// pooled over p00-p04 (house baseline 0.393, v2 0.296, original entry
// 0.333); 0.280 pooled over p01-p04 plus four extra mature in-history
// checkpoints (v2 0.295); median error 0.812 (v2 0.868). Per case: p00
// 0.443, p01 0.288, p02 0.306, p03 0.251, p04 0.174. The gain over v2 is
// broad: it beats v2 on every leave-one-case-out recomputation of the
// pooled score.
//
// It runs offline, with no network: everything it knows is in the case file.
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** Horizons (minutes) at which the change distribution is measured. */
const HGRID = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 180, 240];
/** How much recent history calibrates the spread (minutes). */
const WINDOW_MIN = 1440;
/** Shrinkage of the IQR-implied sigma (the past is jumpier than the next 4 h). */
const SIGMA_SCALE = 0.3;
/** Minimum change samples for a horizon's estimates; below it, fall back to own 1-min vol. */
const MIN_SAMPLES = 30;
/** Median fade per hour: 0 — tested, the drift is already in the level pull. */
const FADE_PER_HOUR = 0;
/** Mean-reversion of the 15-to-60-minute slice of the last hour's move. */
const REV_SHORT = 15;
const REV_WINDOW = 60;
const REV_BETA = -0.55;
const REV_H = 240;
/** Pull of the median toward the board-normalised level (tau in minutes). */
const PULL_TAU = 180;
/** Fast-scale guard: EWMA half-life (min), winsor cap, and its weight. */
const GUARD_HALFLIFE = 30;
const GUARD_CAP = 0.05;
const GUARD_K = 1.0;
/** Per-quantile band multipliers (q05, q25, q50, q75, q95). */
const SHAPE = [1.4, 1.0, 1.0, 0.9, 1.3];

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** Linear-interpolation quantile of a sorted array, as numpy's default. */
function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0] as number;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo] as number;
  const w = pos - lo;
  return (sorted[lo] as number) * (1 - w) + (sorted[hi] as number) * w;
}

/** Interpolate y at xq from the grid (xs, ys), flat outside. */
function interp(xs: number[], ys: number[], xq: number[]): number[] {
  return xq.map((x) => {
    if (x <= xs[0] as number) return ys[0] as number;
    const last = xs.length - 1;
    if (x >= (xs[last] as number)) return ys[last] as number;
    let j = 0;
    while (x > (xs[j + 1] as number)) j++;
    const x0 = xs[j] as number;
    const x1 = xs[j + 1] as number;
    const y0 = ys[j] as number;
    const y1 = ys[j + 1] as number;
    return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  });
}

/** In-place cumulative maximum, so a spread never narrows with horizon. */
function cumMax(a: number[]): void {
  for (let i = 1; i < a.length; i++) {
    if ((a[i] as number) < (a[i - 1] as number)) a[i] = a[i - 1] as number;
  }
}

/**
 * The forecast of one market: horizon rows of five quantiles around its last
 * price. The spread is the IQR sigma interpolated in sqrt(h), combined in
 * quadrature with the fast-scale guard, and forced non-decreasing in h.
 */
function forecast(m: CaseMarket, horizon: number, quantiles: number[], zs: number[], target: number | null): number[][] {
  const p = m.prices;
  const n = p.length;
  if (n === 0) return Array.from({ length: horizon }, () => quantiles.map(() => 0.5));
  const x = p[n - 1] as number;

  // 1-minute changes over the full history, for the own-vol fallback and guard.
  const d1: number[] = [];
  for (let i = 0; i + 1 < n; i++) d1.push((p[i + 1] as number) - (p[i] as number));
  let own1 = 0;
  if (d1.length >= 5) {
    const srt = [...d1].sort((a, b) => a - b);
    own1 = Math.max(0, (quantileSorted(srt, 0.75) - quantileSorted(srt, 0.25)) / 1.349);
  }

  // Per-grid-horizon IQR sigma of the h-minute changes in the last WINDOW_MIN.
  const sigGrid: number[] = [];
  for (const h of HGRID) {
    const lo = Math.max(0, n - WINDOW_MIN - h);
    const hi = n - h;
    const count = hi - lo;
    if (count < MIN_SAMPLES) {
      sigGrid.push(own1 * Math.sqrt(h));
      continue;
    }
    const changes: number[] = [];
    for (let s = lo; s < hi; s++) changes.push((p[s + h] as number) - (p[s] as number));
    changes.sort((a, b) => a - b);
    const q75 = quantileSorted(changes, 0.75);
    const q25 = quantileSorted(changes, 0.25);
    sigGrid.push(Math.max(0, (q75 - q25) / 1.349));
  }

  // Interpolate to every minute in sqrt(h) space.
  const hs = Array.from({ length: horizon }, (_, i) => i + 1);
  const xs = HGRID.map((h) => Math.sqrt(h));
  const xq = hs.map((h) => Math.sqrt(h));
  const sig = interp(xs, sigGrid, xq);
  cumMax(sig);

  // Fast-scale guard: winsorised EWMA of recent 1-minute moves (30-min
  // half-life), combined in quadrature with the IQR sigma.
  const alpha = 1 - Math.pow(0.5, 1 / GUARD_HALFLIFE);
  const decay = 1 - alpha;
  let wSum = 0;
  let wSq = 0;
  let w = 1;
  for (let i = d1.length - 1; i >= 0; i--) {
    const d = Math.max(-GUARD_CAP, Math.min(GUARD_CAP, d1[i] as number));
    wSum += w;
    wSq += w * d * d;
    w *= decay;
  }
  const g1 = wSum > 0 ? Math.sqrt(wSq / wSum) : 0;
  for (let i = 0; i < horizon; i++) {
    const h = hs[i] as number;
    const gsig = GUARD_K * g1 * Math.sqrt(h);
    const s0 = sig[i] as number;
    sig[i] = Math.sqrt(s0 * s0 + gsig * gsig);
  }
  cumMax(sig);

  // Median: last price, no fade. Only the 15-to-60-minute slice of the last
  // hour's move reverts: the last 15 minutes' move is not mean-reverting
  // (tested: reverting it hurts), and neither is the 60-240-minute slice.
  // The median is also pulled toward the board-normalised level (target),
  // ramping in over PULL_TAU.
  const r60 = x - (n > REV_WINDOW ? (p[n - 1 - REV_WINDOW] as number) : (p[0] as number));
  const r15 = x - (n > REV_SHORT ? (p[n - 1 - REV_SHORT] as number) : (p[0] as number));
  const rev = REV_BETA * (r60 - r15);
  const rows: number[][] = [];
  for (let i = 0; i < horizon; i++) {
    const h = hs[i] as number;
    let med = x * Math.exp(-FADE_PER_HOUR * (h / 60));
    med += rev * Math.min(1, h / REV_H);
    if (target !== null) med += (target - x) * (1 - Math.exp(-h / PULL_TAU));
    const s = SIGMA_SCALE * (sig[i] as number);
    const row = quantiles.map((_, k) => {
      const dev = (zs[k] as number) * s * (SHAPE[k] as number);
      return price6(med + dev);
    });
    // Defensive: keep each row non-decreasing in tau.
    row.sort((a, b) => a - b);
    rows.push(row);
  }
  return rows;
}

/** Acklam's rational approximation of the standard normal's quantile. */
function normQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285984469534e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    const num = (((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q + (c[5] as number);
    const den = ((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q + 1;
    return num / den;
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    const num = (((((a[0] as number) * r + (a[1] as number)) * r + (a[2] as number)) * r + (a[3] as number)) * r + (a[4] as number)) * r + (a[5] as number);
    const den = ((((b[0] as number) * r + (b[1] as number)) * r + (b[2] as number)) * r + (b[3] as number)) * r + (b[4] as number);
    return (num * q) / (den * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  const num = (((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q + (c[5] as number);
  const den = ((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q + 1;
  return -(num / den);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const standard = c.quantiles.length === QUANTILES.length && c.quantiles.every((t, j) => t === QUANTILES[j]);
  const quantiles = standard ? QUANTILES : c.quantiles;
  const zs = standard ? Z : quantiles.map((t) => normQuantile(t));
  // The 24 Yes prices sum to ~1.06, so each market's fair level is its
  // price divided by the board sum. The pull is part of the median inside
  // forecast(), not a post-pass.
  const boardSum = c.markets.reduce(
    (acc, m) => acc + (m.prices.length ? (m.prices[m.prices.length - 1] as number) : 0),
    0,
  );
  const forecasts = c.markets.map((m) => {
    const target = boardSum > 0 && m.prices.length ? (m.prices[m.prices.length - 1] as number) / boardSum : null;
    return { id: m.id, q: forecast(m, c.horizon_minutes, quantiles, zs, target) };
  });

  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
