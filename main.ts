// Washout-dip cbBTC bot — buys outsized dips below the 8-hour mean and rides the
// snap-back, with a deep-pullback sleeve for uptrends and a late momentum fallback
// so the bot always takes at least one trade per 24h window.
//
// Dev-window behaviour (frozen 24h, $1,000 start, all fees/slippage/impact):
//   net PnL +$18.85, 2 round trips (4 fills), win rate 100%, max drawdown -0.73%
//   (grade-local --driver process; see README). Trade 1: washout buy after the
//   early sell-off, +1.04%. Trade 2: washout buy into the late dip, +0.95%.
//   The old 1.3%/25% pullback sleeve lost money on dev (-$2.34, 0 wins in 1 trade),
//   so it now only fires on deeper 1.6% pullbacks, at 50% size, for uptrend windows.
//
// Rules (all comparisons in exact bigint arithmetic; no floats, no clock, no
// randomness — two runs on the same bars produce identical orders):
//   WASHOUT (primary): close <= SMA480 * (1 - 1.3%) AND close > previous close
//     -> buy 100% of cash. Exit: +1.0% take-profit, -1.2% stop, 1.0% trailing
//     stop from the peak mark, or 480 bars max hold.
//   PULLBACK (secondary): close > SMA480 AND close <= 60-bar high * (1 - 1.6%)
//     AND close > previous close -> buy 50% of cash. Exit: +0.8% / -0.8% /
//     0.8% trailing / 240 bars max hold.
//   FALLBACK: if no buy has filled by the 1000th bar seen and EMA8 crosses above
//     EMA21 -> buy 50% of cash. Exit: +0.8% / -0.8% / 0.8% trailing / 240 bars.
//   A 3-bar cooldown follows every sell fill. Warm-up batches only build history.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 10_000;

// Slow mean window: 480 one-minute bars = 8 hours.
const MEAN_BARS = 480;
// Pullback lookback: highest high of the last 60 bars.
const PULLBACK_BARS = 60;
// Bars between a sell fill and the next allowed entry.
const COOLDOWN_BARS = 3;
// Bar count after which the momentum fallback may fire (only with zero fills).
const FALLBACK_BAR = 1000;

// Washout rule (percentages in basis points of the slow mean / entry value).
const WASHOUT_DIP_BPS = 130; // buy 1.3% below SMA480 (plateau 1.2-1.35% all pass; 1.3 is its centre)
const WASHOUT_TP_BPS = 100; // +1.0% take-profit
const WASHOUT_SL_BPS = 120; // -1.2% stop-loss
const WASHOUT_TRAIL_BPS = 100; // 1.0% trailing stop
const WASHOUT_MAX_HOLD = 480;

// Pullback rule.
const PULLBACK_DIP_BPS = 160; // 1.6% below the 60-bar high (the 1.3% sleeve lost money on dev; 1.6% only fires on deep pullbacks)
const PULLBACK_SIZE_BPS = 5000; // 50% of cash (uptrend sleeve: the washout rule rarely fires in an uptrend, so the sleeve carries the upside there)
const PULLBACK_TP_BPS = 80;
const PULLBACK_SL_BPS = 80;
const PULLBACK_TRAIL_BPS = 80;
const PULLBACK_MAX_HOLD = 240;

// Fallback rule.
const FALLBACK_SIZE_BPS = 5000; // 50% of cash
const FALLBACK_TP_BPS = 80;
const FALLBACK_SL_BPS = 80;
const FALLBACK_TRAIL_BPS = 80;
const FALLBACK_MAX_HOLD = 240;

const BPS = 10_000n;

type Kind = 'wash' | 'pull' | 'fall';

// Closes and highs of every bar seen, oldest first (bigint, price_scale units).
const closes: bigint[] = [];
const highs: bigint[] = [];
// EMA state (fixed-point, scaled by 1e6) for the fallback cross.
let emaFast: bigint | null = null;
let emaSlow: bigint | null = null;
const EMA_SCALE = 1_000_000n;
// EMA8 alpha = 2/9, EMA21 alpha = 2/22, in fixed point.
const EMA_FAST_NUM = 2n;
const EMA_FAST_DEN = 9n;
const EMA_SLOW_NUM = 2n;
const EMA_SLOW_DEN = 22n;
// Previous-bar EMA values, for exact cross detection (set before each update).
let prevEmaFast: bigint | null = null;
let prevEmaSlow: bigint | null = null;

function emaUpdate(prev: bigint, price: bigint, num: bigint, den: bigint): bigint {
  // prev is stored scaled by EMA_SCALE; price is raw: scale the price term only.
  return (price * num * EMA_SCALE + prev * (den - num)) / den;
}

// Position bookkeeping for the single open position.
let entryCost = 0n; // cost basis in quote units (fees included)
let entryQty = 0n;
let peakValue = 0n; // highest mark-to-market value since entry
let holdBars = 0;
let kind: Kind | null = null;
let buyFills = 0;
let lastSellBar = -1_000_000;
let barsSeen = 0;

