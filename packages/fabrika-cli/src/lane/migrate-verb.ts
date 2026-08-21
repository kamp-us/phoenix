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
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import {exists, readDir, readFile, writeFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {LANE_UNREADABLE, MIGRATION_UNSAFE} from "./codes.ts";
import {CHORE_PREFIX} from "./key.ts";
import {compileText} from "./machine.ts";
import {type Drift, graftContext, judgeMigration, sameMachine} from "./migrate.ts";
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

export interface MigrateOptions {
	readonly roots: ReadonlyArray<MigrateRoot>;
	/** Judge and report, write nothing. */
	readonly check: boolean;
}

type Verdict = "current" | "migrated" | "stale" | "generated" | "unsafe" | "unreadable";

const VERDICTS: ReadonlyArray<Verdict> = [
	"current",
	"migrated",
	"stale",
	"generated",
	"unsafe",
	"unreadable",
];

interface LaneRow {
	readonly key: string;
	readonly root: string;
	readonly verdict: Verdict;
	/** Why the sweep could not migrate this lane; absent on every lane it could act on. */
	readonly reason?: string;
	readonly drifts?: ReadonlyArray<Drift>;
}

/** How a caller addresses this lane: a chore root's entries are keyed `chore:<name>` (`key.ts`). */
const keyOf = (root: string, name: string): string =>
	root === DEFAULT_CHORES_ROOT ? `${CHORE_PREFIX}${name}` : name;

const migrateLane = (
	root: string,
	name: string,
	templateTexts: ReadonlyArray<string>,
	check: boolean,
): Effect.Effect<LaneRow | null, never, FileSystem.FileSystem | Path.Path> =>
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
		const grafts = templateTexts.map((text) => graftContext(text, onDisk.success));
		const ungraftable = grafts.find((candidate) => candidate._tag === "Ungraftable");
		if (ungraftable !== undefined) return unreadable(ungraftable.reason);
		const graft = grafts.find((candidate) => candidate._tag === "Grafted");
		if (graft === undefined) {
			const foreign = grafts.find((candidate) => candidate._tag === "Foreign");
			const id = foreign === undefined ? name : foreign.id;
			return {
				key,
				root,
				verdict: "generated",
				reason: `machine "${id}" was generated, not booted — it drains on the machine it was emitted with and is never migrated (ADR 0313, amendment 2026-08-20)`,
			};
		}
		if (sameMachine(onDisk.success, graft.text)) return {key, root, verdict: "current"};

		const candidate = compileText(graft.text);
		if (candidate._tag === "Malformed") {
			return unreadable(`the committed template does not compile: ${candidate.defects.join("; ")}`);
		}
		const judged = judgeMigration(loaded.lane, candidate.lane, loaded.entries);
		if (judged._tag === "Unreplayable") {
			return {
				key,
				root,
				verdict: "unsafe",
				reason:
					judged.through === "current"
						? `${loaded.logPath} already does not replay through this lane's own machine: ${judged.defects.join("; ")}`
						: `${loaded.logPath} does not replay through the committed template: ${judged.defects.join("; ")}`,
			};
		}
		if (judged._tag === "Drifts") {
			return {
				key,
				root,
				verdict: "unsafe",
				reason: `the committed template would fold this lane's log to a different state: ${judged.drifts
					.map((drift) => `${drift.task} ${drift.from} → ${drift.to}`)
					.join("; ")}`,
				drifts: judged.drifts,
			};
		}
		if (check) return {key, root, verdict: "stale"};

		const wrote = yield* Effect.result(writeFile(workflowPath, graft.text));
		return Result.isFailure(wrote)
			? unreadable(`the write to ${workflowPath} did not land: ${wrote.failure.reason}`)
			: {key, root, verdict: "migrated"};
	});

export const runMigrate = (
	options: MigrateOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
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
				const row = yield* migrateLane(root, name, templateTexts, options.check);
				if (row === null) continue;
				found += 1;
				lanes.push(row);
			}
			scanned.push({root, present: true, lanes: found});
		}

		const summary = Object.fromEntries(
			VERDICTS.map((verdict) => [verdict, lanes.filter((row) => row.verdict === verdict).length]),
		);
		const unsafe = lanes.filter((row) => row.verdict === "unsafe");
		const acted = lanes.filter((row) => row.verdict === (options.check ? "stale" : "migrated"));
		const stderr = [
			`${VERB}: swept ${scanned.map((entry) => `${entry.root} (${entry.present ? `${entry.lanes} lane(s)` : "absent"})`).join(", ")}${options.check ? " — check only, nothing written" : ""}.`,
			...unsafe.map((row) => `${VERB}: ${row.key}: ${row.reason ?? "unsafe"}`),
		];
		if (unsafe.length === 0) {
			return answer(
				JSON.stringify({check: options.check, scanned, summary, lanes}, null, 2),
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
			} Decide each unsafe lane's state by hand — re-run to sweep the rest.`,
			stderr,
		);
	});
