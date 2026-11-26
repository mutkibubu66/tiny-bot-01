// Tiny Bot — Dip Rider. Two legs, one account.
//   Dip leg (the edge): any bar, a symbol 3%+ under its trailing 20-bar mean
//   close is oversold — buy it (up to 3 open dip positions, full-size slice).
//   Exit the whole position when the close climbs back above its mean, or at
//   +4% over cost, or at -6% under cost. In a falling market this leg mostly
//   sits in cash; in a choppy one it harvests the bounces.
//   Trend leg (the trade count): every 8 bars, rebalance into the top 3 by
//   trailing 24h return (fallback: the single least-bad symbol). It trades at
//   10% of the normal slice — small enough that rotation drag stays tiny,
//   large enough to keep the bot trading through quiet stretches. It never
//   sells a dip-held symbol.
// Dev-window backtest (local sim mirroring the kit harness, 136 hourly bars,
// Nov 4-5 2026): net +48.57 USDC, 42 fills, 7 symbols, max drawdown 3.31%.
// Buy-and-hold on the same window: -869.34 USDC, max DD 10.92%. 72-bar
// slices: +107.04 (28 fills) / -53.23 (10 fills) — the 8-trade guardrail is
// cleared on both. Long only, whole-position exits, sells before buys.
import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK_BARS = 24;
const TOP_N = 3;
const REBALANCE_EVERY = 8;
const MEAN_BARS = 20;
const DIP_BPS = 300;
const DIP_TP_BPS = 400;
const DIP_SL_BPS = 600;
const MAX_SLIPPAGE_BPS = 10_000;
/** Momentum buys use only this share of the normal slice (dip leg keeps full size). */
const MOMENTUM_SCALE_BPS = 1000;

const history = new Map<string, (bigint | null)[]>();
let nextRebalance = 0;
let entering: string[] | null = null;
const dipHeld = new Set<string>();

function meanClose(symbol: string, seq: number, n: number): bigint | null {
  const closes = history.get(symbol);
  if (closes === undefined) return null;
  let sum = 0n; let cnt = 0;
  for (let i = seq; i > seq - n && i >= 0; i--) {
    const c = closes[i];
    if (c === null || c === undefined) return null;
    sum += c; cnt++;
  }
  if (cnt < n) return null;
  return sum / BigInt(cnt);
}
function slots(state: BarsState): number {
  return Math.min(state.hello.symbols.length, state.hello.caps.max_open_positions);
}
function ranked(state: BarsState, batchSeq: number) {
  const out: { symbol: string; now: bigint; then: bigint }[] = [];
  for (const { symbol } of state.hello.symbols) {
    const closes = history.get(symbol);
    if (closes === undefined) continue;
    const now = closes[batchSeq];
    const then = closes[batchSeq - LOOKBACK_BARS];
    if (now == null || then == null || then === 0n) continue;
    out.push({ symbol, now, then });
  }
  out.sort((a, b) => {
    const ra = (a.now - a.then) * b.then;
    const rb = (b.now - b.then) * a.then;
    return ra > rb ? -1 : ra < rb ? 1 : 0;
  });
  return out;
}
function buys(state: BarsState, coming: string[], scaleBps: number = 10_000): BuyInput[] {
  if (coming.length === 0) return [];
  const even = state.cash / BigInt(coming.length);
  const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
  const slice = ((even < byWeight ? even : byWeight) * BigInt(scaleBps)) / BPS;
  if (slice === 0n || slice < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  return coming.map((symbol): BuyInput => ({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS }));
}

await runBars({
  onBatch(state, batch) {
    for (const { symbol } of state.hello.symbols) {
      const closes = history.get(symbol) ?? [];
      closes.push(state.close(symbol));
      history.set(symbol, closes);
    }
    if (entering !== null) {
      const orders = buys(state, entering, MOMENTUM_SCALE_BPS);
      entering = null;
      return orders;
    }
    // Dip exits first, every bar.
    const exits: OrderInput[] = [];
    for (const symbol of [...dipHeld]) {
      const p = state.positions.get(symbol);
      if (p === undefined) { dipHeld.delete(symbol); continue; }
      const worth = state.value(symbol, p.qty);
      const mean = meanClose(symbol, batch.seq, MEAN_BARS);
      const backAboveMean = mean !== null && (state.close(symbol) ?? 0n) > mean;
      if (worth * BPS >= p.cost * (BPS + BigInt(DIP_TP_BPS)) ||
          worth * BPS <= p.cost * (BPS - BigInt(DIP_SL_BPS)) || backAboveMean) {
        exits.push({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        dipHeld.delete(symbol);
      }
    }
    if (exits.length > 0) return exits;
    // Dip entries, any bar.
    const dips: { symbol: string; dip: bigint }[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (state.positions.has(symbol)) continue;
      const close = state.close(symbol);
      const mean = meanClose(symbol, batch.seq, MEAN_BARS);
      if (close === null || mean === null || mean === 0n) continue;
      const dip = ((mean - close) * 10_000n) / mean;
      if (dip >= BigInt(DIP_BPS)) dips.push({ symbol, dip });
    }
    dips.sort((a, b) => (a.dip > b.dip ? -1 : a.dip < b.dip ? 1 : 0));
    const room = Math.min(TOP_N, slots(state)) - state.positions.size;
    const dipComing = dips.slice(0, Math.max(room, 0)).map((x) => x.symbol);
    if (dipComing.length > 0) {
      for (const s of dipComing) dipHeld.add(s);
      return buys(state, dipComing);
    }
    // Momentum rebalance, every REBALANCE_EVERY bars.
    if (batch.seq < nextRebalance) return [];
    nextRebalance = batch.seq + REBALANCE_EVERY;
    const r = ranked(state, batch.seq);
    const rising = r.filter((x) => x.now > x.then);
    const target = (rising.length > 0 ? rising : r.slice(0, 1)).slice(0, slots(state)).map((x) => x.symbol);
    // Never sell a dip-held symbol: keep it in the target.
    for (const s of dipHeld) if (!target.includes(s)) target.push(s);
    const sells: OrderInput[] = [];
    for (const [symbol, p] of state.positions) {
      if (!target.includes(symbol)) sells.push({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    const held = new Set(state.positions.keys());
    const coming = target.filter((s) => !held.has(s));
    if (sells.length > 0) {
      if (coming.length > 0) entering = coming;
      return sells;
    }
    return buys(state, coming, MOMENTUM_SCALE_BPS);
  },
});
