/**
 * `ledger write` — splice the staged plan and topology into the epic body, byte-verified.
 *
 * **`mode` is never re-derived here.** It was decided once by `ledger open`, and a `write` that
 * recomputed it from the live body could disagree with the `open` that named the run — which is
 * precisely how the mode-mismatch arm becomes unreachable and a first-time append silently overwrites
 * a real plan.
 *
 * The comparison after the PATCH is over the **whole** normalized body, not a re-extraction of the
 * region: v1 truncated an epic body to end-of-file whenever a `## Dependencies` heading appeared inside
 * the preserved brief, and its round-trip check could not see it because both sides ran the same
 * first-occurrence extractor (#4879). v1 also never checked the PATCH's exit status, so a rejected
 * write, a failed read and a genuine race all printed "a racer clobbered it" — `8`, `9`, `21` and `22`
 * are those four states separated. This verb attempts once and says so.
 */

import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {scannedLine} from "../build/target.ts";
import {getIssue, patchIssueBody} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	EPIC_MOVED,
	NOT_STAGED,
	OFF_VOCABULARY,
	READBACK_MISMATCH,
	REGION_UNRESOLVABLE,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {BODY_DIGEST_RE, bodyDigest} from "./digest.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";
import {splicePlan} from "./region.ts";
import {planPath, topologyPath} from "./run.ts";
import {loadRun, loadStaged} from "./run-io.ts";

const VERB = "ledger write";

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to write a plan into it.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was written.`,
	notAWorktree: `${VERB}: not in a linked worktree — the staged documents are unreachable.`,
};

export interface WriteOptions extends OpenOptions {
	readonly bodyDigest: string;
}

export const runWrite = (
	options: WriteOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		if (!BODY_DIGEST_RE.test(options.bodyDigest)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --body-digest must be 12 lowercase hex — got "${options.bodyDigest}".`,
			);
		}

		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {repo, epic, dir, notes} = ground;

		const run = yield* loadRun(MESSAGES, dir, notes);
		if (run._tag === "Refused") return run.outcome;

		const plan = yield* loadStaged(planPath(dir));
		if (plan === null) {
			return refuse(
				NOT_STAGED,
				`${VERB}: plan.md was never staged in this run — stage it before writing.`,
				notes,
			);
		}
		const topology = yield* loadStaged(topologyPath(dir));
		if (topology === null) {
			return refuse(
				NOT_STAGED,
				`${VERB}: topology.md was never staged in this run — stage it before writing.`,
				notes,
			);
		}

		const observed = bodyDigest(epic.body);
		if (observed !== options.bodyDigest) {
			return refuse(
				EPIC_MOVED,
				`${VERB}: the epic body moved since open (digest ${options.bodyDigest} → ${observed}) — re-open before writing.`,
				notes,
			);
		}

		const spliced = splicePlan({
			epic: epic.number,
			body: epic.body,
			mode: run.value.mode,
			plan,
			topology,
		});
		if (spliced._tag === "Unresolvable") {
			return refuse(REGION_UNRESOLVABLE, `${VERB}: ${spliced.reason}`, notes);
		}

		const patched = yield* patchIssueBody(repo, epic.number, spliced.body);
		if (patched._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the PATCH was issued and could not be confirmed — the body is UNKNOWN.`,
				[...notes, `${VERB}: ${patched.reason}.`],
			);
		}

		const reread = yield* getIssue(repo, epic.number);
		if (reread._tag !== "Present") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the PATCH was issued and could not be confirmed — the body is UNKNOWN.`,
				notes,
			);
		}
		if (normalizeForReadback(reread.value.body) !== normalizeForReadback(spliced.body)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the body was written and does not read back as composed — it needs a human eye.`,
				notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "written",
				epic: epic.number,
				mode: run.value.mode,
				bodyDigest: options.bodyDigest,
				newDigest: bodyDigest(reread.value.body),
				planBytes: new TextEncoder().encode(plan).length,
				topologyBytes: new TextEncoder().encode(topology).length,
				verified: true,
			}),
			[...notes, scannedLine(VERB, 1, "epic body", `mode ${run.value.mode}`)],
		);
	});
