# Tiny Bot — Dip Rider

[![make.fun competition](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/c/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![make.fun rank](https://make.fun/badge/mutkibubu66/tiny-bot-01/rank.svg)](https://make.fun/c/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![make.fun reward](https://make.fun/badge/mutkibubu66/tiny-bot-01/reward.svg)](https://make.fun/c/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A paper-trading bot for the [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/c/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) competition (bars-replay/v1): $10,000 USDC paper capital, hourly bars, 7 Solana symbols (FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF), long only, max 10 positions, max 25% weight per position, 10 bps fees + 5 bps slippage, min 8 trades, max drawdown 25%.

## Strategy

Two legs, one account:

1. **Dip leg (the edge).** Every bar, a symbol whose close sits at least 3% under its trailing 20-bar mean close is oversold: buy it, up to 3 open dip positions, sized at the smaller of even cash split and the 25% weight cap. Exit the whole position as soon as the close climbs back above its 20-bar mean, or at +4% over cost, or at −6% under cost. In a falling market this leg mostly sits in cash; in a choppy one it harvests the bounces.
2. **Trend leg (the trade count).** Every 8 bars, rebalance into the top 3 symbols by trailing 24-hour return (fallback: the single least-bad symbol when nothing is rising). It trades at 10% of the normal slice — small enough that its rotation drag stays tiny, large enough to keep the bot trading through quiet stretches. It never sells a dip-held symbol.

Both legs are long-only, whole-position exits, sells before buys, at most 16 orders per bar, slippage capped at 100% (effectively no cap beyond the engine's own checks).

## Backtest (dev window, 136 hourly bars, Nov 4–5 2026)

Local simulator mirroring the kit harness (decision checks at reply time against the batch account; fills at the next bar's open against recorded depth). Buy-and-hold on the same window:

| Strategy | Net PnL | Fills | Max DD |
| --- | --- | --- | --- |
| Buy-and-hold | −869.34 USDC | 14 | 10.92% |
| Dip Rider (this bot) | **+48.57 USDC** | **42** | **3.31%** |
| First 72 bars | +107.04 USDC | 28 | 3.31% |
| Last 72 bars | −53.23 USDC | 10 | 1.53% |

The bot beats buy-and-hold by about $918 on the full dev window, stays inside the 25% drawdown cap with room to spare, and clears the 8-trade guardrail on every 72-bar slice (28 and 10 fills).

## Layout

- `main.ts` — the bot. Node + TypeScript, standard library only (plus the kit SDK).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK (`bars/sdk/makefun-bars.ts`).

## License

MIT — see [LICENSE](LICENSE).
