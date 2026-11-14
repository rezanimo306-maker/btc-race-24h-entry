# Washout-dip cbBTC bot

A long-only 1-minute trading bot for Coinbase Wrapped BTC (cbBTC) against USDC,
built for the make.fun bounty "Race a BTC trading bot live for 24 hours"
(`bars-replay/v1`). It starts with $1,000 of paper money; nothing is traded
for real.

## Strategy

The dev window is a slow grind down (-4.9% over 24h) with small ~0.5%
oscillations around the drift, so frequent scalping loses to the ~32 bps
round-trip cost (4 bps fee + 2 bps slippage + ~13 bps price impact at the
pool's depth). This bot trades rarely and only on outsized dislocations:

1. **Washout (primary).** When the close falls 1.3% or more below the
   8-hour mean (SMA of the last 480 closes) **and** the bar closes up
   (bounce confirmation), buy with 100% of cash. Exit at +1.0%
   take-profit, -1.2% stop-loss, a 1.0% trailing stop from the peak mark,
   or after 480 bars. The 1.2-1.35% dip band is a plateau (all values in
   it pass the gate); 1.3% is its centre, picked for robustness rather
   than the peak.
2. **Pullback (secondary, uptrend sleeve).** When the close is above the
   8-hour mean but 1.6% or more below the 60-bar high, again with an up
   close, buy with 50% of cash. Exit at +0.8% / -0.8% / 0.8% trailing /
   240 bars. The sleeve used to fire at 1.3% / 25% size and lost money
   on the dev window (-$2.34 on its only trade), so it now only fires on
   deeper pullbacks — it is insurance for an uptrend race window, where
   the washout rule rarely triggers.
3. **Fallback.** If no buy has filled by the 1000th bar and the fast EMA(8)
   crosses above the slow EMA(21), buy with 50% of cash (same exits as the
   pullback). This exists only so the bot takes at least one trade in a
   window where neither dip rule fires.

A 3-bar cooldown follows every sell fill. All comparisons use exact bigint
arithmetic; the bot reads no clock, no environment, no randomness, and no
files — two runs on the same bars produce identical orders.

## Dev-window result (frozen 24h, kit `grade-local --driver process`)

- Net PnL: **+$18.85** (gate: above $0; at 2x fees still +$17.22)
- Trades: 2 round trips (4 fills), 2 wins, 0 losses
- Max drawdown: **-0.73%** (bar: 25%)
- Both halves of the window are positive (+$4.90 first half, +$13.95 second)

Trade log: washout buy bar 501 @ $68,931, sold bar 859 @ $69,649 (+1.04%);
washout buy bar 984 @ $68,335, sold bar 1109 @ $68,983 (+0.95%).

Robustness: varying each key parameter one step (dip 1.2/1.4%, TP 0.9/1.1%,
trailing 0.8/1.5%, stop 0.8/2.0%, pullback dip 1.3/2.0%, size 25%, max hold
240) keeps every variant profitable — neighbourhood min +$8.58, mean +$16.83,
vs +$6.25 / +$13.84 for the previous version. Deliberately NOT taken: TP
1.1% (+$20.22 on dev) sits on a cliff — both winning snap-backs topped out
at ~1.1%, so 1.0% catches more of them on an unseen window; and a
volatility-normalised (z-score) entry, which lost money on every threshold
tested.

## Layout

- `main.ts` — the bot (Node 22, standard library only, via the vendored shim).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `agent-fun/bars-replay/v1` shim.
- `LICENSE` — MIT.

## Run locally

Grade it on the dev window with the kit (from the unpacked kit directory):

```
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```
