/**
 * `triage homes` — the assignable homes: every **open** milestone joined to its roadmap arc or
 * campaign row, plus the standing lanes this repo declares AND carries the labels for.
 *
 * **Zero open milestones is a refusal, not an answer.** An empty candidate list routes the caller
 * toward a standing lane or a close, and a close driven by a failed read is irreversible — so both
 * "I read nothing" cases red on {@link ZERO_SCOPE} and both "I could not look" cases on
 * {@link PRECONDITION_UNKNOWN}, never on `1`, which would fuse an unreachable GitHub with a
 * mistyped flag.
 *
 * An **absent** roadmap is neither: it is a proven negative, so the milestones list unjoined — the
 * same degrade disposition the rest of the corpus declares for that file. Only a roadmap that exists
 * and could not be read is UNKNOWN.
 *
 * Curating the milestone set is a human roadmap act (ADR 0072 §3), so this verb creates none. It
 * offers only open, roadmap-joined milestones, which designs out the mismatch where a closed
 * milestone reports as a valid home.
 *
 * A row can carry a **running** marker: an `active` campaign is closed to new intake unless the work
 * is p0 or p1, or blocks one of that milestone's own in-flight lanes (#6080, widened to p1 by ADR
 * 0354). Which milestones those are, is
 * data — `ROADMAP.md`'s `## Campaigns` table, the same permission `build pick` fences on, read
 * through the same parser off the roadmap text this verb already has open. A marked row is still
 * offered: the two exceptions are real, and a removed row cannot carry them.
 */
