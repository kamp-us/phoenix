/**
 * `eval post` — the single sanctioned path from an eval record to a PR comment.
 *
 * Seven steps, each gating the next: read stdin through the registered format, resolve the PR,
 * compare the record's head against the live one, leak-scan the bytes, sweep the comments
 * count-checked, upsert on `(head, cell)`, and read the comment back from live PR state.
 *
 * The record is posted **exactly as it arrived**. Nothing here composes, normalises or recomputes a
 * field — the score is passed-cases over graded-cases and `wire/eval-record.ts` already re-derives
 * every aggregate from the case blocks beside it (#5258), so a second derivation here could only
 * disagree with the one artifact both sides read. A record whose suite produced no measurement is
 * `UNRECORDABLE` and posts like any other: an explicit failed record beats silence, which reaches a
 * gate as byte-identical to a run that never happened (founder ruling, #4678).
 *
 * Every step is a scar. #3173's hand-rolled `gh api` emit posted garbage and self-reported success,
 * which is why the read-back re-fetches instead of trusting the write call's echo. The `18` refusal
 * is the stale-head class at the write seam. And the `19` refusal is what keeps a short sweep from
 * creating a second comment where an edit was owed — two comments on one `(head, cell)` is exactly
 * what ADR 0253's key forbids.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	type CommentRecord,
	createComment,
	getComment,
	listComments,
	resolveRepo,
} from "../io/issues.ts";
import {getPullRequest, patchComment} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {type EvalRecord, type EvalRecordCell, read as readRecord} from "../wire/eval-record.ts";
import {headSha, sameHead} from "../wire/verdict-marker.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	INCOMPLETE_SCAN,
	LEAKED_PATH,
	MALFORMED_DOCUMENT,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_HEAD,
	TARGET_ABSENT,
	WRITE_UNKNOWN,
} from "./codes.ts";

const VERB = "eval post";

export interface PostOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

/** The cell as the answer line spells it: `<stage>` or `<stage>/<surface>`. */
const cellLabel = (cell: EvalRecordCell): string =>
	cell.surface === null || cell.surface === "" ? cell.stage : `${cell.stage}/${cell.surface}`;

/** ADR 0243 §4's key in full — a model swap is a different cell, not a newer reading of this one. */
const sameCell = (a: EvalRecordCell, b: EvalRecordCell): boolean =>
	a.stage === b.stage && a.surface === b.surface && a.model === b.model;

const scannedLine = (scanned: number): string =>
	`${VERB}: scanned ${scanned} comment${scanned === 1 ? "" : "s"}.`;

/**
 * Why the read-back does not show what was posted, or `null` when it does.
 *
 * Both halves are needed. The **fields** go through the format's own `read`, which is what proves the
 * comment carries *this* record rather than some record; the **whole body** is then compared against
 * the bytes that were sent, because a marker line that parses says nothing about the payload under
 * it. `normalizeForReadback` is imported rather than re-derived for one specific reason: its
 * trailing-newline step is the one a re-derivation drops, and dropping it fires `9` on clean runs.
 */
const mismatchOf = (body: string, record: EvalRecord, sent: string): string | null => {
	const normalized = normalizeForReadback(body);
	const parsed = readRecord(normalized);
	if (parsed._tag !== "Found") return parsed.reason;
	const back = parsed.value;
	if (!sameHead(back.sha, record.sha)) return `sha ${back.sha}, expected ${record.sha}`;
	if (back.outcome !== record.outcome) return `token ${back.outcome}, expected ${record.outcome}`;
	if (!sameCell(back.payload.cell, record.payload.cell)) {
		return `cell ${cellLabel(back.payload.cell)} on ${back.payload.cell.model}, expected ${cellLabel(record.payload.cell)} on ${record.payload.cell.model}`;
	}
	return normalized === normalizeForReadback(sent)
		? null
		: "the comment's bytes are not the ones that were sent";
};

