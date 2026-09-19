/**
 * `review seat` — this worktree checked out at the epic child's range tip, or a refusal saying why
 * it is not.
 *
 * **The tree a child's reviewer stands on is the wrong tree by default.** A child's build branch is
 * local and unpushed on purpose — one epic run is one branch and one pull request at the tail — so a
 * reviewer worktree cut fresh from the driver's checkout stands on the assembly branch, or on
 * whatever that checkout last held, and the range's tip commit is not in that tree at all. Every
 * fence a reviewer runs against files then reads a tree the verdict never names, and the
 * `range-verdict-marker` records base, tip and a content digest — never which tree the commands ran
 * in — so a wrong verdict is indistinguishable afterwards from a right one. One reviewer caught it
 * mid-run and retracted two posted verdicts; nothing in the machinery forced that catch.
 *
 * **It seats or it refuses; it never falls back to grading in place.** The tip has to be reachable
 * here, and it has to be carried by a branch this clone's own grammar says was cut for this child
 * ({@link childLaneBranches}) — a commit reachable by some other route is not evidence that this
 * child's work is in this tree. Neither condition is a read that failed, so both land on
 * {@link UNREACHABLE_TIP} rather than on the UNKNOWN seat, and the refusal names the range and the
 * ref it could not resolve.
 *
 * **A candidate branch nobody could read decides nothing once another has proven the tip.** Once one
 * lane branch carries it, the seat is determined — the commit is what the tree goes on, and the
 * branch name is only reported — so a later candidate's unreadable ref or containment read is
 * carried as a per-candidate note instead of refusing the whole verb. It becomes
 * {@link PRECONDITION_UNKNOWN} only where no candidate carried the tip and an unread one could have,
 * which is the one shape where the answer actually turns on it.
 *
 * **The seat is detached, and a re-run is not a second checkout.** The reviewer commits nothing, so
 * moving or switching a branch would be a mutation nobody asked for; and a tree already standing on
 * the tip is already seated, which the verb answers by reading HEAD rather than by checking out
 * again. The answer is read back off git after the checkout for the same reason every other verb in
 * this package reads its write back: a `git switch` that reported success and left HEAD elsewhere is
 * exactly the claim the reviewer must not carry into a verdict.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8893
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {childLaneBranches} from "../build/lane.ts";
import {checkoutDetached, localBranches, mergeBase, resolveCommit} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UNREACHABLE_TIP,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {readRangeFlags} from "./range-flags.ts";
import {badNumber} from "./target.ts";

const VERB = "review seat";

export interface SeatOptions {
	/** The epic child whose range this is — what names the branches that may carry the tip. */
	readonly issue: number;
	readonly base: string | null;
	readonly tip: string | null;
	readonly json: boolean;
}

/** What the tree had to do to reach the tip — the field that makes a re-run readable as a no-op. */
type Action = "checked-out" | "already-seated";

/** This tree's HEAD commit, as an object name. */
const headCommit = resolveCommit("HEAD");

