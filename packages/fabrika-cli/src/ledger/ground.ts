/**
 * The freshness proof: how far this tree's HEAD sits behind `origin/main`.
 *
 * **The tree is stale by default until shown otherwise.** v1 planned against stale checkouts and
 * minted phantom children (#3330), and the repo has no post-merge sync with any call site (#4167) — so
 * there is no third arm here. A probe that *fails* is a failed read (`11`), never `20`: "I could not
 * tell" is not "it is stale", and it is certainly not "it is fresh".
 *
 * The base is fetched before it is read, through the shipped `fetchAndResolve` — reading a stale local
 * ref is the whole defect class.
 */

import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, fetchAndResolve, ok, type Shell} from "../io/git.ts";

export const BASE_REF = "origin/main";

/** How many commits `base` carries that HEAD does not. `0` is a fresh tree. */
export const commitsBehind = (base: string = BASE_REF): Shell<Attempt<number>> =>
	Effect.gen(function* () {
		const resolved = yield* fetchAndResolve(base);
		if (resolved._tag === "Failure") return resolved;
		const counted = yield* execCapture("git", ["rev-list", "--count", `HEAD..${resolved.value}`]);
		if (!counted.ok) return fail(counted.reason);
		const text = counted.stdout.trim();
		return /^\d+$/.test(text)
			? ok(Number.parseInt(text, 10))
			: fail(`\`git rev-list --count\` exited 0 but printed "${text}", which is not a count`);
	});
