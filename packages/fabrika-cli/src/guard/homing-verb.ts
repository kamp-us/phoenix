/**
 * `guard homing-guard check [--issue N]` — the board read behind the home-xor-exempt decision.
 *
 * Two scopes, and the difference is what an empty one means. The bare sweep reads the whole open set
 * under the board's triaged status and reds on an empty one, like every guard here; `--issue N` is
 * the per-issue seam check a triage sweep runs right after it stamps the label, and an issue that is
 * simply not triaged is a pass over a scan of one.
 *
 * The `--issue` fork reads the repository's label set too, but only when the issue turns out not to
 * be triaged: without that read an empty result cannot be told from a repo that never defined its
 * triaged label, and the seam guard would report clean forever having checked nothing.
 *
 * The triaged status and the standing lanes arrive as the delivery layer's board read, refusal
 * included. A board nobody could read cannot say which label scopes the scan — the shipped name
 * would scope a renamed board to nothing and pass — nor which labels exempt an issue, so it is
 * UNKNOWN here and never the shipped names or "no lanes".
 *
 * The whole decision lives in `./homing.ts`; this file resolves the repo, reads, and emits.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {BoardRead} from "../config/resolve-board.ts";
import {getIssue, type IssueRecord, openIssuesWithLabelRecords, resolveRepo} from "../io/issues.ts";
import {BOARD_SUBJECT, refusalReason} from "../status/repo-board.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {judge, type Scope, type TriagedIssue, toGuardVerdict, VERB} from "./homing.ts";
import {PRESENT, universeOf} from "./label-universe.ts";
import {emitVerdict, type GuardVerdict, unknown} from "./verdict.ts";

export interface HomingGuardOptions {
	/** One issue to scope the scan to, or `null` for the whole open triaged backlog. */
	readonly issue: number | null;
	/** The board this repo declares — its triaged status and standing lanes — read by the adapter. */
	readonly board: BoardRead;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** What a scan produced: the set to judge with its scope, or the verdict the read already is. */
type Scan =
	| {readonly _tag: "Scanned"; readonly issues: ReadonlyArray<TriagedIssue>; readonly scope: Scope}
	| {readonly _tag: "Refused"; readonly verdict: GuardVerdict};

const refused = (report: string): Scan => ({_tag: "Refused", verdict: unknown(report)});

/** One read issue as the decision reads it — shared with `triage sweep-homes`, so both judge one shape. */
export const toTriaged = (record: IssueRecord): TriagedIssue => ({
	number: record.number,
	title: record.title,
	milestone: record.milestone,
	labels: record.labels,
});

const backlogScan = (
	repo: string,
	triaged: string,
): Effect.Effect<Scan, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const attempt = yield* openIssuesWithLabelRecords(repo, triaged);
		return attempt._tag === "Failure"
			? refused(
					`${VERB}: cannot read the open ${triaged} set in ${repo}: ${attempt.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
				)
			: {
					_tag: "Scanned",
					issues: attempt.value.map(toTriaged),
					scope: {_tag: "backlog", triaged},
				};
	});

const issueScan = (
	repo: string,
	triaged: string,
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
		// as an issue it would red as un-homed every time.
		if (found.value.isPullRequest) {
			return refused(
				`${VERB}: #${number} in ${repo} is a pull request, not an issue — home-xor-exempt binds on triaged issues, so the verdict is UNKNOWN, never clean.`,
			);
		}
		const one = toTriaged(found.value);
		if (one.labels.includes(triaged)) {
			return {
				_tag: "Scanned",
				issues: [one],
				scope: {_tag: "issue", triaged, number, universe: PRESENT},
			};
		}
		// Read only here: this is the one fork where an empty scope is ambiguous.
		const universe = yield* universeOf(repo, [triaged]);
		return universe === null
			? refused(
					`${VERB}: issue #${number} is not ${triaged}, and the label set of ${repo} could not be read to tell that from a repo that never defined it — the verdict is UNKNOWN, never clean.`,
				)
			: {_tag: "Scanned", issues: [], scope: {_tag: "issue", triaged, number, universe}};
	});

export const runHomingGuard = (
	options: HomingGuardOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (options.issue !== null && !(Number.isInteger(options.issue) && options.issue > 0)) {
			return refuse(FAILED, `${VERB}: ${options.issue} is not an issue number.`);
		}
		const board = options.board;
		if (board._tag === "Refused") {
			return emitVerdict(
				unknown(
					`${VERB}: cannot read ${BOARD_SUBJECT}: ${refusalReason(board)} — which label is the triaged status and which labels exempt an issue are unread, never the shipped names. Nothing was scanned, so the verdict is UNKNOWN.`,
				),
				options.env,
			);
		}
		const {statuses, standingLanes} = board.resolved.board;
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
			? backlogScan(target.value, statuses.triaged)
			: issueScan(target.value, statuses.triaged, options.issue);
		return emitVerdict(
			scan._tag === "Refused"
				? scan.verdict
				: toGuardVerdict(judge(scan.issues, standingLanes, scan.scope)),
			options.env,
		);
	});
