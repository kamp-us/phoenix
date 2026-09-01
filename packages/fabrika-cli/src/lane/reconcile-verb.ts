/**
 * `lane reconcile` — find every lane whose recorded merge closure disagrees with the board, and
 * append the line that corrects it.
 *
 * The third verb in the group that reads across lanes rather than into one, and for the same reason
 * the other two do: the question is a sweep. ADR 0343's `partial` payload only ever rode lines
 * written after it existed, so the population is every lane shipped before it — nobody has counted
 * them and no read into one lane could (#7433).
 *
 * It is not `lane migrate`'s business even though the shapes rhyme. That sweep answers whether a
 * lane's machine is the committed template and writes `workflow.json` **only where the swap is
 * provably inert**, which is the guarantee ADR 0313 rests on; appending an event is the opposite of
 * inert. Two questions, two writes, two verbs.
 *
 * Every lane is judged on its own — an unreadable one is a row, never the end of the sweep — and the
 * board is asked only about a lane whose log already nominates a correctable line, so a clean sweep
 * costs no requests. `--check` is the same sweep with the append withheld.
 */
import {Effect, FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {appendText, exists, readDir, readFile} from "../io/fs.ts";
import {resolveRepo} from "../io/issues.ts";
import {getPullRequest} from "../io/pulls.ts";
import {issueRefsOf} from "../review/classes.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE} from "./codes.ts";
import {deriveStatus, foldLog, type LogEntry, standingCauses} from "./fold.ts";
import {CHORE_PREFIX} from "./key.ts";
import {compileText} from "./machine.ts";
import {graftContext} from "./migrate.ts";
import {nominatePulls} from "./nominate.ts";
import {type Closure, traceClosure} from "./prove.ts";
import {correctionEntry, declaresClosureGuard, findMisroute, pullNumberIn} from "./reconcile.ts";
import {DEFAULT_CHORES_ROOT, loadLane} from "./store.ts";

const VERB = "fabrika lane reconcile";

export type ClosureRead =
	| {readonly _tag: "Read"; readonly closure: Closure}
	/** The board did not answer. Never read as `Closes` — that is the fold #7433 exists to stop. */
	| {readonly _tag: "Unknown"; readonly reason: string};

export type ClosureReader<R> = (
	issue: number,
	pr: string | null,
) => Effect.Effect<ClosureRead, never, R>;

/**
 * The board-backed reader: what the merge behind this terminal actually closed, judged by
 * `traceClosure` — `lane prove`'s own ship-stage read (ADR 0343).
 *
 * **It reads the PR the recorded line already names, and nominates nothing.** That is not a shortcut
 * past the group's one nominator but a different question: a nominator answers "which PR is this
 * issue's", and the terminal being corrected already answered it in writing. Nominating here would
 * also answer wrongly — a MERGED `Part of #N` is invisible to both nomination reads, since the
 * closing edge is built from closing keywords and the search half is `is:open`, so the union finds
 * nothing for exactly the case this verb exists to catch (#7433).
 *
 * A line naming no PR falls back to the nominator at `open-or-merged`, which is the best answer
 * available without evidence on the line. Either way an unreadable answer is `Unknown` and never
 * `Closes` — reading a failed read as a closing merge is the permissive fold this verb undoes.
 */
export const closureReader = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): ClosureReader<ChildProcessSpawner.ChildProcessSpawner> => {
	let resolved: string | null = null;
	return (issue, pr) =>
		Effect.gen(function* () {
			if (resolved === null) {
				const attempt = yield* resolveRepo(repo, env);
				if (attempt._tag === "Failure") {
					return {
						_tag: "Unknown" as const,
						reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
					};
				}
				resolved = attempt.value;
			}
			const number = pullNumberIn(pr);
			if (number === null) {
				const nominated = yield* nominatePulls(resolved, issue, "open-or-merged");
				return nominated._tag === "Unreadable"
					? {_tag: "Unknown" as const, reason: `cannot read ${nominated.what}: ${nominated.reason}`}
					: {_tag: "Read" as const, closure: traceClosure(issue, nominated.pulls)};
			}
			const pull = yield* getPullRequest(resolved, number);
			if (pull._tag === "Unknown") {
				return {_tag: "Unknown" as const, reason: `cannot read PR #${number}: ${pull.reason}`};
			}
			if (pull._tag === "Absent") {
				return {
					_tag: "Unknown" as const,
					reason: `the line names PR #${number}, which is not there`,
				};
			}
			const refs = issueRefsOf(pull.value.body);
			return {
				_tag: "Read" as const,
				closure: traceClosure(issue, [
					{
						number: pull.value.number,
						open: pull.value.state === "open",
						merged: pull.value.merged,
						linkedIssues: refs.numbers,
						linkKind: refs.kind,
					},
				]),
			};
		});
};

