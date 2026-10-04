/**
 * `guard pitch-guard check [--issue N]` — the board read behind the pitched-or-unpickable decision.
 *
 * Three reads compose one candidate, and the order is the cost control: the label-narrowed sweep
 * shortlists, each shortlisted issue is then re-read singly because the list endpoint omits the
 * parent link, and only then are its comments and their authors' permissions resolved.
 *
 * The ACL resolution is fail-closed at the boundary: a permission that cannot be read
 * resolves NOT authorized, so an unverifiable approval stops counting rather than passing.
 *
 * The whole decision lives in `./pitch.ts`; this file resolves the repo, reads, and emits.
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {CONFIG_PATH} from "../config/document.ts";
import {appetiteSizesKey} from "../config/keys/appetite-sizes.ts";
import {readKey} from "../config/read-key.ts";
import {
	getIssue,
	type IssueRecord,
	listComments,
	openIssuesWithLabelRecords,
	resolveRepo,
} from "../io/issues.ts";
import {permissionFor} from "../io/pulls.ts";
import type {BetRow as TableBetRow} from "../table/bet-rows.ts";
import {readBetRows} from "../table/bet-rows-read.ts";
import type {TableRead} from "../table/bets-read.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {PRESENT, universeOf} from "./label-universe.ts";
import {
	type BetRow,
	type BetTable,
	type Candidate,
	type Comment,
	describeBetTable,
	type HeadAppetite,
	headAppetiteOf,
	isLaneEntering,
	judge,
	LANE_ENTERING_TYPES,
	SCOPE_LABELS,
	type Scope,
	TRIAGED_LABEL,
	toGuardVerdict,
	VERB,
} from "./pitch.ts";
import {emitVerdict, type GuardVerdict, unknown} from "./verdict.ts";

type Requirements = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

/** The table read behind the bet arm. */
export type BetRowsReader = (
	cwd: string,
	repo: string,
) => Effect.Effect<TableRead<ReadonlyArray<TableBetRow>>, never, Requirements>;

export interface PitchGuardOptions {
	/** One issue to scope the scan to, or `null` for the whole open lane-entering backlog. */
	readonly issue: number | null;
	readonly repo: string | null;
	/** Where `.fabrika.jsonc` is looked up, for the dollar amount each size names. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Where the table's `bet` rows come from; the shipped read unless a test hands in another. */
	readonly betRows?: BetRowsReader;
}

type Scan =
	| {readonly _tag: "Scanned"; readonly candidates: ReadonlyArray<Candidate>; readonly scope: Scope}
	| {readonly _tag: "Refused"; readonly verdict: GuardVerdict};

const refused = (report: string): Scan => ({_tag: "Refused", verdict: unknown(report)});

const WRITE_PLUS: ReadonlyArray<string> = ["admin", "maintain", "write"];

/** The trust root, fail-closed: anything but a proven `write+` reads as not authorized. */
const isWritePlus = (
	repo: string,
	login: string,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (login === "") return false;
		const permission = yield* permissionFor(repo, login);
		return permission._tag === "Present" && WRITE_PLUS.includes(permission.value.trim());
	});

/** The label-only pre-filter. It cannot see the parent link, so the core re-checks scope after. */
const looksLaneEntering = (record: IssueRecord): boolean =>
	record.labels.includes(TRIAGED_LABEL) &&
	record.labels.some((label) => LANE_ENTERING_TYPES.includes(label));

type Hydrated =
	| {readonly _tag: "Candidate"; readonly candidate: Candidate}
	| {readonly _tag: "Unreadable"; readonly reason: string};

const hydrate = (
	repo: string,
	record: IssueRecord,
): Effect.Effect<Hydrated, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const comments = yield* listComments(repo, record.number);
		if (comments._tag === "Failure") {
			return {
				_tag: "Unreadable",
				reason: `cannot read the comments on #${record.number}: ${comments.reason}`,
			};
		}
		const logins = [...new Set(comments.value.map((comment) => comment.author))];
		const authorized = new Map<string, boolean>();
		for (const login of logins) authorized.set(login, yield* isWritePlus(repo, login));
		const resolved: ReadonlyArray<Comment> = comments.value.map((comment) => ({
			author: comment.author,
			authorized: authorized.get(comment.author) ?? false,
			body: comment.body,
		}));
		return {
			_tag: "Candidate",
			candidate: {
				number: record.number,
				title: record.title,
				labels: record.labels,
				hasParent: record.parent._tag !== "None",
				body: record.body,
				comments: resolved,
			},
		};
	});

/** Re-read one shortlisted issue singly: the list endpoint omits the parent link scope turns on. */
const readOne = (
	repo: string,
	number: number,
): Effect.Effect<Hydrated, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getIssue(repo, number);
		if (found._tag === "Unknown") {
			return {_tag: "Unreadable", reason: `cannot read issue #${number}: ${found.reason}`};
		}
		if (found._tag === "Absent") {
			return {
				_tag: "Unreadable",
				reason: `issue #${number} was in the sweep and then did not exist — the board moved under the read`,
			};
		}
		return yield* hydrate(repo, found.value);
	});

