/**
 * `spike capture` — post the decision plus the log's own run table, read it back, and close the spike.
 *
 * **Zero recorded runs reds** (`14`): "I ran nothing and it worked" is a pass this verb must never
 * emit (ADR 0092), and it is the precondition the verb most exists for — a decision with no recorded
 * run is a self-report, not evidence (#4111).
 *
 * **The ACL gate precedes every write on every path, the idempotent one included** (ADR 0055),
 * because a close is a write and authority is checked before writes rather than around them. A
 * permission read that fails is `11` — UNKNOWN, never a grant and never a demotion.
 *
 * **The re-entry story is the marker branch.** A marker whose digest equals the current one means the
 * decision already covers the log, so nothing is posted and the stdin just read is **discarded** —
 * re-wording a decision without recording a new run changes nothing, and a caller who meant to revise
 * must run something first so the digest moves. A marker whose digest differs means runs were
 * recorded after that decision, so a superseding comment is posted and the spike closes either way:
 * that is what makes `spike dispose`'s `21` a detour rather than a trap.
 */

import {Effect} from "effect";
import {closeCompleted, createComment, getComment, getIssue, listComments} from "../io/issues.ts";
import {permissionFor, viewerLogin} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {readAuthored} from "../review/authored.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {captureComment, newestCapture} from "./bodies.ts";
import {
	AUTHOR_UNAUTHORIZED,
	NO_EVIDENCE,
	READ_OR_EXEC_UNKNOWN,
	READBACK_MISMATCH,
	WORKSPACE_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	leakFree,
	nonceGrammar,
	readEvidence,
	readManifest,
	type SpikeEffect,
	targetRepo,
} from "./guards.ts";
import {workspacePath} from "./workspace.ts";

export interface CaptureOptions {
	readonly spike: number;
	readonly nonce: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly tmpRoot: string;
	/** The fd-0 read, injected so the failed-read and TTY paths are testable without a descriptor. */
	readonly stdin: Effect.Effect<StdinRead>;
}

const VERB = "spike capture";

/** The permissions that may record a decision on the record. */
const AUTHORIZED = new Set(["admin", "maintain", "write"]);

