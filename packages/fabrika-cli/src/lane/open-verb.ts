/**
 * `lane open` — boot one single-issue lane from the committed coder template.
 *
 * **Byte-identical when no class stands, and seeded when one does.** The names ride the expectation
 * read's own payload ([`expectation.ts`](expectation.ts)), and [`class-seed.ts`](class-seed.ts)
 * writes them into the bytes placed and carries the why. An off-set spelling refuses on
 * {@link CLASS_UNRECOGNISED} before placement.
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
 * **That refusal has one arm, and the board opens it: `--from-board`.** A prior ledger written on
 * another operator's machine is unreachable forever, so the refusal used to leave finished, verified
 * work with no verb that moved it — and the only moves left were the two `operate` forbids. Under
 * the flag the boot is admitted by [`board-seat.ts`](board-seat.ts): exactly one open pull request,
 * every namespace its head derives answered, on `lane prove`'s own fold. The placed document then
 * declares the repair budget **spent**, because the board proves the work is verified and proves
 * nothing at all about how many rounds the prior lane burned — so this boot mints none, and the
 * adoption is recorded on the issue before anything lands on disk. Everything the board does not
 * prove refuses at {@link PRIOR_LANE} exactly as it did.
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
import {
	adoptionRecord,
	type BoardRecorder,
	type BoardSeatReader,
	spendBudget,
	strandedRecord,
} from "./board-seat.ts";
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
import {placementRefusal, say} from "./refusals.ts";
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

/**
 * The prior-lane refusal, and the three routes it names.
 *
 * `--from-board` is named first because it is the only one that reaches the case this refusal was
 * blind to — a ledger on another operator's machine, which no clearance can produce — and the two
 * grants stay exactly where they were for the case they answer, a budget this checkout can see was
 * spent.
 */
