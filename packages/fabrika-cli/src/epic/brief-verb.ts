/**
 * `epic brief` — the dispatch brief for one slice, emitted through the `slice-handoff` wire format.
 *
 * Every value in the brief is derived: the contract from the child issue through the imported
 * acceptance-criteria read, the ground from the ledger and the graph, the rules from the format's
 * own byte-fixed text. Nothing here is authored per run, which is the point — the brief plus the
 * tree plus the graph are everything a fresh fork gets (H2), and a brief whose instructions could be
 * written per dispatch is a brief that can steer its receiver past the artifact.
 *
 * The composed document is **not** leak-scanned: `## Ground` carries a tree root and a temp-dir
 * handoff path by construction, and a brief is consumed in-session and never posted.
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {gate} from "../build/content-gate.ts";
import {headSha} from "../build/git.ts";
import {badNumber} from "../build/target.ts";
import {getIssue} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {emit as emitCriteria, read as readCriteria} from "../wire/acceptance-criteria.ts";
import {
	branchName,
	emit as emitHandoff,
	type SliceHandoff,
	sliceId,
} from "../wire/slice-handoff.ts";
import {headSha as brandSha} from "../wire/verdict-marker.ts";
import {
	BAD_SECTIONS,
	BREAKER_TRIPPED,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {breakerFor, clauseOf} from "./fold.ts";
import {forSlice, handoffPath, polarityOf} from "./ledger.ts";
import {laneGround, loadRun} from "./run.ts";

const VERB = "epic brief";

export interface BriefOptions {
	readonly number: number;
	readonly slice: string;
	readonly retry: boolean;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The OS temp root, read by the adapter — the one machine fact this verb does not derive. */
	readonly tmpRoot: string;
}

export const runBrief = (
	options: BriefOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const epic = options.number;
		const bad = badNumber(VERB, "an issue number", epic);
		if (bad !== null) return bad;

		const ground = yield* laneGround(VERB, epic, options.repo, options.env);
		if (ground._tag === "Refused") return ground.outcome;

		const run = yield* loadRun(VERB, epic, ground);
		if (run._tag === "Refused") return run.outcome;

		const slice = run.plan.slices.find((row) => row.id === options.slice);
		const id = sliceId(options.slice);
		if (slice === undefined || id === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: slice "${options.slice}" is not in run ${run.plan.run}.`,
				ground.notes,
			);
		}

		const axis = breakerFor(run.lines, slice.id);
		if (axis !== null) {
			return refuse(
				BREAKER_TRIPPED,
				`${VERB}: slice "${slice.id}"'s breaker is at cap — escalate; do not dispatch.`,
				[...ground.notes, `${VERB}: the tripped axis is ${axis}.`],
			);
		}

		const lastFail =
			forSlice(run.lines, slice.id)
				.filter((line) => line.event === "verdict-recorded" && polarityOf(line) === "FAIL")
				.at(-1) ?? null;
		if (options.retry && lastFail === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --retry, but slice "${slice.id}" has no FAIL verdict on record.`,
				ground.notes,
			);
		}

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
				`${VERB}: cannot read #${slice.issue}: ${child.reason} — the slice's contract is UNKNOWN.`,
				ground.notes,
			);
		}
		const criteria = readCriteria(gate("issue-body", `#${slice.issue}`, child.value.body).text);
		if (criteria._tag !== "Found") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: #${slice.issue}'s acceptance criteria are ${criteria._tag.toLowerCase()} (${criteria.reason}) — no criterion is invented; route it to the planning lane.`,
				ground.notes,
			);
		}

		const head = yield* headSha;
		if (head._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read HEAD: ${head.reason} — the slice's base is UNKNOWN.`,
				ground.notes,
			);
		}
		const base = brandSha(head.value);
		const branch = branchName(ground.branch ?? "");
		if (base === null || branch === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: the lane's branch or base could not be resolved — the ground is UNKNOWN.`,
				ground.notes,
			);
		}

		const [first, ...rest] = emitCriteria(criteria.value)
			.split("\n")
			.filter((line) => line.trim().startsWith("- ["));
		if (first === undefined) {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: #${slice.issue}'s acceptance criteria compose to no checkbox lines.`,
				ground.notes,
			);
		}

		const handoff: SliceHandoff = {
			id,
			issue: slice.issue,
			criteria: [first, ...rest],
			tree: ground.root,
			branch,
			base,
			handoff: handoffPath(options.tmpRoot, run.plan.run, slice.id),
			fixFirst: options.retry && lastFail !== null ? clauseOf(lastFail) : null,
		};
		return answer(emitHandoff(handoff), ground.notes);
	});