export const runCapture = (options: CaptureOptions): SpikeEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const grammar = nonceGrammar(VERB, options.nonce, "");
		if (grammar !== null) return grammar;

		const read = yield* options.stdin;
		const authored = readAuthored(
			{
				verb: VERB,
				noun: "the decision",
				emptyMessage: `${VERB}: stdin was read and held nothing — a spike with no decision has captured nothing.`,
				bareAtMessage: `${VERB}: the decision is a bare @ path reference — write the decision, not a pointer to it.`,
				leakCorrection: "Describe what the path was; do not paste it.",
			},
			read,
		);
		if (authored._tag === "Refused") return authored.outcome;
		const leaked = leakFree(VERB, "decision", authored.text);
		if (leaked !== null) return leaked;

		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const workspace = workspacePath(options.tmpRoot, options.nonce);
		const manifest = yield* readManifest(
			VERB,
			workspace,
			options.nonce,
			"the evidence a decision would rest on is gone.",
		);
		if (manifest._tag === "Refused") return manifest.outcome;
		if (manifest.value.spike !== null && manifest.value.spike !== options.spike) {
			return refuse(
				WORKSPACE_MISMATCH,
				`${VERB}: the manifest for nonce ${options.nonce} names spike #${manifest.value.spike}, not #${options.spike} — the evidence does not belong to this spike.`,
			);
		}

		const evidence = yield* readEvidence(VERB, workspace);
		if (evidence._tag === "Refused") return evidence.outcome;
		if (evidence.value.records.length === 0 || evidence.value.digest === null) {
			return refuse(
				NO_EVIDENCE,
				`${VERB}: the evidence log holds zero recorded runs — a decision with no recorded run is a self-report, not evidence (#4111). Run something through spike run, or dispose with --forfeit.`,
			);
		}
		const evidenceDigest = evidence.value.digest;

		const issue = yield* getIssue(repo, options.spike);
		if (issue._tag === "Absent") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: spike #${options.spike} is proven absent — nothing to capture onto; check the number.`,
			);
		}
		if (issue._tag === "Unknown") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read spike #${options.spike}: ${issue.reason} — nothing was posted, and authority is UNKNOWN, never granted.`,
			);
		}
		const comments = yield* listComments(repo, options.spike);
		if (comments._tag === "Failure") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read the comments of spike #${options.spike}: ${comments.reason} — nothing was posted, and authority is UNKNOWN, never granted.`,
			);
		}

		const login = yield* viewerLogin;
		if (login._tag === "Failure") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read the authenticated login: ${login.reason} — nothing was posted, and authority is UNKNOWN, never granted.`,
			);
		}
		const permission = yield* permissionFor(repo, login.value);
		if (permission._tag === "Unknown") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read the repository permission of ${login.value}: ${permission.reason} — nothing was posted, and authority is UNKNOWN, never granted.`,
			);
		}
		const held = permission._tag === "Absent" ? "no collaborator role" : permission.value;
		if (permission._tag === "Absent" || !AUTHORIZED.has(permission.value)) {
			return refuse(
				AUTHOR_UNAUTHORIZED,
				`${VERB}: ${login.value} holds ${held} on ${repo}, below write — a decision recorded here would carry no authority (ADR 0055).`,
			);
		}

		const marker = newestCapture(comments.value, options.nonce);
		const closed = issue.value.state === "closed";
		const scope = `${VERB}: ${repo}, spike #${options.spike}, nonce ${options.nonce}, ${evidence.value.records.length} recorded run(s), ${comments.value.length} comment(s) scanned.`;

		if (marker === null && closed) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: spike #${options.spike} is closed and carries no capture marker for nonce ${options.nonce} — there is nothing to supersede. Open a new spike for a new question.`,
				[scope],
			);
		}

		if (marker !== null && marker.evidenceDigest === evidenceDigest) {
			// The decision on the record already covers this exact log, so the bytes just read on stdin
			// are discarded rather than posted a second time. The answer says so; the verb only ensures
			// the close, which is what makes a re-run after a failed close safe.
			const ensured = yield* ensureClosed(repo, options.spike, closed, marker.commentId, scope);
			return (
				ensured ??
				answer(
					JSON.stringify({
						spike: options.spike,
						nonce: options.nonce,
						commentId: marker.commentId,
						runs: evidence.value.records.length,
						evidenceDigest,
						state: "closed",
						discardedStdin: true,
					}),
					[scope],
				)
			);
		}

		const body = captureComment({
			nonce: options.nonce,
			evidenceDigest,
			decision: authored.text,
			records: evidence.value.records,
		});
		const composed = leakFree(VERB, "composed capture comment", body);
		if (composed !== null) return {...composed, stderr: [scope, ...composed.stderr]};

		const posted = yield* createComment(repo, options.spike, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the comment post failed: ${posted.reason} — it may or may not have landed; read spike #${options.spike} before re-running.`,
				[scope],
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		if (
			back._tag === "Failure" ||
			normalizeForReadback(back.value) !== normalizeForReadback(body)
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the comment landed but does not read back as sent — it needs a human eye.`,
				[scope],
			);
		}

		const ensured = yield* ensureClosed(repo, options.spike, closed, posted.value.id, scope);
		return (
			ensured ??
			answer(
				JSON.stringify({
					spike: options.spike,
					nonce: options.nonce,
					commentId: posted.value.id,
					runs: evidence.value.records.length,
					evidenceDigest,
					state: "closed",
					discardedStdin: false,
				}),
				[scope],
			)
		);
	});

/**
 * Close the spike unless it is already closed, returning the refusal a failed close earns.
 *
 * The message states that the decision **did** land: a close that could not be proven leaves the
 * record correct and only the state wrong, and a caller told otherwise would re-post.
 */
const ensureClosed = (
	repo: string,
	spike: number,
	alreadyClosed: boolean,
	commentId: number,
	scope: string,
): SpikeEffect<VerbOutcome | null> =>
	Effect.gen(function* () {
		if (alreadyClosed) return null;
		const closed = yield* closeCompleted(repo, spike);
		return closed._tag === "Failure"
			? refuse(
					WRITE_UNKNOWN,
					`${VERB}: the decision landed as comment ${commentId} but the close failed: ${closed.reason} — the decision IS on the record; re-run to close.`,
					[scope],
				)
			: null;
	});
