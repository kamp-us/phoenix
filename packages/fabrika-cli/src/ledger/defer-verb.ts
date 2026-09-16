/**
 * `ledger defer` — take a child out of a running epic's plan and leave its issue open.
 *
 * The board half of a deferral, and the whole difference from [`supersede-verb.ts`](supersede-verb.ts)
 * is the third leg that is not here: **comment, unlink, and stop**. A superseded child is work the
 * plan abandoned, so it closes `not_planned`; a deferred child is work the founder still wants,
 * moved out of *this* epic's scope, so closing it would delete the follow-up the deferral exists to
 * keep. There is no close endpoint reachable from this module at all — the two verbs share the
 * unlink and the read-back and nothing else.
 *
 * The order is supersede's, load-bearing for the same reason: the journal comment goes first so the
 * reason survives a failed unlink, and the read-back proves the pair rather than reporting the calls
 * as made. What it proves is the *open* state — a child that came back closed is a write nobody here
 * issued, and it needs a person rather than a retry.
 *
 * It reads no staged plan run. A descoped epic is found with its run cleared, which is exactly why
 * `ledger retopology` reads none either; requiring one would make the supported route unreachable in
 * the state it is for.
 */

import {Effect, type FileSystem} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
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
import {listSubIssueEntries, readChildBack, unlinkSubIssue} from "./github.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";
import {maskedLeakRefusal} from "./run-io.ts";

const VERB = "ledger defer";

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was written.`,
};

export interface DeferOptions extends OpenOptions {
	readonly child: number;
	readonly reason: string;
}

export const runDefer = (
	options: DeferOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | HttpClient.HttpClient
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
		if (options.reason.trim() === "") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: the reason says nothing — a deferral records why the plan changed, so nothing was written.`,
			);
		}

		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {repo, epic, notes} = ground;

		const children = yield* listSubIssueEntries(options.env, repo, epic.number);
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
				`${VERB}: #${options.child} is not a sub-issue of #${epic.number} — there is nothing to defer out of this epic.`,
				notes,
			);
		}

		const before = yield* readChildBack(options.env, repo, options.child);
		if (before._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`#${options.child}`, before.reason),
				notes,
			);
		}
		if (before._tag === "Absent" || before.value.state !== "open") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: issue #${options.child} is proven absent or closed — a deferral keeps an OPEN follow-up, and there is none here.`,
				notes,
			);
		}

		const unproven = (legs: number, why: string): VerbOutcome =>
			refuse(
				WRITE_UNKNOWN,
				`${VERB}: wrote ${legs} of 2 legs on #${options.child} and could not prove the rest — the child is UNKNOWN.`,
				[...notes, `${VERB}: ${why}.`],
			);

		const journal = yield* createComment(
			repo,
			options.child,
			`Deferred out of #${epic.number}'s plan: ${options.reason}. This issue stays open as the follow-up; it is no longer a sub-issue of that epic.`,
		);
		if (journal._tag === "Failure") return unproven(0, journal.reason);

		const unlinked = yield* unlinkSubIssue(options.env, repo, epic.number, entry.id);
		if (unlinked._tag === "Failure") return unproven(1, unlinked.reason);

		const after = yield* readChildBack(options.env, repo, options.child);
		if (after._tag !== "Present") return unproven(2, "the confirming read failed");
		const siblings = yield* listSubIssueEntries(options.env, repo, epic.number);
		if (siblings._tag === "Failure") return unproven(2, siblings.reason);

		const stillLinked = siblings.value.some((row) => row.number === options.child);
		if (after.value.state !== "open" || stillLinked) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: #${options.child} does not read back as open and unlinked — it needs a human eye.`,
				notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "deferred",
				epic: epic.number,
				child: options.child,
				comment: journal.value.id,
				unlinked: true,
				state: after.value.state,
			}),
			[...notes, scannedLine(VERB, 1, "deferred child", `${children.value.length} linked before`)],
		);
	});
