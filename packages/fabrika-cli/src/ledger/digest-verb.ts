/**
 * `ledger digest` — print one epic's body digest, staging nothing.
 *
 * The digest the guarded verbs require had exactly one source: `ledger open`, which allocates the
 * run directory, seeds `children.jsonl` and refuses `20` on a tree behind `origin/main`. For
 * `draft` and `write` that is right — they run inside the run `open` allocated. For `ledger
 * retopology` it was a contradiction: that verb's whole claim is that it needs no staged plan run,
 * and the only way to obtain its required `--body-digest` was to stage one. An operator who hit
 * `lane emit`'s `16` mid-drive read a sanctioned route it could not execute.
 *
 * So this verb is the digest and nothing else: `openGround`'s four preconditions, one body read,
 * one value on stdout. It creates no directory, writes no file, and touches no issue — a re-read of
 * the same epic a second later is the same call.
 *
 * It is deliberately not a fifth way to compute the digest: it calls the same {@link bodyDigest}
 * `open`, `draft`, `write` and `retopology` call, so a value printed here and a value recomputed
 * there can only differ because the body moved, which is what `21` is for.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, type VerbOutcome} from "../verb.ts";
import {bodyDigest} from "./digest.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";

const VERB = "ledger digest";

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) =>
		`${VERB}: #${epic} is not a type:epic — no verb in this group is held to its body digest.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — the digest is UNKNOWN.`,
};

export const runDigest = (
	options: OpenOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {epic, notes} = ground;

		const digest = bodyDigest(epic.body);
		return answer(JSON.stringify({answer: "digest", epic: epic.number, bodyDigest: digest}), [
			`${VERB}: #${epic.number}'s body digests to ${digest} — carry it to \`ledger retopology\` before the body moves.`,
			...notes,
		]);
	});
