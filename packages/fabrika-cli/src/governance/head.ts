/**
 * The commit binding every read in this group runs before it reads anything.
 *
 * The binding itself is **imported**, not restated: `../review/head.ts`'s `bindHead` already fetches
 * `pull/<pr>/head`, refuses a `--sha` that is not the PR's head, and resolves both ends of the range
 * out of the object database with nothing checked out. Re-deriving it here would be a second answer
 * to a solved question — and the two would drift the first time one of them learned something.
 *
 * What this module adds is the **noun**. `bindHead`'s UNKNOWN refusal says "the artifact"; each verb
 * here has to say what is unknown *to it*, because "the derivation is UNKNOWN" and "what the subject
 * says is UNKNOWN" leave a reader free to guess differently. The rewrite is a fixed-substring swap on
 * one message this module owns the shape of, so a change to `bindHead`'s wording surfaces as a failed
 * unit test rather than as a silently un-rewritten refusal.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {PullRecord} from "../io/pulls.ts";
import {type Binding, bindHead, boundLine} from "../review/head.ts";
import type {VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";

export type {Binding, BoundHead} from "../review/head.ts";
export {boundLine};

/** The tail `bindHead` writes, which each verb below replaces with its own. */
const IMPORTED_TAIL = "the artifact cannot be bound to a commit, so what it shows is UNKNOWN.";

/** Swap the imported tail for this verb's. A message that does not carry it is passed through. */
export const withBindingNoun = (reason: string, tail: string): string =>
	reason.endsWith(IMPORTED_TAIL) ? `${reason.slice(0, -IMPORTED_TAIL.length)}${tail}` : reason;

/**
 * Bind this run's read to one commit, phrasing the UNKNOWN refusal in this verb's own terms.
 *
 * `tail` is the clause after the em dash — e.g. `the file list cannot be bound to a commit, so the
 * derivation is UNKNOWN.` Only the `11` arm is rewritten: the `10` and `12` arms already read as this
 * group's contract states them, so touching them would be churn.
 */
export const bindGovernanceHead = (
	verb: string,
	tail: string,
	repo: string,
	pr: number,
	pull: PullRecord,
	asked: string | null,
): Effect.Effect<Binding, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bound = yield* bindHead(verb, repo, pr, pull, asked);
		if (bound._tag !== "Refused" || bound.outcome.code !== PRECONDITION_UNKNOWN) return bound;
		const outcome: VerbOutcome = {
			...bound.outcome,
			stderr: bound.outcome.stderr.map((line) => withBindingNoun(line, tail)),
		};
		return {_tag: "Refused" as const, outcome};
	});
