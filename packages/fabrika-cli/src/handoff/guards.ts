/**
 * The checks every `handoff` verb runs before it decides anything, factored here so four verbs
 * cannot disagree about what a missing issue is, what a leak is, or what a failed read costs.
 *
 * Each returns the refusal itself rather than a boolean, so a caller cannot receive "this failed"
 * and then compose a message that drifts from the code it seats.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue, type IssueRecord, resolveRepo} from "../io/issues.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {BARE_AT_PATH, LEAKED_PATH, NO_TARGET, PRECONDITION_UNKNOWN} from "./codes.ts";

export type Guarded<A> =
	| {readonly _tag: "Ok"; readonly value: A}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

const refused = (outcome: VerbOutcome): Guarded<never> => ({_tag: "Refused", outcome});

/** The target repository, or the usage refusal that names both ways to supply it. */
export const targetRepo = (
	verb: string,
	explicit: string | null,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Guarded<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const attempt = yield* resolveRepo(explicit, env);
		return attempt._tag === "Ok"
			? {_tag: "Ok" as const, value: attempt.value}
			: refused(
					refuse(
						FAILED,
						`${verb}: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.`,
					),
				);
	});

/**
 * The issue this verb acts on, or the refusal its absence seats.
 *
 * A 404 is a **verdict** (`7`); anything else is UNKNOWN (`11`). Folding them would let an
 * unreachable GitHub report an issue that exists as one that does not.
 */
export const requireIssue = (
	verb: string,
	repo: string,
	issue: number,
): Effect.Effect<Guarded<IssueRecord>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getIssue(repo, issue);
		if (found._tag === "Absent") {
			return refused(refuse(NO_TARGET, `${verb}: #${issue} does not exist in ${repo}.`));
		}
		if (found._tag === "Unknown") {
			return refused(
				refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read #${issue}'s state: ${found.reason} — the ground is UNKNOWN.`,
				),
			);
		}
		return {_tag: "Ok" as const, value: found.value};
	});

/**
 * The leak refusal for a composed document, or `null`.
 *
 * **The base's `5` reads "…and `--redact` was not given"; no `handoff` verb offers `--redact`**, so
 * here it fires on any machine-local path unconditionally. `which` names the half that carried it
 * because the two have different remedies: the caller can rewrite their own prose, and a leak in the
 * derived ground is a refusal they cannot fix by editing stdin.
 */
export const leakFree = (verb: string, which: string, text: string): VerbOutcome | null => {
	if (isBareAtReference(text)) {
		return refuse(
			BARE_AT_PATH,
			`${verb}: the ${which} carries a bare @ path reference (the text never arrived) — nothing was written.`,
		);
	}
	const scan = scanBody(text);
	return scan.leaks.length === 0
		? null
		: refuse(
				LEAKED_PATH,
				`${verb}: the ${which} carries a machine-local path (${scan.leaks.length} hit(s)) — nothing was written.`,
				renderLeaks(scan.leaks),
			);
};
