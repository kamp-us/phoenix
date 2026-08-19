/**
 * Whether the repo defines the labels a board guard's scope is cut from — the fact that separates
 * "this issue is not in scope" from "this repo never adopted the taxonomy" (#4272).
 *
 * Without it a per-issue seam check reports clean forever having checked nothing: every issue takes
 * the not-in-scope fork, and the guard's silence reads as a pass. Both board guards that scope by
 * label read it, so it lives here rather than inside either one.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {listLabels} from "../io/issues.ts";

export type LabelUniverse =
	| {readonly _tag: "present"}
	| {readonly _tag: "absent"; readonly missing: ReadonlyArray<string>};

export const PRESENT: LabelUniverse = {_tag: "present"};

/**
 * The universe of `required` in `repo`, or `null` when the label set itself could not be read.
 *
 * `null` is deliberately not an empty `absent`: an unreadable label set proves nothing, and a caller
 * that folded the two together would report a missing taxonomy it never saw.
 */
export const universeOf = (
	repo: string,
	required: ReadonlyArray<string>,
): Effect.Effect<LabelUniverse | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const attempt = yield* listLabels(repo);
		if (attempt._tag === "Failure") return null;
		const missing = required.filter((label) => !attempt.value.includes(label));
		return missing.length === 0 ? PRESENT : {_tag: "absent", missing};
	});
