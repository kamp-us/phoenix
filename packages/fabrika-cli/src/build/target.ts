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
import {
	type Admission,
	type Dispatch,
	dispatchMilestones,
	type IssueFacts,
	NOT_REPAIR,
	noServedIssue,
	type RepairClaim,
	repairClaimOf,
	scopeSubjectOf,
	unknownAdmission,
} from "./scope-admission.ts";

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

/**
 * The record the admission test runs over, resolved from the target the operator named.
 *
 * `Refused` carries an {@link Admission} rather than a seated outcome so the claim seam applies the
 * one override rule it already has — a resolution refusal is overridable exactly like a scope one,
 * and an unreadable served issue is UNKNOWN and so is not.
 */
export type AdmissionSubject =
	| {
			readonly _tag: "Judged";
			readonly facts: IssueFacts;
			/** What the fence judged, when that is not the named target itself. */
			readonly note: string | null;
			/**
			 * Whether this claim repairs an open PR — derived here, the one place that proves it.
			 *
			 * The caller reached this through {@link openIssue}, which refuses a closed target, so a
			 * resolved served issue means an **open** PR serves it (#5914).
			 */
			readonly repair: RepairClaim;
	  }
	| {readonly _tag: "Refused"; readonly admission: Admission};

/**
 * Resolve a claim target to the record whose home and audience the fence judges.
 *
 * An issue judges itself. A pull request judges the issue its lane serves (#5562). The resolution
 * runs whether or not a campaign is active, because the audience axis reads the served issue either
 * way; only the *scope* refusal is gated on an active campaign, so an **unresolvable** PR falls back
 * to its own record while the fence is inert instead of refusing at `20`. A served issue that cannot be
 * READ is UNKNOWN at either setting — `11`, and outside the overridable set, because a fence that
 * could not read its input has proven nothing.
 *
 * Resolving the subject is also what proves the {@link RepairClaim}: only a PR's path reaches a
 * served issue, so this is the one place that can answer "is an open PR already in flight here".
 */
export const resolveAdmissionSubject = (
	verb: string,
	repo: string,
	dispatch: Dispatch,
	target: IssueRecord,
): Effect.Effect<AdmissionSubject, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const own = {_tag: "Judged" as const, facts: target, note: null, repair: NOT_REPAIR};
		const subject = scopeSubjectOf(target);
		if (subject._tag === "Own") return own;
		const unresolved = (reason: string): AdmissionSubject =>
			dispatch._tag === "Active"
				? {
						_tag: "Refused" as const,
						admission: noServedIssue(target.number, dispatchMilestones(dispatch), reason),
					}
				: own;
		if (subject._tag === "Unserved") {
			return unresolved('carries neither a closing keyword nor "Part of #<n>" in its body');
		}
		const served = yield* getIssue(repo, subject.number);
		if (served._tag === "Absent") {
			return unresolved(`names #${subject.number}, which is proven absent`);
		}
		if (served._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
				admission: unknownAdmission(
					`cannot read #${subject.number}, the issue PR #${target.number} serves: ${served.reason}`,
				),
			};
		}
		return {
			_tag: "Judged" as const,
			facts: served.value,
			note: `${verb}: subject: PR #${target.number} serves #${subject.number} (${subject.kind}) — the admission test judges that issue, not the PR's own empty home.`,
			repair: repairClaimOf(target.number, served.value),
		};
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
