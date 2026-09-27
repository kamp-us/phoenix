/**
 * The ownership gate as a refusal — the one shape `build claim` and `ship`'s landing verbs put in
 * front of their first write, each on its own group's codes.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {Attempt} from "../io/git.ts";
import type {CommentRecord} from "../io/issues.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {drivable, prOwnershipLine, voidGrantLines} from "./pr-ownership.ts";
import {type PullFacts, readPrOwnership} from "./read.ts";

export interface GateCodes {
	/** Proven: the PR is not ours and no grant hands it over. */
	readonly notOurs: number;
	/** A read the answer depends on could not complete. */
	readonly unknown: number;
}

export type GateResult =
	| {readonly _tag: "Pass"; readonly line: string}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/** The route out of a `notOurs` refusal, stated once so every verb names the same one. */
export const takeoverRoute = (pr: number): string =>
	`an account the repo trusts to grant runs "fabrika build takeover ${pr} --authorization <file>"`;

export const ownershipGate = <R>(
	verb: string,
	repo: string,
	pull: PullFacts,
	comments: Effect.Effect<Attempt<ReadonlyArray<CommentRecord>>, never, R>,
	codes: GateCodes,
	/** What the refusal leaves untouched, in the verb's own words — "nothing was armed.". */
	untouched: string,
): Effect.Effect<GateResult, never, R | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.map(readPrOwnership(repo, pull, comments), (read): GateResult => {
		if (read._tag === "Unknown") {
			return {
				_tag: "Refused",
				outcome: refuse(
					codes.unknown,
					`${verb}: cannot read whose PR #${pull.number} is: ${read.reason} — ownership is UNKNOWN, never ours; ${untouched}`,
				),
			};
		}
		const line = prOwnershipLine(verb, pull.number, read.ownership);
		if (drivable(read.ownership)) return {_tag: "Pass", line};
		return {
			_tag: "Refused",
			outcome: refuse(
				codes.notOurs,
				`${verb}: PR #${pull.number} is ${read.ownership.author === "" ? "not ours" : `${read.ownership.author}'s`} to finish — ${untouched} To hand it to the pipeline, ${takeoverRoute(pull.number)}.`,
				[line, ...voidGrantLines(verb, read.ownership)],
			),
		};
	});
