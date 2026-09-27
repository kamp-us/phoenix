/**
 * The one question `review ci` and `ship checks` both ask: does this repo produce CI at all?
 *
 * It is answered here rather than at each call site because the two verbs must not drift on it —
 * v1 shipped the check-run rollup twice in `jq` and the copies drifted, which is the whole reason
 * `../review/rollup.ts` is shared. This is the same rule one layer up: the *producer* question,
 * decided over the workflow inventory and the repo's `ci.noProducer`, with no verb's vocabulary in it.
 *
 * **A producer is a workflow the repo authors itself.** "Zero workflows" means zero
 * `.github/workflows/*` files; the `dynamic/<provider>/<name>` entries the platform lists on the
 * repo's behalf — default CodeQL setup, Dependabot, the Copilot reviewer — never count, because a
 * repo carrying only those has no CI of its own and `ci.noProducer` is the declaration it makes.
 * The line is `isRepoAuthored`'s, so this module and gate coverage cannot draw it twice.
 *
 * **Existence is the whole evidence.** Nothing inspects a workflow's contents — a caller hands in
 * the inventory's paths as the platform addresses them, and this module never opens a file.
 *
 * **`Absent` and `OptedOut` stay apart from `Present`, and neither of them is green.** A repo whose
 * CI has not reported yet is pending; a repo that has no CI at all is a different fact, and folding
 * the second into the first is how an empty enumeration reads as "still running" forever.
 */

import {Effect, type FileSystem, type Path} from "effect";
import {isRepoAuthored} from "../review/gate-coverage.ts";
import type {Resolution} from "./key-group.ts";
import {type CiSurface, ciKey} from "./keys/ci.ts";
import {resolve} from "./load.ts";
import {loadRepoConfig} from "./working-root.ts";

export type Producer =
	/** At least one repo-authored workflow: the repo produces CI, whatever it has reported so far. */
	| {readonly _tag: "Present"}
	/** No repo-authored workflow under the shipped default — no evidence is possible, so nothing is answered. */
	| {readonly _tag: "Refused"; readonly reason: string}
	/** No repo-authored workflow, and the repo declared `degrade`: the fact is reported, never as green. */
	| {readonly _tag: "OptedOut"; readonly note: string}
	/** The config could not be read or did not decode — never a default, never a pass. */
	| {readonly _tag: "Unknown"; readonly reason: string};

/** `ci` as the checkout above `cwd` declares it. */
export const resolveCi = (
	cwd: string,
): Effect.Effect<Resolution<CiSurface>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.map(loadRepoConfig(cwd), (load) => resolve(load, ciKey));

/** Whether an active workflow inventory holds a workflow of the repo's own — the producer test. */
export const producesCi = (workflows: ReadonlyArray<string>): boolean =>
	workflows.some(isRepoAuthored);

/** The producer answer over the repo's active workflow paths, as the inventory addresses them. */
export const producerFor = (
	verb: string,
	repo: string,
	workflows: ReadonlyArray<string>,
	resolved: Resolution<CiSurface>,
): Producer => {
	if (resolved._tag === "Unknown" || resolved._tag === "Malformed") {
		return {
			_tag: "Unknown",
			reason: `${verb}: cannot read \`ci\` from the repo config (${resolved.reason}) — whether ${repo} produces CI is UNKNOWN, never green.`,
		};
	}
	if (producesCi(workflows)) return {_tag: "Present"};
	return resolved.value.noProducer === "degrade"
		? {
				_tag: "OptedOut",
				note: `${verb}: ${repo} declares \`ci.noProducer: degrade\` and has zero repo-authored workflows — no producer, so there is nothing to roll up.`,
			}
		: {
				_tag: "Refused",
				reason: `${verb}: ${repo} has zero repo-authored workflows (platform-provided \`dynamic/*\` entries do not count) — no CI producer, so no head can be evidenced. A repo that runs no workflows declares \`ci.noProducer: "degrade"\`.`,
			};
};
