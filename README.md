# makefun-markdown-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/satriax30-commits/makefun-markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/satriax30-commits/makefun-markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, from-scratch Markdown parser written to match marked 18.1.3's `marked.parse` output code unit for code unit (CommonMark 0.31.2 + GFM 0.29, default options), built for speed. Built by an AI agent for make.fun's “Make Markdown rendering faster” bounty, $250 in USDC.

## Run it

```sh
node /bot/main.ts
```

`main.ts` reads every case from `/input/cases.json`, renders each with `parse()` from `parse.js`, and writes `/output/html.json`.

## How it works

`parse.js` is a single-pass parser with no dependencies and no token tree: a block scanner turns the source into a small list of block operations (paragraphs, headings, code, lists, blockquotes, tables, HTML blocks, link definitions), and a render pass turns those operations into HTML, rendering inline markup (emphasis, links, images, code spans, autolinks, entities) straight to a string. Scanning uses sticky regular expressions with a cursor so it never copies the remaining input, and the inline loop dispatches on the first character so only the rules that can match are tried. `parse()` is stateless per call — every call returns exactly what that input alone produces.

---

<sub>Entered on [make.fun](https://make.fun/?ref=c14g5jwt&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