/**
 * One root to sweep, bound to the committed templates its lanes may have booted from — the shape
 * `lane migrate` established, and needed here for the same reason: the lane's own document `id`
 * picks among them, never the root's position.
 */
export interface ReconcileRoot {
	readonly root: string;
	readonly templatePaths: ReadonlyArray<string>;
}

export interface ReconcileOptions<R = never> {
	readonly roots: ReadonlyArray<ReconcileRoot>;
	/** Judge every lane and report, appending nothing. */
	readonly check: boolean;
	readonly closures: ClosureReader<R>;
	readonly now: string;
}

type Verdict =
	| "current"
	| "corrected"
	| "misrouted"
	| "closes"
	| "unmigrated"
	| "unknown"
	| "unreadable"
	| "unappended";

const VERDICTS: ReadonlyArray<Verdict> = [
	"current",
	"corrected",
	"misrouted",
	"closes",
	"unmigrated",
	"unknown",
	"unreadable",
	"unappended",
];

interface LaneRow {
	readonly key: string;
	readonly root: string;
	readonly verdict: Verdict;
	/** Why this lane could not be corrected, or why it needed no correcting; absent on `current`. */
	readonly reason?: string;
	/** The recorded line the correction supersedes, and the PR it named; absent unless one was found. */
	readonly corrects?: {
		readonly task: string;
		readonly at: string;
		readonly state: string;
		readonly pr: string | null;
	};
	/** The merged PRs whose `Part of #N` proves the closure partial. */
	readonly prs?: ReadonlyArray<number>;
	/** What the lane folds to now, and what it would fold to corrected. */
	readonly from?: string;
	readonly to?: string;
}

const keyOf = (root: string, name: string): string =>
	root.endsWith(DEFAULT_CHORES_ROOT) ? `${CHORE_PREFIX}${name}` : name;

const issueOf = (root: string, name: string): number | null => {
	if (root.endsWith(DEFAULT_CHORES_ROOT) || !/^\d+$/.test(name)) return null;
	return Number(name);
};

/** The lane's folded state as one printable value, so a row shows the move it would make. */
const foldedValue = (
	lane: Parameters<typeof foldLog>[0],
	entries: ReadonlyArray<LogEntry>,
): string => {
	const folded = foldLog(lane, entries);
	if (folded._tag === "Unreplayable") return folded.defects.join("; ");
	const status = deriveStatus(lane, folded.states, standingCauses(entries));
	return typeof status.stateValue === "string"
		? status.stateValue
		: JSON.stringify(status.stateValue);
};

/**
 * Whether the committed template this lane booted from declares the merge-closure guard its own
 * machine does not — the difference between a lane with nothing to correct and one whose machine
 * cannot express the question yet.
 *
 * `false` on a lane no committed template grafts onto: an emitted epic machine is nobody's template
 * to be brought up to (`lane migrate`'s `generated` verdict), and an epic tail declares no partial
 * arm by design (ADR 0343), so neither is stale for want of one.
 */
