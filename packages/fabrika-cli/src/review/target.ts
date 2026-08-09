/**
 * The precondition every `review` verb runs before it judges anything: resolve the repo, resolve the
 * PR, and split *proven absent* from *unreadable*.
 *
 * It lives here rather than in each verb because the split is the group's whole fail-closed posture
 * and six copies of it are six chances to fold the two outcomes together — a 404 is a fact about the
 * repository, an unreachable GitHub is not a fact about anything.
 *
 * The scanned-count line is here for the same reason: this group's convention is that every list
 * read reports what it saw on stderr, and a verdict driven by a silently truncated read is a verdict
 * over unknown scope (#3999).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveRepo} from "../io/issues.ts";
import {getPullRequest, type PullRecord} from "../io/pulls.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";

/** `<verb>: scanned <n> <noun>(s) [in <repo>][; <note>].` — the count first, on every run. */
export const scannedLine = (verb: string, scanned: number, noun: string, note?: string): string =>
	`${verb}: scanned ${scanned} ${noun}${scanned === 1 ? "" : "s"}${
		note === undefined ? "" : `; ${note}`
	}.`;

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

export interface TargetOptions {
	/** Refuse a closed PR on `7` — true for the verbs whose answer would gate nothing. */
	readonly requireOpen: boolean;
	/** The tail of the closed-PR refusal, which each verb phrases in its own terms. */
	readonly closedReason?: string;
	/** Refuse a PR with zero changed files on `7` — a review over nothing (ADR 0092, #4060). */
	readonly requireFiles: boolean;
	/** The tail of the zero-changed-files refusal, which each verb phrases in its own terms. */
	readonly emptyReason?: string;
	/**
	 * The whole `11` message, when this verb names something other than "the scope" as UNKNOWN.
	 *
	 * The wording is the verb's because the refusal has to say what is unknown *to it* — for
	 * `review deviations` that is the disclosure state, and "the scope is UNKNOWN" would leave the
	 * caller free to read `none`.
	 */
	readonly unknownMessage?: (reason: string) => string;
}

export type Target =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Pull"; readonly pull: PullRecord};

export const openPull = (
	verb: string,
	repo: string,
	pr: number,
	options: TargetOptions,
): Effect.Effect<Target, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getPullRequest(repo, pr);
		if (found._tag === "Absent") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(ZERO_SCOPE, `${verb}: PR #${pr} not found in ${repo}.`),
			};
		}
		if (found._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					options.unknownMessage?.(found.reason) ??
						`${verb}: cannot read PR #${pr} in ${repo}: ${found.reason} — the scope is UNKNOWN.`,
				),
			};
		}
		if (options.requireOpen && found.value.state !== "open") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					ZERO_SCOPE,
					`${verb}: PR #${pr} is closed — ${options.closedReason ?? "nothing to review."}`,
				),
			};
		}
		if (options.requireFiles && found.value.changedFiles === 0) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					ZERO_SCOPE,
					`${verb}: PR #${pr} has zero changed files — ${
						options.emptyReason ?? "refusing to derive an empty review (ADR 0092, #4060)."
					}`,
				),
			};
		}
		return {_tag: "Pull" as const, pull: found.value};
	});

/** A positive integer, or the usage refusal — every verb's first check. */
export const badNumber = (verb: string, noun: string, value: number): VerbOutcome | null =>
	Number.isInteger(value) && value > 0 ? null : refuse(FAILED, `${verb}: ${value} is not ${noun}.`);
