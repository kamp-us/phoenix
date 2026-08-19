/**
 * The one question `review ci` and `ship checks` both ask: does this repo produce CI at all?
 *
 * It is answered here rather than at each call site because the two verbs must not drift on it —
 * v1 shipped the check-run rollup twice in `jq` and the copies drifted, which is the whole reason
 * `../review/rollup.ts` is shared. This is the same rule one layer up: the *producer* question,
 * decided over a workflow count and the repo's `ci.noProducer`, with no verb's vocabulary in it.
 *
 * **The count is the whole evidence.** Workflow existence is sufficient and nothing inspects a
 * workflow's contents (#5603, R17.1) — so a caller hands in a number, and this module never opens a
 * file.
 *
 * **`Absent` and `OptedOut` stay apart from `Present`, and neither of them is green.** A repo whose
 * CI has not reported yet is pending; a repo that has no CI at all is a different fact, and folding
 * the second into the first is how an empty enumeration reads as "still running" forever.
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {Resolution} from "./key-group.ts";
import {type CiSurface, ciKey} from "./keys/ci.ts";
import {resolve} from "./load.ts";
import {loadRepoConfig} from "./working-root.ts";

export type Producer =
	/** At least one workflow: the repo produces CI, whatever it has reported so far. */
	| {readonly _tag: "Present"}
	/** Zero workflows under the shipped default — no evidence is possible, so nothing is answered. */
	| {readonly _tag: "Refused"; readonly reason: string}
	/** Zero workflows, and the repo declared `degrade`: the fact is reported, never as green. */
	| {readonly _tag: "OptedOut"; readonly note: string}
	/** The config could not be read or did not decode — never a default, never a pass. */
	| {readonly _tag: "Unknown"; readonly reason: string};

/** `ci` as the checkout above `cwd` declares it. */
export const resolveCi = (
	cwd: string,
): Effect.Effect<Resolution<CiSurface>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.map(loadRepoConfig(cwd), (load) => resolve(load, ciKey));

export const producerFor = (
	verb: string,
	repo: string,
	workflows: number,
	resolved: Resolution<CiSurface>,
): Producer => {
	if (resolved._tag === "Unknown" || resolved._tag === "Malformed") {
		return {
			_tag: "Unknown",
			reason: `${verb}: cannot read \`ci\` from the repo config (${resolved.reason}) — whether ${repo} produces CI is UNKNOWN, never green.`,
		};
	}
	if (workflows > 0) return {_tag: "Present"};
	return resolved.value.noProducer === "degrade"
		? {
				_tag: "OptedOut",
				note: `${verb}: ${repo} declares \`ci.noProducer: degrade\` and has zero workflows — no producer, so there is nothing to roll up.`,
			}
		: {
				_tag: "Refused",
				reason: `${verb}: ${repo} has zero workflows — no CI producer, so no head can be evidenced (ADR 0092). A repo that runs no workflows declares \`ci.noProducer: "degrade"\`.`,
			};
};
