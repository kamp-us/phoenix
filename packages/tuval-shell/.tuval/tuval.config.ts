/**
 * The consumer path, as a file rather than as a claim: what a Tuval user writes in
 * `~/.tuval/tuval.config.ts` to get a nightly `git fetch` on their desk. It is a fixture here —
 * `compose.unit.test.ts` imports it and reads the rows back — so the usage in the README is checked
 * by the test suite instead of being prose that drifts.
 *
 * Nothing in it runs a command or boots a desk: `shell({…})` builds a *row*, and a row is a record.
 * A child process is started when a prompt lands on a live process, which happens on a real desk.
 *
 * It is also the whole claim of this package, written down once: `cron` was authored against an
 * AI-agent port pair, `shell` is not an AI, and the two compose with nothing between them because
 * `jobShape` is about ports and never about what is behind them.
 */

import { cron } from "@kampus/tuval-cron";
import { shell } from "@kampus/tuval-shell";
import type { TuvalConfigInput } from "@kampus/tuval/sessions";

/** Nightly, at 03:00 local: fetch every remote, and say on the tile how it went. */
export const nightlyFetch = cron({
  id: "nightly-fetch",
  schedule: "0 3 * * *",
  prompt: "git -C ~/phoenix fetch --all",
  job: shell({ cwd: "/tmp", timeoutMs: 2 * 60 * 1000 }),
});

export default {
  version: 1,
  programs: [nightlyFetch],
  graph: { nodes: [{ id: "nightly-fetch", program: nightlyFetch.id, on: [] }] },
} satisfies TuvalConfigInput;
