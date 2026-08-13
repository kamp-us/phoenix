/**
 * `ledger supersede` — retire a child the re-plan no longer contains.
 *
 * Three legs in a fixed order — **comment, unlink, close** — then a re-read proving the child is
 * `closed` with `state_reason` `not_planned` and no longer a sub-issue. The order is load-bearing:
 * closing before unlinking leaves a closed issue still counted as a sub-issue, which the gate reads as
 * a child in scope that can never carry a live assignee (#5026 names that residue as undecided for
 * pre-existing children; this verb simply does not create more of it). The journal comment goes first
 * so the reason survives even if a later leg fails.
 *
 * The two refusals are the guard v1's equivalent had none of: it "closed exactly the numbers you name"
 * with no check at all. A child that is not this epic's is refused, and so is one **this run minted** —
 * a child the current plan just created is not one the current plan supersedes, and letting that
 * through is how a re-plan deletes its own work. A *retained* child is exactly what this verb is for,
 * so the refusal narrows to the minted set rather than the whole manifest.
 */

import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {scannedLine} from "../build/target.ts";
import {createComment} from "../io/issues.ts";
import {isBareAtReference} from "../report/leaks.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	BARE_AT_PATH,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {closeAsNotPlanned, listSubIssueEntries, readChildBack, unlinkSubIssue} from "./github.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";
import {loadManifest, loadRun, maskedLeakRefusal} from "./run-io.ts";

const VERB = "ledger supersede";

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was written.`,
};

export interface SupersedeOptions extends OpenOptions {
	readonly child: number;
	readonly reason: string;
}

export const runSupersede = (
	options: SupersedeOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		if (isBareAtReference(options.reason)) {
			return refuse(
				BARE_AT_PATH,
				`${VERB}: the reason carries a bare @ path reference — it cannot be redacted.`,
			);
		}
		const leaked = maskedLeakRefusal(VERB, "reason", options.reason);
		if (leaked !== null) return leaked;

		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {repo, epic, dir, notes} = ground;

		const run = yield* loadRun(MESSAGES, dir, notes);
		if (run._tag === "Refused") return run.outcome;

		const manifest = yield* loadManifest(MESSAGES, dir, notes);
		if (manifest._tag === "Refused") return manifest.outcome;
		const recorded = manifest.value.find((record) => record.number === options.child);
		if (recorded?.mintedThisRun === true) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: #${options.child} was minted by this run — refusing to supersede a child of the current plan.`,
				notes,
			);
		}

		const children = yield* listSubIssueEntries(repo, epic.number);
		if (children._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`#${epic.number}'s sub-issue list`, children.reason),
				notes,
			);
		}
		const entry = children.value.find((row) => row.number === options.child);
		if (entry === undefined) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: #${options.child} is not a sub-issue of #${epic.number}.`,
				notes,
			);
		}

		const before = yield* readChildBack(repo, options.child);
		if (before._tag === "Absent" || (before._tag === "Present" && before.value.state !== "open")) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: issue #${options.child} is proven absent or closed.`,
				notes,
			);
		}
		if (before._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`#${options.child}`, before.reason),
				notes,
			);
		}

		const unproven = (legs: number, why: string): VerbOutcome =>
			refuse(
				WRITE_UNKNOWN,
				`${VERB}: wrote ${legs} of 3 legs on #${options.child} and could not prove the rest — the child is UNKNOWN.`,
				[...notes, `${VERB}: ${why}.`],
			);

		const journal = yield* createComment(
			repo,
			options.child,
			`Superseded by re-plan of #${epic.number}: ${options.reason}.`,
		);
		if (journal._tag === "Failure") return unproven(0, journal.reason);

		const unlinked = yield* unlinkSubIssue(repo, epic.number, entry.id);
		if (unlinked._tag === "Failure") return unproven(1, unlinked.reason);

		const closed = yield* closeAsNotPlanned(repo, options.child);
		if (closed._tag === "Failure") return unproven(2, closed.reason);

		const after = yield* readChildBack(repo, options.child);
		if (after._tag !== "Present") return unproven(3, "the confirming read failed");
		const siblings = yield* listSubIssueEntries(repo, epic.number);
		if (siblings._tag === "Failure") return unproven(3, siblings.reason);

		const stillLinked = siblings.value.some((row) => row.number === options.child);
		if (
			after.value.state !== "closed" ||
			after.value.stateReason !== "not_planned" ||
			stillLinked
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: #${options.child} does not read back as closed and unlinked — it needs a human eye.`,
				notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "superseded",
				epic: epic.number,
				child: options.child,
				comment: journal.value.id,
				unlinked: true,
				state: after.value.state,
			}),
			[...notes, scannedLine(VERB, 1, "retired child", `${children.value.length} linked before`)],
		);
	});
