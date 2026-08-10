/**
 * The preconditions every `ship` verb runs before it answers or writes: resolve the repo, resolve
 * the PR, split *proven absent* from *unreadable*, and bind a caller-supplied `--sha` to the live
 * head.
 *
 * It lives here rather than in each verb because the split is the group's whole fail-closed posture,
 * and thirteen copies of it are thirteen chances to fold the two outcomes together — a 404 is a fact
 * about the repository, an unreachable GitHub is not a fact about anything.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveRepo} from "../io/issues.ts";
import {getPullRequest, type PullRecord} from "../io/pulls.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";

/** The null token this group prints for a field with no value. One token, every verb. */
export const NULL_TOKEN = "-";

/** `<verb>: scanned <n> <noun>(s)[; <note>].` — the count first, on every list read. */
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
	/** Refuse a closed PR on `7`, with the tail this verb phrases in its own terms. */
	readonly closedReason?: string;
	/** Refuse a merged PR on `7` — `ship enqueue`'s arm, which has nothing left to act on. */
	readonly mergedReason?: string;
	/** The whole `11` message, when this verb names something other than "the scope" as UNKNOWN. */
	readonly unknownMessage?: (reason: string) => string;
}

export type Target =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Pull"; readonly pull: PullRecord};

export const resolvePull = (
	verb: string,
	repo: string,
	pr: number,
	options: TargetOptions = {},
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
						`${verb}: cannot read PR #${pr} in ${repo}: ${found.reason} — nothing is proven.`,
				),
			};
		}
		const pull = found.value;
		if (options.mergedReason !== undefined && pull.merged) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(ZERO_SCOPE, `${verb}: PR #${pr} is merged — ${options.mergedReason}`),
			};
		}
		if (options.closedReason !== undefined && pull.state !== "open") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(ZERO_SCOPE, `${verb}: PR #${pr} is closed — ${options.closedReason}`),
			};
		}
		return {_tag: "Pull" as const, pull};
	});

/** A positive integer, or the usage refusal — every verb's first check. */
export const badNumber = (verb: string, noun: string, value: number): VerbOutcome | null =>
	Number.isInteger(value) && value > 0 ? null : refuse(FAILED, `${verb}: ${value} is not ${noun}.`);

/**
 * A `--sha` the caller verified: 7–40 lowercase hex, or nothing.
 *
 * **The empty-SHA degeneration is designed out at the type layer.** An empty or malformed value is a
 * usage error, never a matches-everything pattern — v1's `case "$H" in "$SHA"*)` collapsed to `*` on
 * an empty capture, twice, in two different scripts (#4223).
 */
export const inspectedSha = (verb: string, raw: string): VerbOutcome | string => {
	const value = raw.trim();
	return /^[0-9a-f]{7,40}$/.test(value)
		? value
		: refuse(
				FAILED,
				`${verb}: --sha "${raw}" is not 7-40 lowercase hex — an empty or malformed SHA is a usage error, never a pattern that matches every head.`,
			);
};

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
export const prefixMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);
