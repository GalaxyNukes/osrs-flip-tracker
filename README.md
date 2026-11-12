# GE Flip Tracker

A phone-friendly Old School RuneScape Grand Exchange tracker. It reads live public prices and tells you, in plain words, what to buy, at what price, and what to sell or high alch it for.

- **For you**: recommendation cards for quick flips, overnight flips and high alching, sized to your gold and free GE slots.
- **Screener** and **Alch**: every item with a gap, with the checks behind each verdict.
- **My trades**: your open offers with advice, buy-limit timers and profit after tax.
- **Accuracy**: compares the chances the app shows with what prices then did.

## How it works

It is a static page: no server, no account, no API key, no tracking. Your browser fetches prices straight from the [OSRS Wiki real-time prices API](https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices). Your settings and trades are stored only in your own browser.

Every number comes from `engine.js`: the 2% GE tax (rounded down, capped at 5M per item), buy limits, the reliability checks, and a backtest that replays each plan on real past prices without looking ahead. Chances are records of the past, never guarantees.

The app only reads market data. It does not touch the game client or automate anything in the game.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `styles.css` | The page and its look |
| `engine.js` | All money maths, checks and the backtester |
| `app.js` | Fetching, screens and the trade log |
| `tests/` | Unit tests for the engine and a phone-size browser test |

## Tests

```
node --test tests/engine.test.js
node tests/ui.test.js   # needs Playwright and Chrome; uses synthetic test data only
```

Price data © the OSRS Wiki contributors and RuneLite. Old School RuneScape is a trademark of Jagex Ltd. This project is not affiliated with either.