export const runPost = (
	options: PostOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		if (!Number.isInteger(pr) || pr <= 0) {
			return refuse(FAILED, `${VERB}: ${pr} is not a pull-request number.`);
		}

		// Step 1 — the record arrives through the registered format, and an unread pipe is never empty.
		const read = yield* options.stdin;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`${VERB}: could not read stdin: ${read.reason} — the record is UNKNOWN, never empty.`,
			);
		}
		const bytes = read._tag === "NoStdin" ? "" : read.text;
		if (bytes.trim() === "") {
			return refuse(
				EMPTY_STDIN,
				`${VERB}: no record on stdin — pipe the bytes eval graded emitted.`,
				[`${VERB}: stdin was read and held ${new TextEncoder().encode(bytes).length} byte(s).`],
			);
		}
		if (isBareAtReference(bytes)) {
			return refuse(
				BARE_AT_PATH,
				`${VERB}: the body is a bare "@" path reference — the record never arrived. Pipe its bytes on stdin.`,
			);
		}
		const parsed = readRecord(bytes);
		if (parsed._tag !== "Found") {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: stdin does not read as an eval record (absent or malformed: ${parsed.reason}) — post the emitted bytes, never a hand-assembled comment.`,
			);
		}
		const record = parsed.value;

		const target = yield* resolveRepo(options.repo, options.env);
		if (target._tag === "Failure") {
			return refuse(
				FAILED,
				`${VERB}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.`,
			);
		}
		const repo = target.value;
		const unreadable = (what: string, reason: string): VerbOutcome =>
			refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${what} for #${pr}: ${reason} — nothing was posted.`,
			);

		// Step 2 — a 404 and an unreachable GitHub are different facts, and only the first is proven.
		const found = yield* getPullRequest(repo, pr);
		if (found._tag === "Absent") {
			return refuse(TARGET_ABSENT, `${VERB}: PR #${pr} not found in ${repo}.`);
		}
		if (found._tag === "Unknown") return unreadable("the PR", found.reason);
		const pull = found.value;
		if (pull.state !== "open") {
			return refuse(
				TARGET_ABSENT,
				`${VERB}: PR #${pr} is closed — a record there enters no series; post on the PR that carries this head.`,
			);
		}

		// Step 3 — the record measured a tree; if the PR has left it, the suite is re-run, never re-bound.
		const live = headSha(pull.headSha);
		if (live === null) {
			return unreadable("the live head", `"${pull.headSha.trim()}" is not a head SHA`);
		}
		if (!sameHead(record.sha, live)) {
			return refuse(
				STALE_HEAD,
				`${VERB}: PR #${pr}'s head is ${live}, not ${record.sha} — the tree this record measured is gone; re-run the suite at ${live}, never re-bind (ADR 0253).`,
			);
		}

		// Step 4 — the scan runs over the bytes that will be posted, so nothing reaches the PR unscanned.
		const scan = scanBody(bytes);
		const leak = scan.leaks[0];
		if (leak !== undefined) {
			return refuse(
				LEAKED_PATH,
				`${VERB}: the record carries a machine-local path at line ${leak.line} (${leak.class}) — a transcriptPath is machine-local and perishable; strip it (ADR 0273).`,
				renderLeaks(scan.leaks),
			);
		}

		// Step 5 — the sweep is the upsert's evidence, so a provably short one refuses rather than creates.
		const listed = yield* listComments(repo, pr);
		if (listed._tag === "Failure") return unreadable("the comments", listed.reason);
		const swept = listed.value;
		if (swept.length < pull.comments) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${swept.length} of ${pull.comments} declared comments on #${pr} — refusing the partial sweep; a blind create could shadow the edit this record owes.`,
			);
		}

		const notices: Array<string> = [];
		const matches: Array<CommentRecord> = [];
		for (const comment of swept) {
			const carried = readRecord(comment.body);
			// A comment that reaches for the format and fails it is named rather than dropped: it may be
			// the very comment this record owes an edit to, garbled, and a silent skip would duplicate it.
			if (carried._tag === "Malformed") {
				notices.push(
					`${VERB}: comment ${comment.id} reaches for the eval-record format and fails it: ${carried.reason}.`,
				);
				continue;
			}
			if (carried._tag !== "Found") continue;
			if (
				sameHead(carried.value.sha, record.sha) &&
				sameCell(carried.value.payload.cell, record.payload.cell)
			) {
				matches.push(comment);
			}
		}
		const diagnostics = [scannedLine(swept.length), ...notices];

		// Step 6 — one comment per `(head, cell)` (ADR 0253), the newest in force. The list arrives
		// oldest-first, so the last match is the one a reader would be looking at.
		const held = matches.at(-1);
		let landed: {readonly id: number; readonly url: string} | null = null;
		let failure: string | null = null;
		if (held === undefined) {
			const created = yield* createComment(repo, pr, bytes);
			if (created._tag === "Failure") failure = created.reason;
			else landed = {id: created.value.id, url: created.value.url};
		} else {
			const edited = yield* patchComment(repo, held.id, bytes);
			if (edited._tag === "Failure") failure = edited.reason;
			else landed = {id: held.id, url: edited.value};
		}
		if (landed === null) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: create/edit failed: ${failure ?? "unknown"} — UNKNOWN whether the record landed; sweep the PR's comments before retrying.`,
				diagnostics,
			);
		}
		const upsert = held === undefined ? "created" : "edited";

		// Step 7 — read it back from live state. The write call's own echo is not evidence (#3173).
		const back = yield* getComment(repo, landed.id);
		const mismatch = back._tag === "Failure" ? back.reason : mismatchOf(back.value, record, bytes);
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: posted, but the read-back does not yield this record (${mismatch}) — the PR may carry a garbled record; inspect comment ${landed.id} before re-running, since a garbled comment does not match the upsert key.`,
				diagnostics,
			);
		}

		return json
			? answer(
					JSON.stringify({
						outcome: "posted",
						token: record.outcome,
						sha: record.sha,
						cell: record.payload.cell,
						upsert,
						commentUrl: landed.url,
						scanned: swept.length,
					}),
					diagnostics,
				)
			: answer(
					`posted\t${record.outcome}\t${record.sha}\t${cellLabel(record.payload.cell)}\t${upsert}\t${landed.url}`,
					diagnostics,
				);
	});
