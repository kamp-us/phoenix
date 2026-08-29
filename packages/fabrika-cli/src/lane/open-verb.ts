/**
 * `lane open` — boot one single-issue lane from the committed coder template, byte-identically.
 *
 * The boot the operator did by hand as `mkdir -p && cp` (#5680, gate-1 friction item 1), as a verb
 * that refuses instead of overwriting: an existing lane dir is a loud {@link LANE_EXISTS}, because
 * resuming needs no boot and a silent overwrite would corrupt a live fold.
 *
 * The coder template has one task, so an issue carrying sub-issue links has no machine here at all —
 * booting one anyway is #7024's wrong-template lane, which reads healthy to every later diagnostic.
 * So an issue-keyed boot asks the board what the issue is *before* it writes, and refuses an epic
 * with {@link SHAPE_MISMATCH}. A chore lane drives no issue and is never asked.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {readFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {LANE_UNREADABLE, SHAPE_MISMATCH} from "./codes.ts";
import type {ExpectationReader} from "./expectation.ts";
import {placementRefusal} from "./refusals.ts";
import {type LaneRef, placeMachine} from "./store.ts";

const VERB = "fabrika lane open";

export interface OpenOptions<R = never> extends LaneRef {
	/** The committed coder template's on-disk path — resolved by the adapter beside this module. */
	readonly templatePath: string;
	/** The issue this lane drives, or `null` for a chore lane, which drives none. */
	readonly issue: number | null;
	/** The board reader, or `null` for the offline boot a caller gets by passing none. */
	readonly expectation: ExpectationReader<R> | null;
}

export const runOpen = <R = never>(
	options: OpenOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		// The template read comes first because it is the cheap local one, and because #6011's guard on
		// the packed tarball's assets is the answer it produces — a boot that never reaches it cannot
		// tell a missing asset from an unreachable board.
		const template = yield* Effect.result(readFile(options.templatePath));
		if (Result.isFailure(template)) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read the committed template at ${options.templatePath}: ${template.failure.reason} — nothing was booted.`,
			);
		}
		const {issue, expectation} = options;
		if (issue !== null && expectation !== null) {
			const read = yield* expectation(issue);
			if (read._tag === "Unknown") {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot establish whether #${issue} is an epic: ${read.reason} — refusing to boot over UNKNOWN.`,
				);
			}
			if (read.expectation._tag === "Epic") {
				return refuse(
					SHAPE_MISMATCH,
					`${VERB}: #${issue} carries ${read.expectation.children} sub-issue link(s), and this template has one task — boot it with \`fabrika lane emit ${issue}\`, which reads the epic's \`## Dependencies\` topology; plan the epic first if it has none. Nothing was written.`,
				);
			}
		}
		const placed = yield* placeMachine(options, template.success);
		if (placed._tag !== "Placed") return placementRefusal(VERB, placed);
		return answer(
			JSON.stringify({
				answer: "opened",
				lane: options.lane,
				workflow: placed.workflow,
				bytes: new TextEncoder().encode(template.success).length,
			}),
			[`${VERB}: booted ${placed.dir} from ${options.templatePath}.`],
		);
	});