const templateWouldDeclareGuard = (
	templateTexts: ReadonlyArray<string>,
	laneText: string,
): boolean => {
	const graft = templateTexts
		.map((text) => graftContext(text, laneText))
		.find((candidate) => candidate._tag === "Grafted");
	if (graft === undefined) return false;
	const compiled = compileText(graft.text);
	return compiled._tag === "Compiled" && declaresClosureGuard(compiled.lane);
};

const reconcileLane = <R>(
	root: string,
	name: string,
	templateTexts: ReadonlyArray<string>,
	options: ReconcileOptions<R>,
): Effect.Effect<LaneRow | null, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const key = keyOf(root, name);
		const unreadable = (reason: string): LaneRow => ({key, root, verdict: "unreadable", reason});
		// Distinct from `unreadable` because only this one is caused by the sweep: a ledger that was
		// already broken is a row a reader routes on, while an append this run tried and could not land
		// leaves whether the lane needs correcting UNKNOWN, and that is what refuses.
		const unappended = (reason: string): LaneRow => ({key, root, verdict: "unappended", reason});
		const loaded = yield* loadLane({root, lane: name});
		// An entry with no workflow.json is not a lane, and reporting a scratch directory as one would
		// put noise in front of every real row.
		if (loaded._tag === "Absent") return null;
		if (loaded._tag === "Unreadable") {
			return unreadable(`cannot read ${loaded.path}: ${loaded.reason}`);
		}
		if (loaded._tag === "Malformed") {
			return unreadable(`${loaded.path} is not the shape: ${loaded.defects.join("; ")}`);
		}

		const misroute = findMisroute(loaded.lane, loaded.entries);
		if (misroute._tag === "Unreplayable") {
			return unreadable(`${loaded.logPath} does not replay: ${misroute.defects.join("; ")}`);
		}
		if (misroute._tag === "Settled") {
			if (declaresClosureGuard(loaded.lane)) return {key, root, verdict: "current"};
			// The `Settled` answer is ambiguous here and only the template resolves it: this lane may
			// have nothing to correct, or its machine may predate the guard entirely, which is every
			// lane booted before ADR 0343 shipped — 6980 and 7382 among them (#7433).
			const workflowPath = path.join(loaded.dir, "workflow.json");
			const onDisk = yield* Effect.result(readFile(workflowPath));
			if (Result.isFailure(onDisk)) {
				return unreadable(`cannot re-read ${workflowPath}: ${onDisk.failure.reason}`);
			}
			return templateWouldDeclareGuard(templateTexts, onDisk.success)
				? {
						key,
						root,
						verdict: "unmigrated",
						reason: `${workflowPath} declares no merge-closure guard and the committed template does, so nothing here can judge this lane's merge — run \`fabrika lane migrate\`, then re-run this sweep`,
					}
				: {key, root, verdict: "current"};
		}

		const corrects = {
			task: misroute.task,
			at: misroute.at,
			state: misroute.state,
			pr: misroute.pr,
		};
		const issue = issueOf(root, name);
		if (issue === null) {
			return {
				key,
				root,
				verdict: "unknown",
				corrects,
				reason: "this lane drives no issue, so no board read can say what its merge closed",
			};
		}
		const read = yield* options.closures(issue, misroute.pr);
		if (read._tag === "Unknown") {
			return {key, root, verdict: "unknown", corrects, reason: read.reason};
		}
		if (read.closure._tag === "Closes") {
			return {key, root, verdict: "closes", corrects, reason: read.closure.why};
		}

		const prs = read.closure.prs;
		const entry = correctionEntry(misroute.task, misroute.at, options.now);
		const from = foldedValue(loaded.lane, loaded.entries);
		const to = foldedValue(loaded.lane, [...loaded.entries, entry]);
		if (options.check) {
			return {key, root, verdict: "misrouted", corrects, prs, from, to};
		}

		return yield* withLedgerLock(
			{fs, path, dir: loaded.dir, verb: VERB},
			Effect.gen(function* () {
				// Re-read under the lock and re-derive: between the judgement above and this append a
				// concurrent writer may have moved the lane, and appending against the older read would
				// correct a line that is no longer the one standing.
				const fresh = yield* loadLane({root, lane: name});
				if (fresh._tag !== "Loaded") {
					return unappended(`${loaded.logPath} became unreadable before the append`);
				}
				const again = findMisroute(fresh.lane, fresh.entries);
				if (again._tag !== "Correctable" || again.at !== misroute.at) {
					return {
						key,
						root,
						verdict: "unknown" as const,
						corrects,
						reason: "the lane moved between the judgement and the append — re-run to re-judge it",
					};
				}
				const wrote = yield* Effect.result(appendText(fresh.logPath, `${JSON.stringify(entry)}\n`));
				return Result.isFailure(wrote)
					? unappended(`the append to ${fresh.logPath} did not land: ${wrote.failure.reason}`)
					: {key, root, verdict: "corrected" as const, corrects, prs, from, to};
			}),
			(lockDir) => unappended(lockedRefusal(VERB, lockDir)),
		);
	});

