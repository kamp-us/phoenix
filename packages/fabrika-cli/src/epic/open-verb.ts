/**
 * `epic open` — open or resume the run: derive the slices, key the ledger to this claim, print state.
 *
 * The one verb that reads the epic and its children, and the one that writes the run's two files. It
 * judges nothing: whether an epic is worth conducting stays in the skill, and plan *quality* is the
 * planning lane's gate (`check-epic-plan`). What it does refuse is an **unparseable** topology — a
 * conductor cannot conduct what it cannot read, and "no parseable slices" is never "no slices".
 *
 * Re-opening is idempotent by design: a ledger already at this key answers `"resumed": true` and the
 * run picks up exactly where it left off.
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {gate} from "../build/content-gate.ts";
import {badNumber, scannedLine} from "../build/target.ts";
import {readTree} from "../build/tree.ts";
import {getIssue} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {
	BAD_SECTIONS,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	UNNAMEABLE_STATE,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	EXCLUDE_ENTRY,
	type LedgerLine,
	ledgerPathIn,
	nextSeq,
	parseLedger,
	renderLine,
} from "./ledger.ts";
import {readOrder, readPlan} from "./plan.ts";
import {
	claimGround,
	planPathIn,
	type RunPlan,
	type RunSlice,
	readFileThreeWays,
	renderPlan,
} from "./run.ts";

const VERB = "epic open";

/** The label that makes an issue conductable. Conducting anything else is off-vocabulary. */
export const EPIC_LABEL = "type:epic";

export interface OpenOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly at: string;
}

const criteriaToken = (body: string): RunSlice["criteria"] => {
	const read = readCriteria(body);
	return read._tag === "Found" ? "found" : read._tag === "Absent" ? "absent" : "malformed";
};

export const runOpen = (
	options: OpenOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const epic = options.number;
		const bad = badNumber(VERB, "an issue number", epic);
		if (bad !== null) return bad;

		const ground = yield* claimGround(VERB, epic, options.repo, options.env);
		if (ground._tag === "Refused") return ground.outcome;

		const found = yield* getIssue(ground.repo, epic);
		if (found._tag === "Absent" || (found._tag === "Present" && found.value.state !== "open")) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: issue #${epic} is proven absent or closed.`,
				ground.notes,
			);
		}
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${epic}: ${found.reason} — the run state is UNKNOWN.`,
				ground.notes,
			);
		}
		if (!found.value.labels.includes(EPIC_LABEL)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: #${epic} is not a ${EPIC_LABEL} — refusing to conduct it.`,
				ground.notes,
			);
		}

		const body = gate("issue-body", `#${epic}`, found.value.body);
		const plan = readPlan(body.text);
		if (plan._tag === "Unparseable") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: #${epic}'s body has no parseable planned ledger — a conductor cannot derive slices from prose; route to the planning lane.`,
				[...ground.notes, `${VERB}: ${plan.reason}.`],
			);
		}
		const ordered = readOrder(body.text, plan.slices);
		if (ordered._tag === "Unparseable") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: #${epic}'s body has no parseable planned ledger — a conductor cannot derive slices from prose; route to the planning lane.`,
				[...ground.notes, `${VERB}: ${ordered.reason}.`],
			);
		}

		const slices: RunSlice[] = [];
		for (const slice of plan.slices) {
			const child = yield* getIssue(ground.repo, slice.issue);
			if (child._tag === "Absent") {
				return refuse(
					ZERO_SCOPE,
					`${VERB}: issue #${slice.issue} is proven absent or closed.`,
					ground.notes,
				);
			}
			if (child._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read #${slice.issue}: ${child.reason} — the run state is UNKNOWN.`,
					ground.notes,
				);
			}
			const childBody = gate("issue-body", `#${slice.issue}`, child.value.body);
			slices.push({
				id: slice.id,
				issue: slice.issue,
				title: child.value.title,
				criteria: criteriaToken(childBody.text),
			});
		}

		const record: RunPlan = {epic, run: ground.key, slices, order: ordered.order};
		const ledgerPath = ledgerPathIn(ground.dir);
		const existing = yield* readFileThreeWays(ledgerPath);
		if (existing._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the run ledger: ${existing.reason} — the run state is UNKNOWN.`,
				ground.notes,
			);
		}
		let lines: ReadonlyArray<LedgerLine> = [];
		if (existing._tag === "Text") {
			const parsed = parseLedger(existing.text);
			if (parsed._tag === "Unnameable") {
				return refuse(
					UNNAMEABLE_STATE,
					`${VERB}: the ledger at ${ground.key} holds unnameable state (${parsed.detail}) — the run needs a human, never a guess.`,
					ground.notes,
				);
			}
			lines = parsed.lines;
		}
		const resumed = existing._tag === "Text";

		const fs = yield* FileSystem.FileSystem;
		const write = (path: string, text: string): Effect.Effect<string | null> =>
			fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), {recursive: true}).pipe(
				Effect.andThen(fs.writeFileString(path, text)),
				Effect.as(null),
				Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
			);

		const planWrite = yield* write(planPathIn(ground.dir), renderPlan(record));
		if (planWrite !== null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot create the run plan: ${planWrite} — the run state is UNKNOWN.`,
				ground.notes,
			);
		}
		if (!resumed) {
			const opened = renderLine({
				seq: nextSeq(lines),
				at: options.at,
				event: "run-opened",
				slice: null,
				detail: `${slices.length} slices`,
				sha: null,
			});
			const ledgerWrite = yield* write(ledgerPath, opened);
			if (ledgerWrite !== null) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot create the run ledger: ${ledgerWrite} — the run state is UNKNOWN.`,
					ground.notes,
				);
			}
		}

		const excluded = yield* registerExclude(fs);
		if (excluded !== null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot register ${EXCLUDE_ENTRY} in this tree's git exclude: ${excluded} — conductor state could reach the PR.`,
				ground.notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "opened",
				epic,
				run: ground.key,
				slices,
				order: ordered.order,
				resumed,
			}),
			[
				...ground.notes,
				scannedLine(VERB, slices.length, "slice", `${slices.length} children fetched`),
			],
		);
	});

/**
 * Put the run directory behind the tree's own exclude file, so conductor state can never enter the
 * epic's PR — scope leakage the reviewer would have to catch by eye otherwise.
 */
const registerExclude = (
	fs: FileSystem.FileSystem,
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const tree = yield* readTree;
		if (tree._tag === "Failure") return tree.reason;
		const path = `${tree.value.gitDir}/info/exclude`;
		const current = yield* fs
			.readFileString(path)
			.pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
		if (current.split("\n").some((line) => line.trim() === EXCLUDE_ENTRY)) return null;
		const next = current === "" || current.endsWith("\n") ? current : `${current}\n`;
		return yield* fs.makeDirectory(`${tree.value.gitDir}/info`, {recursive: true}).pipe(
			Effect.andThen(fs.writeFileString(path, `${next}${EXCLUDE_ENTRY}\n`)),
			Effect.as(null),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
		);
	});
