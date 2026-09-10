/**
 * `lane open` — boot one single-issue lane from the committed coder template, byte-identically.
 *
 * The boot an operator used to do by hand as `mkdir -p && cp`, as a verb
 * that refuses instead of overwriting: an existing lane dir is a loud {@link LANE_EXISTS}, because
 * resuming needs no boot and a silent overwrite would corrupt a live fold.
 *
 * The coder template has one task, so an epic has no machine here at all — booting one anyway is
 * the wrong-template lane, which reads healthy to every later diagnostic. So an issue-keyed boot
 * asks the board what the issue is *before* it writes, and refuses an epic with
 * {@link SHAPE_MISMATCH}. A chore lane drives no issue and is never asked.
 *
 * **Both halves of "epic" are asked for, and the unplanned half is the one the incident needed.** An
 * epic that has not been planned carries no sub-issue links, so a refusal keyed on children alone
 * could not fire in the pre-plan window the incident came from; the `type:epic` label is what covers
 * it. The refusal says which case it is, because their remedies differ: plan the epic, or emit its
 * machine.
 *
 * **The parent edge is asked for too, and it is the mirror those two facts cannot see.** An epic's
 * child carries neither of them, so it booted a coder-template ledger of its own while the parent's
 * lane held the same number as a task — two ledgers over one piece of work, reconciled by
 * nothing. That refusal is {@link LANE_IS_CHILD}, and a child never gets a ledger whatever else is
 * true. Epic wins the precedence, so a sub-epic still routes to `lane emit`.
 *
 * **The edge is where that question starts, not where it is answered.** The refusal used to assert
 * off the edge alone that the parent's lane already carried the child as a task, which is false for
 * a follow-up linked under a running epic — its remedy sent the driver to a lane with no cell for
 * the issue, and no operator could pick it up at all. So the parent lane's own task set is
 * read first ([`child-membership.ts`](child-membership.ts)) and the route the refusal names comes
 * off that: drive the parent lane, amend it first, or — when the task set did not read — read it
 * before choosing either.
 *
 * The repo's declared `laneConcurrencyCap` is the last gate before the write, and an issue lane's
 * alone — see [`concurrency.ts`](concurrency.ts) for what counts as a held seat: a lane under this
 * root whose log folds to `active` AND whose issue carries a live `lane claim`, plus every lane no
 * read can account for. An active lane nobody claims is idle and takes no seat.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import type {Read} from "../config/read-key.ts";
import {readFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {type ChildMembership, childMembership} from "./child-membership.ts";
import type {ClaimHoldReader} from "./claim-hold.ts";
import {LANE_IS_CHILD, LANE_UNREADABLE, SHAPE_MISMATCH} from "./codes.ts";
import {capRefusal} from "./concurrency.ts";
import type {ExpectationReader} from "./expectation.ts";
import {placementRefusal} from "./refusals.ts";
import {type LaneRef, placeMachine} from "./store.ts";

const VERB = "fabrika lane open";

/**
 * One refusal per membership outcome, because the three take different acts.
 *
 * The denial is the constant across all three — a child never gets a ledger of its own — and what
 * moves is the route out: drive the parent lane, amend it first, or read it before deciding
 * anything. An UNKNOWN names the read that failed and asserts membership in neither direction.
 */
const childRefusal = (issue: number, membership: ChildMembership): string => {
	switch (membership._tag) {
		case "Represented":
			return `${VERB}: #${issue} hangs under #${membership.parent}, whose lane carries it as task \`${membership.taskId}\` — drive that lane (\`fabrika lane status ${membership.parent}\`), never a second ledger for the child. Nothing was written.`;
		case "Absent":
			return `${VERB}: #${issue} hangs under #${membership.parent}, whose lane holds no task \`${membership.taskId}\` — it was linked after that lane was emitted. Place #${issue} in #${membership.parent}'s \`## Dependencies\` block, run \`fabrika lane amend ${membership.parent}\`, then drive that lane (\`fabrika lane status ${membership.parent}\`). A child gets no lane of its own. Nothing was written.`;
		case "Unknown":
			return `${VERB}: #${issue} hangs under ${membership.parent === null ? "a parent issue" : `#${membership.parent}`}, and whether that lane carries a task for it is UNKNOWN: ${membership.reason} — read the parent lane before choosing between driving it and \`fabrika lane amend\`. A child gets no lane of its own either way. Nothing was written.`;
	}
};

export interface OpenOptions<R = never> extends LaneRef {
	/** The committed coder template's on-disk path — resolved by the adapter beside this module. */
	readonly templatePath: string;
	/** The issue this lane drives, or `null` for a chore lane, which drives none. */
	readonly issue: number | null;
	/** The board reader, or `null` for the offline boot a caller gets by passing none. */
	readonly expectation: ExpectationReader<R> | null;
	/**
	 * The repo's declared `laneConcurrencyCap`, read off `.fabrika.jsonc` by the adapter.
	 *
	 * Read for every boot and applied to an issue lane only: the cap counts the issue lanes under
	 * this root, and a chore lane lives under a root of its own that nothing here counts.
	 */
	readonly cap: Read<number | null>;
	/**
	 * Which lanes under this root a driver is holding — only a claimed one takes a seat.
	 *
	 * A reader the adapter passes, the way `expectation` is, so the count stays provable offline.
	 */
	readonly claimed: ClaimHoldReader<R>;
}

export const runOpen = <R = never>(
	options: OpenOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		// The template read comes first because it is the cheap local one, and because the guard on
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
				const membership = yield* childMembership(options.root, read.expectation.parent, issue);
				return refuse(LANE_IS_CHILD, childRefusal(issue, membership));
			}
		}
		// Last, so a permanent defect — the wrong template for this issue, a child that gets no lane —
		// is named ahead of a cap that will clear on its own the moment a seat frees.
		if (issue !== null) {
			const capped = yield* capRefusal(VERB, options.cap, options.root, options.claimed);
			if (capped !== null) return capped;
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
