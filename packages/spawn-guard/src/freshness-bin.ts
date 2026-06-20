/**
 * `spawn-guard` SessionStart freshness check (#835) — the proactive half of #777.
 *
 * Dependency-light by construction: it imports ONLY `preflight.ts` (node-builtins,
 * no `@effect/platform-node`), because its whole job is to run on a tree where that
 * runtime dep is missing. It reuses the same `depsInstalled` resolution probe #834
 * exposes (via `freshnessSignal`), never a re-derived check.
 *
 * SessionStart cannot block (code.claude.com/docs/en/hooks); it surfaces context. On a
 * stale tree it emits a `SessionStart` `additionalContext` (so the agent proactively
 * tells the user to run `pnpm install`) AND a loud stderr note (shown to the user on
 * exit 2). On a fresh tree it stays silent — exit 0, no output — so a healthy session
 * is never spammed.
 */
import {freshnessSignal} from "./preflight.ts";

const signal = freshnessSignal();
if (signal !== null) {
	console.log(
		JSON.stringify({
			hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: signal},
		}),
	);
	console.error(`spawn-guard: ${signal}`);
	process.exit(2); // exit 2 ⇒ stderr is shown to the user; SessionStart continues regardless.
}