export const runSeat = (
	options: SeatOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, json} = options;
		const bad = badNumber(VERB, "an issue number", issue);
		if (bad !== null) return bad;

		const flags = readRangeFlags(VERB, {base: options.base, tip: options.tip, sha: null});
		if (flags._tag === "Refused") return flags.outcome;
		if (flags._tag === "Pull") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --base and --tip are required — the range out of this shell's brief is the subject, and there is no PR here to resolve one from.`,
			);
		}
		const {base, tip} = flags.range;
		const range = `${base}..${tip}`;

		const branches = yield* localBranches;
		if (branches._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read this tree's local branches: ${branches.reason} — whether ${range}'s tip is here is UNKNOWN, so nothing was checked out.`,
			);
		}
		const candidates = childLaneBranches(issue, branches.value);
		if (candidates.length === 0) {
			return refuse(
				UNREACHABLE_TIP,
				`${VERB}: no branch of this clone was cut for #${issue} — "build/${issue}-<slug>-<nonce>" resolves to nothing, so ${range} was built somewhere this worktree cannot see. Grade nothing here; the child's branch is local to the tree that built it.`,
				[`${VERB}: read ${branches.value.length} local branch(es); 0 name #${issue}.`],
			);
		}

		const tipCommit = yield* resolveCommit(tip, ` — the tip of ${range}`);
		if (tipCommit._tag === "Failure") {
			return refuse(
				UNREACHABLE_TIP,
				`${VERB}: ${tipCommit.reason}; ${candidates.join(", ")} carry #${issue}'s commits and this tree holds no object for that tip. Nothing was checked out and nothing here may be graded in place.`,
			);
		}

		const carrying: string[] = [];
		// A candidate that cannot be read is a fact about that candidate, never about the seat. It is
		// kept here and spent at the end, because only an empty `carrying` makes it decide anything:
		// reading it as "not carried" would turn an unreadable object database into a proven absence,
		// and refusing on it while another candidate has already proven the tip would turn a
		// determined seat into a park on a human.
		const unreadable: string[] = [];
		for (const branch of candidates) {
			const branchTip = yield* resolveCommit(branch);
			if (branchTip._tag === "Failure") {
				unreadable.push(`cannot resolve "${branch}": ${branchTip.reason}`);
				continue;
			}
			const shared = yield* mergeBase(branchTip.value, tipCommit.value);
			if (shared._tag === "Failure") {
				unreadable.push(
					`cannot tell whether "${branch}" carries ${tipCommit.value}: ${shared.reason}`,
				);
				continue;
			}
			if (shared.value === tipCommit.value) carrying.push(branch);
		}
		// Several carriers is not ambiguity about the SEAT: every one of them reaches the same commit,
		// and the commit is what the tree is put on. The name is reported, never chosen from.
		const branch = carrying.at(0);
		if (branch === undefined) {
			if (unreadable.length > 0) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: no readable lane branch of #${issue} carries ${range}'s tip and ${unreadable.length} could not be read — ${unreadable.join("; ")} — so whether the tip is here is UNKNOWN and nothing was checked out.`,
				);
			}
			return refuse(
				UNREACHABLE_TIP,
				`${VERB}: ${range}'s tip is in this tree's object database, but no lane branch of #${issue} reaches it — ${candidates.join(", ")} carry other commits. The range this shell was briefed on is not the range these branches hold, so nothing was checked out.`,
			);
		}
		const notes = [
			`${VERB}: ${range} is carried by ${carrying.join(", ")}; seating this tree at ${tipCommit.value}.`,
		];
		if (unreadable.length > 0) {
			notes.push(
				`${VERB}: ${unreadable.length} other candidate branch(es) could not be read — ${unreadable.join("; ")}. The seat was proven without them.`,
			);
		}

		const before = yield* headCommit;
		if (before._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read this tree's HEAD: ${before.reason} — where it stands is UNKNOWN, so nothing was checked out.`,
				notes,
			);
		}
		const action: Action = before.value === tipCommit.value ? "already-seated" : "checked-out";
		if (action === "checked-out") {
			const seated = yield* checkoutDetached(tipCommit.value);
			if (seated._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: \`git switch --detach ${tipCommit.value}\` failed: ${seated.reason} — this tree stood on ${before.value} when the checkout was attempted and where it stands now is UNKNOWN. Read \`git status\` before running anything that reads the working tree.`,
					notes,
				);
			}
		}

		const after = yield* headCommit;
		if (after._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read this tree's HEAD back: ${after.reason} — whether the seat took is UNKNOWN.`,
				notes,
			);
		}
		if (after.value !== tipCommit.value) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the checkout reported success and HEAD reads ${after.value}, not ${tipCommit.value} — this tree is not seated on ${range} and a verdict formed here would name a tree nobody graded.`,
				notes,
			);
		}

		return answer(
			json
				? JSON.stringify({
						answer: "seated",
						issue,
						base,
						tip: tipCommit.value,
						head: after.value,
						branch,
						carriers: carrying,
						action,
					})
				: `seated\t${after.value}\t${branch}\t${action}`,
			[
				...notes,
				action === "already-seated"
					? `${VERB}: this tree already stood on the tip — nothing was checked out.`
					: `${VERB}: HEAD read back at ${after.value}, detached.`,
			],
		);
	});
