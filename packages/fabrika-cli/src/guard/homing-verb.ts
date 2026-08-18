/**
 * `guard homing-guard check [--issue N]` — the board read behind the home-xor-exempt decision.
 *
 * Two scopes, and the difference is what an empty one means. The bare sweep reads the whole open
 * `status:triaged` set and reds on an empty one (ADR 0092); `--issue N` is the per-issue seam check
 * a triage sweep runs right after it stamps the label, and an issue that is simply not triaged is a
 * pass over a scan of one.
 *
 * The `--issue` fork reads the repository's label set too, but only when the issue turns out not to
 * be triaged: without that read an empty result cannot be told from a repo that never defined
 * `status:triaged`, and the seam guard would report clean forever having checked nothing (#4272).
 *
 * The whole decision lives in `./homing.ts`; this file resolves the repo, reads, and emits.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	getIssue,
	type IssueRecord,
	listLabels,
	openIssuesWithLabelRecords,
	resolveRepo,
} from "../io/issues.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	judge,
	type LabelUniverse,
	PRESENT,
	type Scope,
	TRIAGED_LABEL,
	type TriagedIssue,
	toGuardVerdict,
	VERB,
} from "./homing.ts";
import {emitVerdict, type GuardVerdict, unknown} from "./verdict.ts";

export interface HomingGuardOptions {
	/** One issue to scope the scan to, or `null` for the whole open `status:triaged` backlog. */
	readonly issue: number | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** What a scan produced: the set to judge with its scope, or the verdict the read already is. */
type Scan =
	| {readonly _tag: "Scanned"; readonly issues: ReadonlyArray<TriagedIssue>; readonly scope: Scope}
	| {readonly _tag: "Refused"; readonly verdict: GuardVerdict};

const refused = (report: string): Scan => ({_tag: "Refused", verdict: unknown(report)});

const toTriaged = (record: IssueRecord): TriagedIssue => ({
	number: record.number,
	title: record.title,
	milestone: record.milestone,
	labels: record.labels,
});

const backlogScan = (
	repo: string,
): Effect.Effect<Scan, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const attempt = yield* openIssuesWithLabelRecords(repo, TRIAGED_LABEL);
		return attempt._tag === "Failure"
			? refused(
					`${VERB}: cannot read the open ${TRIAGED_LABEL} set in ${repo}: ${attempt.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
				)
			: {
					_tag: "Scanned",
					issues: attempt.value.map(toTriaged),
					scope: {_tag: "backlog"},
				};
	});

/** The label universe, read only when it is the fact that disambiguates an empty issue scope. */
const universeOf = (
	repo: string,
): Effect.Effect<LabelUniverse | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const attempt = yield* listLabels(repo);
		if (attempt._tag === "Failure") return null;
		return attempt.value.includes(TRIAGED_LABEL)
			? PRESENT
			: {_tag: "absent", missing: [TRIAGED_LABEL]};
	});

const issueScan = (
	repo: string,
	number: number,
): Effect.Effect<Scan, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getIssue(repo, number);
		if (found._tag === "Unknown") {
			return refused(
				`${VERB}: cannot read issue #${number} in ${repo}: ${found.reason} — the verdict is UNKNOWN, never clean.`,
			);
		}
		if (found._tag === "Absent") {
			return refused(
				`${VERB}: issue #${number} does not exist in ${repo} — there is nothing to scan, so the verdict is UNKNOWN, never clean.`,
			);
		}
		// `repos/<repo>/issues/<n>` answers for pull requests too, and a PR carries no milestone — read
		// as an issue it would red as un-homed every time (#5562).
		if (found.value.isPullRequest) {
			return refused(
				`${VERB}: #${number} in ${repo} is a pull request, not an issue — home-xor-exempt binds on triaged issues, so the verdict is UNKNOWN, never clean.`,
			);
		}
		const one = toTriaged(found.value);
		if (one.labels.includes(TRIAGED_LABEL)) {
			return {_tag: "Scanned", issues: [one], scope: {_tag: "issue", number, universe: PRESENT}};
		}
		const universe = yield* universeOf(repo);
		return universe === null
			? refused(
					`${VERB}: issue #${number} is not ${TRIAGED_LABEL}, and the label set of ${repo} could not be read to tell that from a repo that never defined it (#4272) — the verdict is UNKNOWN, never clean.`,
				)
			: {_tag: "Scanned", issues: [], scope: {_tag: "issue", number, universe}};
	});

export const runHomingGuard = (
	options: HomingGuardOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (options.issue !== null && !(Number.isInteger(options.issue) && options.issue > 0)) {
			return refuse(FAILED, `${VERB}: ${options.issue} is not an issue number.`);
		}
		const target = yield* resolveRepo(options.repo, options.env);
		if (target._tag === "Failure") {
			return emitVerdict(
				unknown(
					`${VERB}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves. Nothing was scanned, so the verdict is UNKNOWN.`,
				),
				options.env,
			);
		}
		const scan = yield* options.issue === null
			? backlogScan(target.value)
			: issueScan(target.value, options.issue);
		return emitVerdict(
			scan._tag === "Refused" ? scan.verdict : toGuardVerdict(judge(scan.issues, scan.scope)),
			options.env,
		);
	});
