/**
 * `lane migrate` — bring every booted lane's machine up to the committed template, or say why not.
 *
 * The second verb in the group that reads across lanes rather than into one, and for the same reason
 * `lane stale` does: the question is a sweep. A machine change ships in one commit and the lanes
 * carrying the old copy are all of them, so migrating them one key at a time is a loop nobody would
 * run to the end.
 *
 * Every lane is judged before anything is written to it, and each is judged on its own: a lane that
 * cannot be migrated is a row, never the end of the sweep, because refusing the whole answer over
 * one lane would leave every other lane on a machine its driver is about to break. The write is the
 * last thing that happens on a lane and only on a `Preserved` verdict ({@link judgeMigration}).
 *
 * `--check` is the same sweep with the write withheld — what a driver runs to find out whether a
 * lane it is about to drive is stale, and what a release runs before merging a machine change.
 *
 * A lane key narrows which entries are swept and nothing else. The whole-root sweep is still what
 * runs unaddressed — it is the release-time shape — but a driver holding one lane is sanctioned to
 * write that lane's document and no other, and before the key existed the only write this verb
 * could perform reached every lane in the root, other drivers' live ones included. Narrowing is a
 * filter over the swept name set: each lane was already judged on its own, so a narrowed run reaches
 * exactly the same verdict for the lane it names as the sweep would have.
 *
 * Staleness is not the only way a lane can be wrong, and it was the only one this sweep could see:
 * a coder-template lane booted on an epic grafts cleanly and reads `current`. So each
 * issue-keyed lane is also judged against the board's answer for its issue ([`shape.ts`](shape.ts)),
 * and a proven mismatch is its own verdict ahead of every migration one. A lane booted for an epic's
 * CHILD is the second such verdict and a different fault: its template is right, so it grafted
 * cleanly and read `current`, and the wrongness is that the directory exists at all beside the
 * parent's. That one is reported and never acted on — retiring a ledger is an operator's act — so a
 * `duplicate` row leaves the exit code where it was. The reader is passed in, so a caller that hands
 * none still gets the wholly offline sweep.
 *
 * The judgement never widens what this verb writes: a mismatched or duplicate lane is skipped, and
 * the read can only turn a write into a skip. That is what keeps this verb's guarantee intact — it
 * writes only where the swap is provably inert.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import {exists, readDir, readFile, writeFile} from "../io/fs.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {LANE_ABSENT, LANE_UNREADABLE, MIGRATION_UNSAFE, SHAPE_MISMATCH} from "./codes.ts";
import type {ExpectationReader} from "./expectation.ts";
import {CHORE_PREFIX, rawKeyIssue} from "./key.ts";
import {compileText} from "./machine.ts";
import {type Drift, graftContext, judgeMigration, sameMachine} from "./migrate.ts";
import {judgeShape, originOf} from "./shape.ts";
import {DEFAULT_CHORES_ROOT, loadLane} from "./store.ts";

const VERB = "fabrika lane migrate";

/**
 * One root to sweep, bound to the committed templates its lanes may have booted from.
 *
 * A *list* rather than one path, and the lane's own document `id` picks among them: a relocated root
 * holds whatever lanes were opened into it, so binding a root to a single template made every chore
 * lane under a `--root` read as `generated` — a lying row, since it was booted from the other
 * committed template.
 */
export interface MigrateRoot {
	readonly root: string;
	/** The templates' on-disk paths — resolved by the adapter, so this verb joins no paths of its own. */
	readonly templatePaths: ReadonlyArray<string>;
}

export interface MigrateOptions<R = never> {
	readonly roots: ReadonlyArray<MigrateRoot>;
	/** Judge and report, write nothing. */
	readonly check: boolean;
	/**
	 * The one lane to judge, as {@link keyOf} renders it, or `null` for the whole-root sweep.
	 *
	 * Matched against the key a caller would type rather than the bare directory name, so a chore
	 * root's entry is addressed `chore:<name>` here exactly as it is at every other lane verb.
	 */
	readonly lane: string | null;
	/** The board reader the shape judgement needs, or `null` for the wholly offline sweep. */
	readonly expectations: ExpectationReader<R> | null;
}