import {Effect, Result} from "effect";
import {dispatchMilestones, dispatchScopeLine, readCampaigns} from "../build/scope-admission.ts";
import {exists, readFile} from "../io/fs.ts";
import {listLabels, listOpenMilestones, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {parseRoadmap, type RoadmapRows, roadmapRowFor} from "./roadmap.ts";
import {scannedLine} from "./scope.ts";
import {offeredLanes, type StandingLane} from "./standing-lanes.ts";

/**
 * The roadmap side of the join: a file that was read and parsed, or one proven absent.
 *
 * A filesystem probe is what separates the two, never the shape of a read failure — `readFile`
 * lowers `NotFound` and `EACCES` into one flat `reason` string, so telling them apart by its text
 * would be a guess. Absent joins to nothing; unreadable stays UNKNOWN.
 */
type RoadmapSide =
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Present"; readonly text: string; readonly rows: RoadmapRows};

/** What the marked row says, on both channels — the subtraction, not a routing instruction. */
export const RUNNING_MARKER = "running: p0/p1 or blocker";

export interface HomesOptions {
	readonly roadmap: string;
	/** The lanes this repo declares — resolved from `.fabrika.jsonc` by the delivery layer. */
	readonly standingLanes: ReadonlyArray<string>;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The lane rows, on stderr — a `7` refusal withholds stdout entirely, so they go where they fit. */
const laneNotices = (lanes: ReadonlyArray<StandingLane>): ReadonlyArray<string> =>
	lanes.map((lane) => `triage homes: standing lane ${lane.label} — ${lane.meaning}`);

/**
 * What the declared lane set became on this board, as one stderr line.
 *
 * It names the dropped labels rather than only the count: an operator in a repo where the lanes were
 * never created needs to see WHICH names the config asserts and the board lacks — that gap is the
 * whole defect, and a bare `0 of 2` sends them back to the config to find out.
 */
const laneScopeLine = (
	repo: string,
	declared: ReadonlyArray<string>,
	offered: ReadonlyArray<StandingLane>,
): string => {
	if (declared.length === 0) return "triage homes: standing lanes: this repo declares none.";
	const offeredLabels = new Set(offered.map((lane) => lane.label));
	const dropped = declared.filter((label) => !offeredLabels.has(label));
	const tail = dropped.length === 0 ? "" : ` — not offered: ${dropped.join(", ")}`;
	return `triage homes: standing lanes: ${offered.length} of ${declared.length} declared carry a label in ${repo}${tail}.`;
};

export const runHomes = Effect.fn("runHomes")(function* (options: HomesOptions) {
	const {roadmap, json} = options;

	const repoAttempt = yield* resolveRepo(options.repo, options.env);
	if (repoAttempt._tag === "Failure") {
		return refuse(
			FAILED,
			"triage homes: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
		);
	}
	const repo = repoAttempt.value;

	// The declared set is a candidate list, never the answer: a lane is offered only once this board
	// is observed to carry its label, which is the same evidence the `triage apply --lane` write it
	// routes to depends on (#6440). An unreadable label list is UNKNOWN — never "this repo has no
	// lanes", which is the reading that silently shortens the menu.
	let lanes: ReadonlyArray<StandingLane> = [];
	if (options.standingLanes.length > 0) {
		const labels = yield* listLabels(repo);
		if (labels._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`triage homes: cannot read the labels in ${repo}: ${labels.reason} — which standing lanes this board accepts is UNKNOWN, never none.`,
			);
		}
		lanes = offeredLanes(options.standingLanes, new Set(labels.value));
	}
	const laneScope = laneScopeLine(repo, options.standingLanes, lanes);

	const milestones = yield* listOpenMilestones(repo);
	if (milestones._tag === "Failure") {
		return refuse(
			PRECONDITION_UNKNOWN,
			`triage homes: cannot read milestones in ${repo}: ${milestones.reason} — the home list is UNKNOWN, never empty.`,
		);
	}

	const scope = scannedLine("triage homes", repo, milestones.value.length, "open milestone");
	if (milestones.value.length === 0) {
		return refuse(
			ZERO_SCOPE,
			`triage homes: ${repo} has 0 open milestones — refusing to answer, since "no home exists" routes to a kill (ADR 0092).`,
			[scope, laneScope, ...laneNotices(lanes)],
		);
	}

	const probe = yield* Effect.result(exists(roadmap));
	if (Result.isFailure(probe)) {
		return refuse(
			PRECONDITION_UNKNOWN,
			`triage homes: cannot probe the roadmap at ${roadmap}: ${probe.failure.reason} — the home list is UNKNOWN, never empty.`,
			[scope],
		);
	}

	let side: RoadmapSide = {_tag: "Absent"};
	if (probe.success) {
		const read = yield* Effect.result(readFile(roadmap));
		if (Result.isFailure(read)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`triage homes: cannot read the roadmap at ${roadmap}: ${read.failure.reason} — the home list is UNKNOWN, never empty.`,
				[scope],
			);
		}
		side = {_tag: "Present", text: read.success, rows: parseRoadmap(read.success)};
	}

	// Zero ARC rows is a failed parse, not a repo with no arcs: the table grammar belongs to the
	// roadmap, so a grammar change silently empties the join. An ABSENT roadmap never reaches this
	// guard — there is no grammar to have drifted. Zero CAMPAIGN rows is legitimate and passes.
	if (side._tag === "Present" && side.rows.arcs.length === 0) {
		return refuse(
			ZERO_SCOPE,
			`triage homes: the roadmap at ${roadmap} parsed to 0 arc rows — the table grammar changed or the file is truncated; refusing to answer over an unjoinable roadmap.`,
			[scope, laneScope, ...laneNotices(lanes)],
		);
	}

	// Malformed is never read as "no milestone is running": it marks no row and says so here, and it
	// does not refuse — a home list is still the right answer over an unreadable campaigns table. An
	// absent roadmap reads as the empty document, which `readCampaigns` answers `None` over.
	const dispatch = readCampaigns(side._tag === "Present" ? side.text : "");
	const running = new Set(dispatch._tag === "Malformed" ? [] : dispatchMilestones(dispatch));

	const homes = [...milestones.value]
		.sort((a, b) => a.number - b.number)
		.map((milestone) => ({
			number: milestone.number,
			title: milestone.title,
			roadmapRow: side._tag === "Present" ? roadmapRowFor(side.rows, milestone.number) : null,
			// `undefined` rather than `false`: `JSON.stringify` drops the key, so an unmarked row
			// serialises byte-for-byte as it did before the marker existed.
			running: running.has(milestone.number) ? RUNNING_MARKER : undefined,
		}));
	const notices = [
		scope,
		laneScope,
		...(side._tag === "Absent"
			? [`triage homes: no roadmap at ${roadmap} — every milestone lists with no arc name.`]
			: []),
		dispatchScopeLine("triage homes", dispatch),
	];

	if (json) {
		return answer(
			JSON.stringify({
				outcome: "homes",
				milestones: homes,
				lanes,
				scanned: milestones.value.length,
			}),
			notices,
		);
	}
	return answer(
		[
			"homes",
			...homes.map((home) =>
				["milestone", home.number, home.title, home.running]
					.filter((cell) => cell !== undefined)
					.join("\t"),
			),
			...lanes.map((lane) => `lane\t${lane.label}\t${lane.meaning}`),
		].join("\n"),
		notices,
	);
});
