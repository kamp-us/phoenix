/**
 * One key of `.fabrika.jsonc`, read off the checkout a verb is standing in.
 *
 * Every reader wants the same three things — the value, a sentence naming where it came from, and a
 * refusal it can print verbatim — so the four resolution arms collapse here once instead of at each
 * call site. **`Malformed` and `Unknown` both refuse**: a value nobody could decode and a file
 * nobody could read are equally not an answer, and neither may fall back to the shipped default it
 * did not resolve to. Falling back is how a typo in `.fabrika.jsonc` silently restores phoenix's own
 * values in a repo that is not phoenix.
 *
 * Per key rather than a whole-surface read: a verb that needs the standing lanes has no business
 * refusing over a malformed `cycleDoc` it never opens. The whole-config gate that *does* refuse on
 * any key is `./unusable.ts`, and it stays the write path's gate.
 */

import {Effect, type FileSystem, type Path} from "effect";
import {CONFIG_PATH} from "./document.ts";
import type {KeyGroup} from "./key-group.ts";
import {resolve} from "./load.ts";
import {loadRepoConfig} from "./working-root.ts";

export type Read<A> =
	/** The value to use, and the sentence a verb prints about where it came from. */
	| {readonly _tag: "Value"; readonly value: A; readonly note: string}
	/** No value may be used, and this is the reason, worded by the key that raised it. */
	| {readonly _tag: "Refused"; readonly reason: string};

export const readKey = <A>(
	cwd: string,
	group: KeyGroup<A>,
): Effect.Effect<Read<A>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const resolved = resolve(yield* loadRepoConfig(cwd), group);
		switch (resolved._tag) {
			case "Malformed":
			case "Unknown":
				return {_tag: "Refused" as const, reason: resolved.reason};
			case "Declared":
				return {
					_tag: "Value" as const,
					value: resolved.value,
					note: `\`${group.key}\` as declared in ${CONFIG_PATH}`,
				};
			case "Default":
				return {
					_tag: "Value" as const,
					value: resolved.value,
					note: `the shipped \`${group.key}\` — ${resolved.reason}`,
				};
		}
	});
