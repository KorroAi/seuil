# Changelog

## 1.1.0 (2026-11-15)

- **The line under the prompt is drawn properly in the terminal.** It now sits at the end of the hint line
  (`? for shortcuts · Seuil · 98 k / 300 k`). Before, it went through the plugin status line, which the terminal
  draws as a warning (`⚠seuil: Seuil · …`). Other surfaces (desktop app, remote) keep the status line.
- **The line follows the conversation during a turn** (every 2 s), instead of moving only at turn ends: during a
  long agentic turn you see it pass the threshold, then `compacting 365 k…`, then `last compaction 367 k → 47 k`.
- **No name said twice.** The terminal already writes `seuil:` before a transcript line and heads a toast with the
  plugin's name; the texts no longer start with `Seuil:` on top of it.
- **No more fake `0 k` at start.** Before the first answer the engine does not know the size yet: the line says
  `Seuil · compacts at 300 k`, and `/seuil` says the size is not measured yet.
- **Fixed: a long turn after a compaction could hold the next one back.** The size after a compaction is read at
  the end of the next turn; when that turn was long, the conversation had already grown back (100 k → 288 k in a
  real session), and Seuil waited for 432 k instead of 300 k. The "grow back by half" guard now applies only when a
  compaction could not bring the conversation well under the threshold.
- `/seuil` output no longer repeats the name (`seuil: On: compacts between turns above 300 k.`), lists the commands,
  and writes large totals in millions (`5.1 M tokens taken out`).
- Theme installer: reads Windows Terminal settings that hold comments or trailing commas (the default file does),
  instead of giving up. When it rewrites such a file it says so; the original is kept beside it.
- A 15-second explainer video (HD) and GIF at the top of the README.
- 15 tests (was 10).

## 1.0.0 (2026-11-14)

First release: automatic compaction between turns above a threshold, `/seuil` command, `diagnostic` tool, headless
road through `/compact`, the paper, the bench and the Campfire theme.
