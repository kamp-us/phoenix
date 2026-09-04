/**
 * `lane open` — boot one single-issue lane from the committed coder template, byte-identically.
 *
 * The boot the operator did by hand as `mkdir -p && cp` (#5680, gate-1 friction item 1), as a verb
 * that refuses instead of overwriting: an existing lane dir is a loud {@link LANE_EXISTS}, because
 * resuming needs no boot and a silent overwrite would corrupt a live fold.
 *
 * The coder template has one task, so an epic has no machine here at all — booting one anyway is
 * #7024's wrong-template lane, which reads healthy to every later diagnostic. So an issue-keyed boot
 * asks the board what the issue is *before* it writes, and refuses an epic with
 * {@link SHAPE_MISMATCH}. A chore lane drives no issue and is never asked.
 *
 * **Both halves of "epic" are asked for, and the unplanned half is the one the incident needed.** An
 * epic that has not been planned carries no sub-issue links, so a refusal keyed on children alone
 * could not fire in the pre-plan window #7024 was filed from; the `type:epic` label is what covers
 * it. The refusal says which case it is, because their remedies differ: plan the epic, or emit its
 * machine.
 *
 * **The parent edge is asked for too, and it is the mirror those two facts cannot see.** An epic's
 * child carries neither of them, so it booted a coder-template ledger of its own while the parent's
 * lane already held the same number as a task — two ledgers over one piece of work, reconciled by
 * nothing (#7381). That refusal is {@link LANE_IS_CHILD} and names the parent's lane as the one to
 * drive. Epic wins the precedence, so a sub-epic still routes to `lane emit`.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {readFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {LANE_IS_CHILD, LANE_UNREADABLE, SHAPE_MISMATCH} from "./codes.ts";
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
				const {children} = read.expectation;
				return refuse(
					SHAPE_MISMATCH,
					children === 0
						? `${VERB}: #${issue} is typed \`type:epic\` and carries no sub-issue links, so it has no plan yet and this template's one task cannot represent it — plan the epic first, then boot it with \`fabrika lane emit ${issue}\`. Nothing was written.`
						: `${VERB}: #${issue} carries ${children} sub-issue link(s), and this template has one task — boot it with \`fabrika lane emit ${issue}\`, which reads the epic's \`## Dependencies\` topology; plan the epic first if it has none. Nothing was written.`,
				);
			}
			if (read.expectation._tag === "Child") {
				const {parent} = read.expectation;
				return refuse(
					LANE_IS_CHILD,
					parent === null
						? `${VERB}: #${issue} hangs under a parent issue, whose lane already carries it as a task — the board carried the edge and no number that reads, so find the parent and drive its lane instead. A child gets no lane of its own. Nothing was written.`
						: `${VERB}: #${issue} hangs under #${parent}, whose lane already carries it as a task — drive that lane (\`fabrika lane status ${parent}\`), never a second ledger for the child. Nothing was written.`,
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