type Verdict =
	| "current"
	| "migrated"
	| "stale"
	| "generated"
	| "mismatched"
	| "duplicate"
	| "unsafe"
	| "unreadable";

const VERDICTS: ReadonlyArray<Verdict> = [
	"current",
	"migrated",
	"stale",
	"generated",
	"mismatched",
	"duplicate",
	"unsafe",
	"unreadable",
];

/**
 * What the board said about the machine this lane runs.
 *
 * `unknown` is a seat rather than an absent field, for the reason every read in this protocol keeps
 * it: a sub-issue list that did not load says nothing about whether the machine fits, and reading it
 * as `matches` is the silence this verb exists to break.
 *
 * `duplicate` is the same silence one level over: a lane booted for an epic's child read `matches`
 * and grafted cleanly, so every sweep called a stray ledger healthy. It is not `mismatched` because
 * there is no template to swap — the lane is a directory to retire, and this verb only names it.
 */
type LaneShape =
	| {readonly state: "matches"}
	| {readonly state: "mismatched"; readonly reason: string}
	| {readonly state: "duplicate"; readonly parent: number | null; readonly reason: string}
	| {readonly state: "unknown"; readonly reason: string};

interface LaneRow {
	readonly key: string;
	readonly root: string;
	readonly verdict: Verdict;
	/** Why the sweep could not migrate this lane; absent on every lane it could act on. */
	readonly reason?: string;
	readonly drifts?: ReadonlyArray<Drift>;
	/** The machine-versus-board judgement; absent unless a reader was passed and this lane drives an issue. */
	readonly shape?: LaneShape;
}

/** How a caller addresses this lane: a chore root's entries are keyed `chore:<name>` (`key.ts`). */
const keyOf = (root: string, name: string): string =>
	// Suffix, never equality: the default root arrives absolute once it is derived off the owning
	// repository, so a relocated or derived root still keys its chores correctly.
	root.endsWith(DEFAULT_CHORES_ROOT) ? `${CHORE_PREFIX}${name}` : name;

/** The issue this lane drives, resolved through the one parse in `key.ts`; `null` when it drives none. */
const issueOf = (root: string, name: string): number | null => rawKeyIssue(keyOf(root, name));

const shapeOf = <R>(
	issue: number,
	documentText: string,
	expectations: ExpectationReader<R>,
): Effect.Effect<LaneShape, never, R> =>
	Effect.gen(function* () {
		const document = parseJson(documentText);
		const id = isRecord(document) && typeof document.id === "string" ? document.id : null;
		if (id === null) {
			return {state: "unknown", reason: "this lane's document has no `id` to read a machine off"};
		}
		const read = yield* expectations(issue);
		if (read._tag === "Unknown") return {state: "unknown", reason: read.reason};
		const judged = judgeShape(issue, originOf(id), read.expectation);
		if (judged._tag === "Matches") return {state: "matches"};
		return judged._tag === "Duplicate"
			? {state: "duplicate", parent: judged.parent, reason: judged.reason}
			: {state: "mismatched", reason: judged.reason};
	});