const backlogScan = (
	repo: string,
): Effect.Effect<Scan, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const attempt = yield* openIssuesWithLabelRecords(repo, TRIAGED_LABEL);
		if (attempt._tag === "Failure") {
			return refused(
				`${VERB}: cannot read the open ${TRIAGED_LABEL} set in ${repo}: ${attempt.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
			);
		}
		const candidates: Array<Candidate> = [];
		for (const record of attempt.value.filter(looksLaneEntering)) {
			const one = yield* readOne(repo, record.number);
			if (one._tag === "Unreadable") {
				return refused(
					`${VERB}: ${one.reason} — part of the lane-entering set went unread, so the verdict is UNKNOWN, never clean.`,
				);
			}
			candidates.push(one.candidate);
		}
		return {_tag: "Scanned", candidates, scope: {_tag: "backlog"}};
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
		// `repos/<repo>/issues/<n>` answers for pull requests too, and a pitch is a property of a bet at
		// intake — a PR read as an issue would be judged against a contract it was never in scope for.
		if (found.value.isPullRequest) {
			return refused(
				`${VERB}: #${number} in ${repo} is a pull request, not an issue — a pitch binds at intake and never at merge, so the verdict is UNKNOWN, never clean.`,
			);
		}
		if (!looksLaneEntering(found.value)) {
			const universe = yield* universeOf(repo, SCOPE_LABELS);
			return universe === null
				? refused(
						`${VERB}: issue #${number} is not lane-entering work, and the label set of ${repo} could not be read to tell that from a repo that never defined the scoping labels — the verdict is UNKNOWN, never clean.`,
					)
				: {_tag: "Scanned", candidates: [], scope: {_tag: "issue", number, universe}};
		}
		const one = yield* hydrate(repo, found.value);
		return one._tag === "Unreadable"
			? refused(`${VERB}: ${one.reason} — the verdict is UNKNOWN, never clean.`)
			: {
					_tag: "Scanned",
					candidates: [one.candidate],
					scope: {_tag: "issue", number, universe: PRESENT},
				};
	});

/** The appetite a row's head states in its own body; a read that fails holds the row to nothing. */
const readHeadAppetite = (
	repo: string,
	head: number,
): Effect.Effect<HeadAppetite, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getIssue(repo, head);
		if (found._tag === "Unknown") return {_tag: "unread", reason: found.reason};
		if (found._tag === "Absent") return {_tag: "unread", reason: `#${head} does not exist`};
		return headAppetiteOf(found.value.body);
	});

/**
 * The bet arm's table, each Stage setter resolved at the ACL and each head's stated appetite read
 * off its body. Any table that does not read is `unread` with its reason: it approves nothing, and
 * the comments decide exactly as before.
 */
const readBetTable = (
	read: BetRowsReader,
	cwd: string,
	repo: string,
): Effect.Effect<BetTable, never, Requirements> =>
	Effect.gen(function* () {
		const table = yield* read(cwd, repo);
		if (table._tag === "NoTable") return {_tag: "unread", reason: table.note};
		if (table._tag === "Unknown") return {_tag: "unread", reason: table.reason};
		const authorized = new Map<string, boolean>();
		const rows: BetRow[] = [];
		for (const row of table.value) {
			const setter = row.setter;
			if (setter !== null && !authorized.has(setter)) {
				authorized.set(setter, yield* isWritePlus(repo, setter));
			}
			rows.push({
				head: row.head,
				covers: row.covers,
				size: row.size,
				headAppetite: yield* readHeadAppetite(repo, row.head),
				setter,
				authorized: setter !== null && authorized.get(setter) === true,
			});
		}
		return {_tag: "read", source: `${table.source.owner}#${table.source.number}`, rows};
	});

/** The bet arm's line leads the diagnostics, whatever the verdict. */
const withBetNote = (outcome: VerbOutcome, table: BetTable): VerbOutcome => ({
	...outcome,
	stderr: [describeBetTable(table), ...outcome.stderr],
});

export const runPitchGuard = (
	options: PitchGuardOptions,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		if (options.issue !== null && !(Number.isInteger(options.issue) && options.issue > 0)) {
			return refuse(FAILED, `${VERB}: ${options.issue} is not an issue number.`);
		}
		const sizes = yield* readKey(options.cwd, appetiteSizesKey);
		if (sizes._tag === "Refused") {
			return emitVerdict(
				unknown(
					`${VERB}: ${CONFIG_PATH} is refused — ${sizes.reason.replace(/\.$/, "")}, so what each pitch size is worth is unread and the verdict is UNKNOWN, never clean.`,
				),
				options.env,
			);
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
		if (scan._tag === "Refused") return emitVerdict(scan.verdict, options.env);
		if (!scan.candidates.some(isLaneEntering)) {
			return emitVerdict(
				toGuardVerdict(judge(scan.candidates, scan.scope), sizes.value),
				options.env,
			);
		}
		const table = yield* readBetTable(options.betRows ?? readBetRows, options.cwd, target.value);
		return withBetNote(
			emitVerdict(
				toGuardVerdict(judge(scan.candidates, scan.scope, table), sizes.value),
				options.env,
			),
			table,
		);
	});