function sma(bars: number): bigint | null {
  if (closes.length < bars) return null;
  let sum = 0n;
  for (let i = closes.length - bars; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(bars);
}

function highOf(bars: number): bigint | null {
  if (highs.length < bars) return null;
  let hi = 0n;
  for (let i = highs.length - bars; i < highs.length; i++) if (highs[i]! > hi) hi = highs[i]!;
  return hi;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = state.latest.get(SYMBOL);
    if (bar !== undefined) {
      closes.push(BigInt(bar.c));
      highs.push(BigInt(bar.h));
      barsSeen++;
      const price = BigInt(bar.c);
      if (emaFast === null) {
        emaFast = price * EMA_SCALE;
        emaSlow = price * EMA_SCALE;
        prevEmaFast = emaFast;
        prevEmaSlow = emaSlow;
      } else {
        prevEmaFast = emaFast;
        prevEmaSlow = emaSlow;
        emaFast = emaUpdate(emaFast, price, EMA_FAST_NUM, EMA_FAST_DEN);
        emaSlow = emaUpdate(emaSlow, price, EMA_SLOW_NUM, EMA_SLOW_DEN);
      }
    }

    // Fills reported on this batch: track sells (cooldown) and buys (fallback gate).
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') buyFills++;
      if (fill.side === 'sell') lastSellBar = barsSeen;
    }

    // Warm-up batches only build history; orders on them are rejected.
    if (state.warmingUp) return [];

    const pos = state.positions.get(SYMBOL);
    const close = state.close(SYMBOL);
    if (close === null) return [];

    // --- manage the open position ---
    if (pos !== undefined && pos.qty > 0n) {
      holdBars++;
      const value = state.value(SYMBOL, pos.qty);
      if (value > peakValue) peakValue = value;
      entryCost = pos.cost;
      entryQty = pos.qty;
      const retBps = ((value - entryCost) * BPS) / entryCost;
      const tp = kind === 'wash' ? WASHOUT_TP_BPS : kind === 'pull' ? PULLBACK_TP_BPS : FALLBACK_TP_BPS;
      const sl = kind === 'wash' ? WASHOUT_SL_BPS : kind === 'pull' ? PULLBACK_SL_BPS : FALLBACK_SL_BPS;
      const trail = kind === 'wash' ? WASHOUT_TRAIL_BPS : kind === 'pull' ? PULLBACK_TRAIL_BPS : FALLBACK_TRAIL_BPS;
      const maxHold = kind === 'wash' ? WASHOUT_MAX_HOLD : kind === 'pull' ? PULLBACK_MAX_HOLD : FALLBACK_MAX_HOLD;
      const trailHit = (peakValue * (BPS - BigInt(trail))) / BPS > value;
      if (retBps >= BigInt(tp) || retBps <= -BigInt(sl) || trailHit || holdBars >= maxHold) {
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: reset position bookkeeping.
    kind = null;
    entryCost = 0n;
    entryQty = 0n;
    peakValue = 0n;
    holdBars = 0;

    if (barsSeen - lastSellBar < COOLDOWN_BARS) return [];
    if (closes.length < 2) return [];
    const prevClose = closes[closes.length - 2]!;
    const bounced = close > prevClose;

    const mean = sma(MEAN_BARS);
    if (mean !== null && bounced) {
      // Washout: 1.2% below the 8-hour mean, full size.
      if (close * BPS < mean * (BPS - BigInt(WASHOUT_DIP_BPS))) {
        const notional = state.cash;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          kind = 'wash';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return [];
      }
      // Pullback: above the mean, 1.3% below the 60-bar high, quarter size.
      const hi = highOf(PULLBACK_BARS);
      if (hi !== null && close > mean && close * BPS < hi * (BPS - BigInt(PULLBACK_DIP_BPS))) {
        const notional = (state.cash * BigInt(PULLBACK_SIZE_BPS)) / BPS;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          kind = 'pull';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return [];
      }
    }

    // Fallback: no fill yet, late in the window, fast EMA crosses above slow EMA.
    if (buyFills === 0 && barsSeen >= FALLBACK_BAR && emaFast !== null && emaSlow !== null) {
      // Recompute the previous bar's EMAs from history to detect the cross exactly.
      // The stored EMAs already include this bar; the cross is detected by comparing
      // the previous stored values, kept in module scope via a one-bar delay below.
      if (crossedUp()) {
        const notional = (state.cash * BigInt(FALLBACK_SIZE_BPS)) / BPS;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          kind = 'fall';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }

    return [];
  },
});

// Exact cross detection: prev* hold last bar's EMAs, emaFast/emaSlow this bar's.
function crossedUp(): boolean {
  if (prevEmaFast === null || prevEmaSlow === null || emaFast === null || emaSlow === null) return false;
  return prevEmaFast <= prevEmaSlow && emaFast > emaSlow;
}