export const runReconcile = <R = never>(
	options: ReconcileOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const lanes: LaneRow[] = [];
		const scanned: Array<{root: string; present: boolean; lanes: number}> = [];
		for (const {root, templatePaths} of options.roots) {
			const templateTexts: string[] = [];
			for (const templatePath of templatePaths) {
				const template = yield* Effect.result(readFile(templatePath));
				if (Result.isFailure(template)) {
					return refuse(
						LANE_UNREADABLE,
						`${VERB}: cannot read the committed template at ${templatePath}: ${template.failure.reason} — nothing was reconciled.`,
					);
				}
				templateTexts.push(template.success);
			}
			const probe = yield* Effect.result(exists(root));
			if (Result.isFailure(probe)) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot establish whether ${root} is there: ${probe.failure.reason} — the lane set is UNKNOWN, never empty.`,
				);
			}
			if (!probe.success) {
				scanned.push({root, present: false, lanes: 0});
				continue;
			}
			const names = yield* Effect.result(readDir(root));
			if (Result.isFailure(names)) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot list ${root}: ${names.failure.reason} — the lane set is UNKNOWN, never empty.`,
				);
			}
			let found = 0;
			for (const name of [...names.success].sort()) {
				const row = yield* reconcileLane(root, name, templateTexts, options);
				if (row === null) continue;
				found += 1;
				lanes.push(row);
			}
			scanned.push({root, present: true, lanes: found});
		}

		const summary = Object.fromEntries(
			VERDICTS.map((verdict) => [verdict, lanes.filter((row) => row.verdict === verdict).length]),
		);
		const named = (verdict: Verdict) => lanes.filter((row) => row.verdict === verdict);
		const unappended = named("unappended");
		const stderr = [
			`${VERB}: swept ${scanned.map((entry) => `${entry.root} (${entry.present ? `${entry.lanes} lane(s)` : "absent"})`).join(", ")}${options.check ? " — check only, nothing appended" : ""}.`,
			...[...named("unmigrated"), ...named("unknown"), ...named("unreadable"), ...unappended].map(
				(row) => `${VERB}: ${row.key}: ${row.reason ?? row.verdict}`,
			),
		];
		// An append this run tried and could not land is the one row that may not sit on stdout beside
		// the ones that did: whether that lane still needs correcting is UNKNOWN, and a green sweep
		// listing it would read as swept. A ledger already broken before the sweep is a row, not this —
		// nothing here caused it and nothing here can fix it.
		if (unappended.length > 0) {
			const corrected = named("corrected");
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: ${unappended.length} lane(s) could not be appended to, so whether they still need a correction is UNKNOWN: ${unappended.map((row) => row.key).join(", ")}. ${corrected.length} other lane(s) were corrected: ${corrected.map((row) => row.key).join(", ") || "none"}. Fix each named lane and re-run to sweep the rest.`,
				stderr,
			);
		}
		return answer(JSON.stringify({check: options.check, scanned, summary, lanes}, null, 2), stderr);
	});
