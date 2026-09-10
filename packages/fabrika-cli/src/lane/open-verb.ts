/**
 * `lane open` — boot one single-issue lane from the committed coder template.
 *
 * **Byte-identical when no class stands, and seeded when one does.** The template's
 * `context.<task>.classes` had no producer at all, so a rendered-surface lane's first build ran in
 * the plain builder and reached `build:ui` only after a `review-ui` FAIL had raised the class off a
 * diff. The producer is `triage apply --class`, and this verb is where its label becomes the seed:
 * the names ride the expectation read's own payload ([`expectation.ts`](expectation.ts)), and
 * [`class-seed.ts`](class-seed.ts) writes them into the bytes placed. An off-set spelling refuses on
 * {@link CLASS_UNRECOGNISED} before placement, because the compiler's own check fires on read and so
 * would refuse every later fold of the lane rather than this one boot.
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
 * **A lane the board says already ran is refused too, with {@link PRIOR_LANE}.** The ledger is a
 * lane's whole state and `.fabrika/` is gitignored, so removing the directory and booting again
 * restores a spent repair budget and leaves no record that a round was granted — the laundering this
 * refusal exists to stop, and the reason a spent budget comes back only through a recorded
 * clearance. The fact is a caller-passed [`prior-lane.ts`](prior-lane.ts) read, asked only when the
 * directory is absent, so an existing lane still answers {@link LANE_EXISTS} and a driver's tolerated
 * resume is unchanged.
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
import {renderClasses, seedClasses} from "./class-seed.ts";
import {
	CLASS_UNRECOGNISED,
	LANE_EXISTS,
	LANE_IS_CHILD,
	LANE_UNREADABLE,
	PRIOR_LANE,
	SHAPE_MISMATCH,
} from "./codes.ts";
import {capRefusal} from "./concurrency.ts";
import type {ExpectationReader} from "./expectation.ts";
import type {PriorLaneReader} from "./prior-lane.ts";
import {placementRefusal} from "./refusals.ts";
import {type LaneRef, placeMachine, probeLane} from "./store.ts";

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
	 * Whether the board says this issue already had a lane, or `null` for the same offline boot.
	 *
	 * Asked for an issue key only, and only when no lane directory is there: a chore lane drives no
	 * issue, and a lane already on disk is a resume its own refusal already names.
	 */
	readonly priorLane: PriorLaneReader<R> | null;
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
		let classes: ReadonlyArray<string> = [];
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
			classes = read.classes;
		}
		// Before placement, so a bad seed never lands: a document carrying an off-set spelling compiles
		// `Malformed`, which refuses every later fold of the lane rather than this one boot.
		const seed = seedClasses(template.success, classes);
		if (seed._tag === "OffSet") {
			return refuse(
				CLASS_UNRECOGNISED,
				`${VERB}: #${issue} carries ${renderClasses(seed.names)}, which no \`class:<name>\` arm matches — a lane seeded with it routes as unclassed, so the rendered-visual shells it asked for are never dispatched. Respell the label, then boot. Nothing was written.`,
			);
		}
		if (seed._tag === "Unseedable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot seed ${renderClasses(classes)} into ${options.templatePath}: ${seed.reason} — nothing was booted.`,
			);
		}
		if (issue !== null && options.priorLane !== null) {
			// Only over an absent directory: a lane already there is the resume `lane open`'s own
			// `LANE_EXISTS` names, and answering this code instead would stop a driver mid-drive.
			const presence = yield* probeLane(options);
			if (presence._tag === "Absent") {
				const read = yield* options.priorLane(issue);
				if (read._tag === "Unknown") {
					return refuse(
						LANE_UNREADABLE,
						`${VERB}: cannot establish whether #${issue} already had a lane: ${read.reason} — refusing to boot over UNKNOWN. Nothing was written.`,
					);
				}
				if (read._tag === "Prior") {
					const pulls = read.pulls.map((pull) => `#${pull}`).join(", ");
					return refuse(
						PRIOR_LANE,
						`${VERB}: #${issue} already had a lane — the board hangs ${read.pulls.length === 1 ? "pull request" : "pull requests"} ${pulls} off it, which only a driven lane opens, and the ledger that drove them is not under ${options.root}. A ledger is a lane's whole state and it is gitignored, so booting a second one restores the first one's spent repair budget with nothing recording that a round was granted. Drive the pull request that is already there; a spent budget comes back only through a granted round recorded on the board — \`build clear ${read.pulls[0]}\` on the lane's pull request, or \`lane clear\` on a lane that has none — never a retire and re-open. Nothing was written.`,
					);
				}
			}
		}
		// Last, so a permanent defect — the wrong template for this issue, a child that gets no lane —
		// is named ahead of a cap that will clear on its own the moment a seat frees.
		if (issue !== null) {
			const capped = yield* capRefusal(VERB, options.cap, options.root, options.claimed);
			if (capped !== null) return capped;
		}
		const placed = yield* placeMachine(options, seed.text);
		if (placed._tag === "Exists") {
			return refuse(
				LANE_EXISTS,
				`${VERB}: a lane already exists at ${placed.dir} — resuming needs no boot, so drive the lane that is there (\`fabrika lane status ${options.lane}\`). Removing ${placed.dir} and booting again is not the remedy: the ledger is the lane's whole state and it is gitignored, so the re-boot restores its spent repair budget with nothing recording that a round was granted. A spent budget comes back only through a granted round recorded on the board.`,
			);
		}
		if (placed._tag !== "Placed") return placementRefusal(VERB, placed);
		return answer(
			JSON.stringify({
				answer: "opened",
				lane: options.lane,
				workflow: placed.workflow,
				classes: seed._tag === "Seeded" ? seed.classes : [],
				bytes: new TextEncoder().encode(seed.text).length,
			}),
			[
				seed._tag === "Seeded"
					? `${VERB}: booted ${placed.dir} from ${options.templatePath}, seeded ${renderClasses(seed.classes)}.`
					: `${VERB}: booted ${placed.dir} from ${options.templatePath}.`,
			],
		);
	});