const migrateLane = <R>(
	root: string,
	name: string,
	templateTexts: ReadonlyArray<string>,
	check: boolean,
	expectations: ExpectationReader<R> | null,
): Effect.Effect<LaneRow | null, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const key = keyOf(root, name);
		const unreadable = (reason: string): LaneRow => ({key, root, verdict: "unreadable", reason});
		const loaded = yield* loadLane({root, lane: name});
		// An entry with no workflow.json is not a lane — a scratch directory under the root is not a
		// migration to report, and calling it one would put noise in front of every real one.
		if (loaded._tag === "Absent") return null;
		if (loaded._tag === "Unreadable") {
			return unreadable(`cannot read ${loaded.path}: ${loaded.reason}`);
		}
		if (loaded._tag === "Malformed") {
			return unreadable(`${loaded.path} is not the shape: ${loaded.defects.join("; ")}`);
		}

		const workflowPath = path.join(loaded.dir, "workflow.json");
		const onDisk = yield* Effect.result(readFile(workflowPath));
		if (Result.isFailure(onDisk)) {
			return unreadable(`cannot re-read ${workflowPath}: ${onDisk.failure.reason}`);
		}
		const issue = issueOf(root, name);
		const shape =
			expectations === null || issue === null
				? undefined
				: yield* shapeOf(issue, onDisk.success, expectations);
		// Every row past this point carries the judgement, including the ones it did not decide — an
		// `unknown` shape is what says the board was asked and did not answer, and dropping it would
		// leave a degraded sweep reading exactly like a clean one.
		const withShape = (row: LaneRow): LaneRow => (shape === undefined ? row : {...row, shape});
		// Ahead of every migration verdict: a lane running the wrong machine for its issue is not a
		// lane to bring up to a template, whatever the graft says.
		if (shape?.state === "mismatched") {
			return withShape({key, root, verdict: "mismatched", reason: shape.reason});
		}
		// Ahead of the graft for the opposite reason a mismatch is: this lane's template is right and
		// migrating it would be inert, but writing to a ledger an operator is being told to retire
		// hands them a directory this run just touched.
		if (shape?.state === "duplicate") {
			return withShape({key, root, verdict: "duplicate", reason: shape.reason});
		}

		const grafts = templateTexts.map((text) => graftContext(text, onDisk.success));
		const ungraftable = grafts.find((candidate) => candidate._tag === "Ungraftable");
		if (ungraftable !== undefined) return withShape(unreadable(ungraftable.reason));
		const graft = grafts.find((candidate) => candidate._tag === "Grafted");
		if (graft === undefined) {
			const foreign = grafts.find((candidate) => candidate._tag === "Foreign");
			const id = foreign === undefined ? name : foreign.id;
			return withShape({
				key,
				root,
				verdict: "generated",
				reason: `machine "${id}" was generated, not booted — it drains on the machine it was emitted with and is never migrated`,
			});
		}
		if (sameMachine(onDisk.success, graft.text)) return withShape({key, root, verdict: "current"});

		const candidate = compileText(graft.text);
		if (candidate._tag === "Malformed") {
			return withShape(
				unreadable(`the committed template does not compile: ${candidate.defects.join("; ")}`),
			);
		}
		const judged = judgeMigration(loaded.lane, candidate.lane, loaded.entries);
		if (judged._tag === "Unreplayable") {
			return withShape({
				key,
				root,
				verdict: "unsafe",
				reason:
					judged.through === "current"
						? `${loaded.logPath} already does not replay through this lane's own machine: ${judged.defects.join("; ")}`
						: `${loaded.logPath} does not replay through the committed template: ${judged.defects.join("; ")}`,
			});
		}
		if (judged._tag === "Drifts") {
			return withShape({
				key,
				root,
				verdict: "unsafe",
				reason: `the committed template would fold this lane's log to a different state: ${judged.drifts
					.map((drift) => `${drift.task} ${drift.from} → ${drift.to}`)
					.join("; ")}`,
				drifts: judged.drifts,
			});
		}
		if (check) return withShape({key, root, verdict: "stale"});

		const wrote = yield* Effect.result(writeFile(workflowPath, graft.text));
		return withShape(
			Result.isFailure(wrote)
				? unreadable(`the write to ${workflowPath} did not land: ${wrote.failure.reason}`)
				: {key, root, verdict: "migrated"},
		);
	});