const priorRefusal = (
	verb: string,
	issue: number,
	pulls: ReadonlyArray<number>,
	root: string,
): string =>
	`${verb}: #${issue} already had a lane — the board hangs ${pulls.length === 1 ? "pull request" : "pull requests"} ${pulls.map((pull) => `#${pull}`).join(", ")} off it, which only a driven lane opens, and the ledger that drove them is not under ${root}. A ledger is a lane's whole state and it is gitignored, so booting a second one restores the first one's spent repair budget with nothing recording that a round was granted. Drive the pull request that is already there. Where that prior ledger is unreachable — it was written on another operator's machine, so no clearance can produce it — \`fabrika lane open ${issue} --from-board\` boots a lane the board admits: one open pull request with every namespace its head derives answered, seated with its repair budget declared spent and the adoption recorded on the issue. A spent budget itself comes back only through a granted round recorded on the board — \`lane clear\`, which grants the lane's round and its pull request's together, or \`build clear ${pulls[0] ?? issue}\` for a founder's bare PR-side grant — never a retire and re-open. Nothing was written.`;

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
	 * Whether the operator asked for the board-seated boot — `--from-board`, and false by default.
	 *
	 * It reaches the prior-lane arm and nothing else: a fresh issue boots exactly as it always did
	 * whether or not the flag is on, so the flag can only ever widen the one refusal it is for.
	 */
	readonly fromBoard: boolean;
	/**
	 * The admission read, or `null` for the offline boot a caller gets by passing none.
	 *
	 * Asked only where the prior-lane refusal would fire and only under {@link fromBoard}, so the
	 * ordinary boot pays for no verdict read at all.
	 */
	readonly boardSeat: BoardSeatReader<R> | null;
	/**
	 * Where the adoption is recorded — the board, through a caller-passed writer.
	 *
	 * It runs BEFORE the placement, because a boot whose record did not land is a lane nobody can
	 * review afterwards, and the record is the whole difference between this arm and the laundering
	 * the refusal exists to stop.
	 */
	readonly record: BoardRecorder<R> | null;
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
		// What the board-seated arm decided, or `null` on every boot that never reached it — the one
		// carrier between the prior-lane read above and the placement below, so the bytes placed and
		// the answer printed cannot disagree about whether this lane was seated.
		let seated: {readonly pr: number; readonly head: string; readonly text: string} | null = null;
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
					if (!options.fromBoard || options.boardSeat === null) {
						return refuse(PRIOR_LANE, priorRefusal(VERB, issue, read.pulls, options.root));
					}
					const seat = yield* options.boardSeat(issue, read.pulls);
					if (seat._tag === "Unknown") {
						return refuse(
							LANE_UNREADABLE,
							`${VERB}: whether the board verifies #${issue}'s pull request is UNKNOWN: ${seat.reason} — refusing to seat a lane over a read nobody made. Nothing was written.`,
						);
					}
					if (seat._tag === "Unproven") {
						return refuse(
							PRIOR_LANE,
							`${VERB}: #${issue} already had a lane, and \`--from-board\` read the board rather than trusting the flag: ${seat.why}. A seat is derived from a verified pull request or from nothing, and a spent repair budget comes back only through a granted round recorded on the board — \`lane clear\`, or \`build clear ${read.pulls[0] ?? issue}\` for a founder's bare PR-side grant. Nothing was written.`,
						);
					}
					const spent = spendBudget(seed.text);
					if (spent._tag === "Unseedable") {
						return refuse(
							LANE_UNREADABLE,
							`${VERB}: cannot declare the repair budget spent in ${options.templatePath}: ${spent.reason} — a seat that mints an unproven budget is the laundering this arm exists not to be. Nothing was written.`,
						);
					}
					seated = {pr: seat.pr, head: seat.head, text: spent.text};
				}
			}
		}
		// Last, so a permanent defect — the wrong template for this issue, a child that gets no lane —
		// is named ahead of a cap that will clear on its own the moment a seat frees.
		if (issue !== null) {
			const capped = yield* capRefusal(VERB, options.cap, options.root, options.claimed);
			if (capped !== null) return capped;
		}
		// After the cap, so a capped boot records no adoption it never took; before the placement,
		// because an unrecorded seat is one no reader can review, and reviewability is this arm's
		// whole warrant.
		let record: string | null = null;
		if (seated !== null && issue !== null) {
			if (options.record === null) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: \`--from-board\` was asked for with no way to record the adoption on #${issue} — the record is what makes the seat reviewable, so nothing was booted.`,
				);
			}
			const wrote = yield* options.record(issue, adoptionRecord(issue, seated.pr, seated.head));
			if (wrote._tag === "Unrecorded") {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: the adoption record did not land on #${issue}: ${wrote.reason} — nothing was booted, so re-run once the board is writable.`,
				);
			}
			record = wrote.url;
		}
		// Every arm below this point refused *after* the record landed, so each one carries it: the
		// board keeps a comment naming a succession the disk never took, and only the refusal can say so.
		const stranded = strandedRecord(record);
		const placed = yield* placeMachine(options, seated === null ? seed.text : seated.text);
		if (placed._tag === "Exists") {
			return refuse(
				LANE_EXISTS,
				say(
					`${VERB}: a lane already exists at ${placed.dir} — resuming needs no boot, so drive the lane that is there (\`fabrika lane status ${options.lane}\`). Removing ${placed.dir} and booting again is not the remedy: the ledger is the lane's whole state and it is gitignored, so the re-boot restores its spent repair budget with nothing recording that a round was granted. A spent budget comes back only through a granted round recorded on the board.`,
					...stranded,
				),
			);
		}
		if (placed._tag !== "Placed") return placementRefusal(VERB, placed, stranded);
		const text = seated === null ? seed.text : seated.text;
		return answer(
			JSON.stringify({
				answer: "opened",
				lane: options.lane,
				workflow: placed.workflow,
				classes: seed._tag === "Seeded" ? seed.classes : [],
				bytes: new TextEncoder().encode(text).length,
				...(seated === null
					? {}
					: {fromBoard: {pr: seated.pr, head: seated.head, maxRetries: 0, record}}),
			}),
			[
				seed._tag === "Seeded"
					? `${VERB}: booted ${placed.dir} from ${options.templatePath}, seeded ${renderClasses(seed.classes)}.`
					: `${VERB}: booted ${placed.dir} from ${options.templatePath}.`,
				...(seated === null
					? []
					: [
							`${VERB}: seated from the board on #${seated.pr} at ${seated.head}, with the repair budget declared spent — a FAIL parks at human:budget-spent until \`lane clear\` grants a round.`,
							`${VERB}: the adoption is recorded at ${record}. The lane stands at its initial state: walk it with \`fabrika lane transition ${options.lane} <event>\`, which proves every event against the board before it records one.`,
						]),
			],
		);
	});
