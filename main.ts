// Driver for the site-generator-speed entry (make.fun).
//
// The harness runs `node main.ts` under Node 22. It reads the cases from
// /input/cases.json — a JSON array of { id, input } — answers each case on
// its own with run() from solve.js, and writes /output/answers.json: the
// answers in the same order as the cases. When run outside a container the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR variables stand in for /input and
// /output. All of the speed lives in solve.js; this file only drives it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// The house baseline runs with incremental marking off, and an entry may
// tune V8's flags the same way — set before solve.js is imported so all of
// its work runs under it.
setFlagsFromString('--no-incremental-marking');

/** solve.js, loaded by URL (a .js module carries no types) and typed here. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

/** Every case answered in order; run() is pure, so mapping is safe. */
function answerAll(list: { id: string; input: unknown }[]): unknown[] {
  const out: unknown[] = new Array(list.length);
  for (let k = 0; k < list.length; k++) out[k] = run(list[k].input);
  return out;
}

writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answerAll(cases)));
