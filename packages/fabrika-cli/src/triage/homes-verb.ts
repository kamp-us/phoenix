/**
 * `triage homes` — the assignable homes: every **open** milestone joined to its roadmap arc or
 * campaign row, plus the two standing lanes.
 *
 * **Zero open milestones is a refusal, not an answer.** An empty candidate list routes the caller
 * toward a standing lane or a close, and a close driven by a failed read is irreversible — so both
 * "I read nothing" cases red on {@link ZERO_SCOPE} and both "I could not look" cases on
 * {@link PRECONDITION_UNKNOWN}, never on `1`, which would fuse an unreachable GitHub with a
 * mistyped flag.
 *
 * Curating the milestone set is a human roadmap act (ADR 0072 §3), so this verb creates none. It
 * offers only open, roadmap-joined milestones, which designs out the mismatch where a closed
 * milestone reports as a valid home.
 */
import {Effect, Result} from "effect";
import {readFile} from "../io/fs.ts";
import {listOpenMilestones, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {parseRoadmap, roadmapRowFor} from "./roadmap.ts";
import {scannedLine} from "./scope.ts";

export const DEFAULT_ROADMAP = "ROADMAP.md";

/** One standing lane: a label that is a home in its own right, and what routing to it means. */
export interface StandingLane {
	readonly label: string;
	readonly meaning: string;
}

/**
 * The two standing lanes, and **the only place in this package that enumerates them.**
 *
 * `triage apply --lane` takes its vocabulary from here rather than restating it, so the pair cannot
 * drift into two lists a reader has to reconcile. The meanings are constants rather than the repo's
 * live label descriptions, so a description edit cannot change a machine-channel answer. There is no
 * third lane, and this verb never invents one.
 */
export const STANDING_LANES: ReadonlyArray<StandingLane> = [
	{label: "wayfinder:backlog", meaning: "fog — uncharted work upstream of any arc"},
	{label: "axis:pipeline-hardening", meaning: "the standing pipeline and reliability lane"},
];

export interface HomesOptions {
	readonly roadmap: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The lane rows, on stderr — a `7` refusal withholds stdout entirely, so they go where they fit. */
const laneNotice = STANDING_LANES.map(
	(lane) => `triage homes: standing lane ${lane.label} — ${lane.meaning}`,
);

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
			[scope, ...laneNotice],
		);
	}

	const read = yield* Effect.result(readFile(roadmap));
	if (Result.isFailure(read)) {
		return refuse(
			PRECONDITION_UNKNOWN,
			`triage homes: cannot read the roadmap at ${roadmap}: ${read.failure.reason} — the home list is UNKNOWN, never empty.`,
			[scope],
		);
	}

	const rows = parseRoadmap(read.success);
	// Zero ARC rows is a failed parse, not a repo with no arcs: the table grammar belongs to the
	// roadmap, so a grammar change silently empties the join. Zero CAMPAIGN rows is a legitimate
	// state and passes.
	if (rows.arcs.length === 0) {
		return refuse(
			ZERO_SCOPE,
			`triage homes: the roadmap at ${roadmap} parsed to 0 arc rows — the table grammar changed or the file is truncated; refusing to answer over an unjoinable roadmap.`,
			[scope, ...laneNotice],
		);
	}

	const homes = [...milestones.value]
		.sort((a, b) => a.number - b.number)
		.map((milestone) => ({
			number: milestone.number,
			title: milestone.title,
			roadmapRow: roadmapRowFor(rows, milestone.number),
		}));

	if (json) {
		return answer(
			JSON.stringify({
				outcome: "homes",
				milestones: homes,
				lanes: STANDING_LANES,
				scanned: milestones.value.length,
			}),
			[scope],
		);
	}
	return answer(
		[
			"homes",
			...homes.map((home) => `milestone\t${home.number}\t${home.title}`),
			...STANDING_LANES.map((lane) => `lane\t${lane.label}\t${lane.meaning}`),
		].join("\n"),
		[scope],
	);
});