export const runMigrate = <R = never>(
	options: MigrateOptions<R>,
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
						`${VERB}: cannot read the committed template at ${templatePath}: ${template.failure.reason} — nothing was migrated.`,
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
				// The filter sits ahead of `migrateLane`, so a narrowed run does not read, judge or
				// write any other entry — a lane belonging to another driver is never opened at all.
				if (options.lane !== null && keyOf(root, name) !== options.lane) continue;
				const row = yield* migrateLane(
					root,
					name,
					templateTexts,
					options.check,
					options.expectations,
				);
				if (row === null) continue;
				found += 1;
				lanes.push(row);
			}
			scanned.push({root, present: true, lanes: found});
		}

		// A key that matched nothing is a proven absence, never a clean sweep of zero: the caller
		// named a lane, and answering `{summary: all zero}` at exit 0 would read as "nothing to do"
		// for a lane that was never judged at all.
		if (options.lane !== null && lanes.length === 0) {
			return refuse(
				LANE_ABSENT,
				`${VERB}: no lane keyed ${options.lane} under ${options.roots.map((swept) => swept.root).join(", ")} — nothing was judged and nothing was written. A chore lane is addressed \`chore:<name>\`; drop the key to sweep the whole root.`,
			);
		}

		const summary = Object.fromEntries(
			VERDICTS.map((verdict) => [verdict, lanes.filter((row) => row.verdict === verdict).length]),
		);
		const unsafe = lanes.filter((row) => row.verdict === "unsafe");
		const mismatched = lanes.filter((row) => row.verdict === "mismatched");
		const duplicate = lanes.filter((row) => row.verdict === "duplicate");
		const acted = lanes.filter((row) => row.verdict === (options.check ? "stale" : "migrated"));
		// A duplicate reaches the operator on stderr as well as in its row, because a refusal over some
		// OTHER lane empties stdout by contract and would take every duplicate finding with it.
		const stderr = [
			`${VERB}: swept ${scanned.map((entry) => `${entry.root} (${entry.present ? `${entry.lanes} lane(s)` : "absent"})`).join(", ")}${options.lane === null ? "" : ` — narrowed to lane ${options.lane}`}${options.check ? " — check only, nothing written" : ""}.`,
			...duplicate.map((row) => `${VERB}: ${row.key}: ${row.reason ?? "duplicate"}`),
			...mismatched.map((row) => `${VERB}: ${row.key}: ${row.reason ?? "mismatched"}`),
			...unsafe.map((row) => `${VERB}: ${row.key}: ${row.reason ?? "unsafe"}`),
		];
		if (unsafe.length === 0 && mismatched.length === 0) {
			return answer(
				JSON.stringify({check: options.check, scanned, summary, lanes}, null, 2),
				stderr,
			);
		}
		// A mismatched lane is not a migration hazard, so it seats behind one: where both are present
		// the unsafe refusal wins, because a lane whose log would be relocated is the worse answer.
		if (unsafe.length === 0) {
			return refuse(
				SHAPE_MISMATCH,
				`${VERB}: ${mismatched.length} lane(s) run a machine their issue's board state does not call for, and none of those was written: ${mismatched.map((row) => row.key).join(", ")}. An epic's lane is rebuilt in two steps — retire its directory, then \`fabrika lane emit <n>\` (a lane on disk is never re-emitted over). A lane whose issue is not an epic is opened with \`fabrika lane open <n>\`.`,
				stderr,
			);
		}
		// The refusal's stdout is empty by contract, so the keys that DID move have to reach the
		// operator on stderr — otherwise a partly-applied sweep is a write nobody can enumerate.
		return refuse(
			MIGRATION_UNSAFE,
			`${VERB}: ${unsafe.length} lane(s) cannot take the committed template without moving, and none of those was written: ${unsafe.map((row) => row.key).join(", ")}. ${
				options.check
					? `${acted.length} other lane(s) are stale and safe to migrate.`
					: `${acted.length} other lane(s) were migrated: ${acted.map((row) => row.key).join(", ") || "none"}.`
			} A lane whose log will never replay leaves this sweep's scope through \`fabrika lane archive <lane>\`, which moves its directory to the archived root and touches no log; any other unsafe lane is a state to decide by hand. Re-run to sweep the rest.`,
			stderr,
		);
	});
