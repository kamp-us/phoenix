/**
 * The preconditions every `build` verb runs before it answers: resolve the repo, resolve the target,
 * and keep *proven absent* apart from *unreadable*.
 *
 * It lives here rather than in each verb because that split is the group's whole posture and fourteen
 * copies of it are fourteen chances to fold the two together. Every message is prefixed with the
 * invoked verb's name — the contract states that once for the whole group, so it is applied once here.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue, type IssueRecord, resolveRepo} from "../io/issues.ts";
import {getPullRequest, type PullRecord} from "../io/pulls.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";

/** `<verb>: scanned <n> <noun>(s)[; <note>].` — the count first, so an empty answer is auditable. */
export const scannedLine = (verb: string, scanned: number, noun: string, note?: string): string =>
	`${verb}: scanned ${scanned} ${noun}${scanned === 1 ? "" : "s"}${
		note === undefined ? "" : `; ${note}`
	}.`;

/** A positive integer, or the usage refusal — every number-taking verb's first check. */
export const badNumber = (verb: string, noun: string, value: number): VerbOutcome | null =>
	Number.isInteger(value) && value > 0 ? null : refuse(FAILED, `${verb}: ${value} is not ${noun}.`);

export type Resolved =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Repo"; readonly repo: string};

export const resolveTargetRepo = (
	verb: string,
	explicit: string | null,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Resolved, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const attempt = yield* resolveRepo(explicit, env);
		return attempt._tag === "Failure"
			? {
					_tag: "Refused" as const,
					outcome: refuse(
						FAILED,
						`${verb}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.`,
					),
				}
			: {_tag: "Repo" as const, repo: attempt.value};
	});

export type IssueTarget =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Issue"; readonly issue: IssueRecord};

/**
 * One open issue, or the refusal.
 *
 * Absent and closed share `7` because both are the same fact to a caller — there is no live issue to
 * act on — while an unreadable one is `11` and says nothing about whether it exists.
 */
export const openIssue = (
	verb: string,
	repo: string,
	number: number,
	unknownMessage: (reason: string) => string,
): Effect.Effect<IssueTarget, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getIssue(repo, number);
		if (found._tag === "Absent" || (found._tag === "Present" && found.value.state !== "open")) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(ZERO_SCOPE, `${verb}: issue #${number} is proven absent or closed.`),
			};
		}
		if (found._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(PRECONDITION_UNKNOWN, unknownMessage(found.reason)),
			};
		}
		return {_tag: "Issue" as const, issue: found.value};
	});

export type PullTarget =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Pull"; readonly pull: PullRecord};

export const openPull = (
	verb: string,
	repo: string,
	pr: number,
	unknownMessage: (reason: string) => string,
): Effect.Effect<PullTarget, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getPullRequest(repo, pr);
		if (found._tag === "Absent" || (found._tag === "Present" && found.value.state !== "open")) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(ZERO_SCOPE, `${verb}: PR #${pr} is proven absent or closed.`),
			};
		}
		if (found._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(PRECONDITION_UNKNOWN, unknownMessage(found.reason)),
			};
		}
		return {_tag: "Pull" as const, pull: found.value};
	});
