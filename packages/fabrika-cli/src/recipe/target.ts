/**
 * The preconditions both recipe verbs run before they act: resolve the repo, resolve the pull
 * request, and keep *proven absent* apart from *unreadable*.
 *
 * It lives here rather than in each verb because that split is the group's posture, and two copies
 * of it are two chances to fold the two facts together — which is how "I could not read the PR"
 * comes to authorise a rerun.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveRepo} from "../io/issues.ts";
import {getPullRequest, type PullRecord} from "../io/pulls.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, TARGET_ABSENT} from "./codes.ts";

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

export type PullTarget =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Pull"; readonly pull: PullRecord};

/** One open pull request, or the refusal. Absent and closed are the same fact: nothing to act on. */
export const openPull = (
	verb: string,
	repo: string,
	pr: number,
	unknownMessage: (reason: string) => string,
): Effect.Effect<PullTarget, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getPullRequest(repo, pr);
		if (found._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(PRECONDITION_UNKNOWN, unknownMessage(found.reason)),
			};
		}
		if (found._tag === "Absent" || found.value.state !== "open") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(TARGET_ABSENT, `${verb}: PR #${pr} is proven absent or closed.`),
			};
		}
		return {_tag: "Pull" as const, pull: found.value};
	});
