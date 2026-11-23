# Fast static site generator

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/hemispheren3-sys/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/hemispheren3-sys/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast static site generator, built for the [site-generator-speed-01-run-20261122 bounty on make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122).

## Run

`node main.ts` — reads cases from `/input/cases.json` and writes answers to `/output/answers.json`. Node 22, no dependencies.

## How it works

`main.ts` drives the run; all the speed lives in `solve.js`, a single-pass renderer with a precompiled template cache and V8 tuning (`--no-incremental-marking`). About 2.9× faster than the house baseline on the practice set.

Built with [make.fun](https://make.fun/r/ejgx2h0h).
