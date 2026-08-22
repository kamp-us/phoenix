/**
 * `report note` — add a note to an existing issue over the same guarded path.
 *
 * **This verb exists because the skill tells its caller to comment on a duplicate rather than file
 * a twin.** A skill that says that without providing a guarded path sends the caller to a
 * hand-rolled posting call — which is the exact call #3945 and #3173 each made, and both of those
 * incidents were comment posts, not issue creates.
 *
 * A note is free prose: no section template applies and no footer is appended. Stated in code as
 * well as in the contract because the sibling verb does both.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, getIssue, resolveRepo} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {normalizeForReadback} from "./compose.ts";
import {isBareAtReference, redactionTally, renderLeaks, scanBody} from "./leaks.ts";

export interface NoteOptions {
	readonly issue: number;
	readonly redact: boolean;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runNote = (
	options: NoteOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, json} = options;

		if (!Number.isInteger(issue) || issue <= 0) {
			return refuse(FAILED, `report note: --issue ${issue} is not an issue number.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"report note: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const read = yield* options.stdin;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`report note: could not read stdin: ${read.reason} — the note is UNKNOWN, never empty.`,
			);
		}
		const note = read._tag === "NoStdin" ? "" : read.text;
		const bytesIn = new TextEncoder().encode(note).length;
		if (note.trim() === "") {
			return refuse(
				EMPTY_STDIN,
				bytesIn === 0
					? "report note: stdin was read and held 0 bytes — refusing to post an empty note."
					: `report note: stdin was read and held ${bytesIn} bytes of whitespace — refusing to post an empty note.`,
			);
		}

		if (isBareAtReference(note)) {
			return refuse(
				BARE_AT_PATH,
				'report note: the note is a bare "@" path reference — the composed note never arrived. Send it on stdin; --redact does not apply.',
			);
		}

		const scan = scanBody(note);
		if (scan.leaks.length > 0 && !options.redact) {
			return refuse(
				LEAKED_PATH,
				`report note: the note carries ${scan.leaks.length} machine-local path(s) — refusing to post them to a public issue.`,
				renderLeaks(scan.leaks),
			);
		}
		const body = options.redact ? scan.redacted : note;
		const redacted = options.redact ? scan.leaks : [];
		const redactions = redactionTally(redacted);
		const redactionNotes = redacted.map(
			(leak) => `report note: redacted a machine-local path — line ${leak.line}, ${leak.class}`,
		);

		const target = yield* getIssue(repo, issue);
		if (target._tag === "Absent") {
			return refuse(NO_TARGET, `report note: ${repo} has no issue #${issue}.`);
		}
		if (target._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`report note: cannot read #${issue} in ${repo}: ${target.reason} — whether the issue exists is UNKNOWN, so nothing was posted.`,
			);
		}

		const scope = `report note: ${repo}#${issue}, ${bytesIn} byte(s) read.`;
		// A closed issue is not a refusal — a note on one is sometimes exactly right — but the caller
		// is never left surprised by where the note landed.
		const closed = target.value.state === "closed" ? [`report note: #${issue} is closed.`] : [];
		const diagnostics = [scope, ...closed, ...redactionNotes];

		const posted = yield* createComment(repo, issue, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`report note: could not post the comment on #${issue}: ${posted.reason} — the note is UNKNOWN. Re-read the issue before re-posting; the comment may have landed.`,
				diagnostics,
			);
		}

		// #3173 is precisely a posted comment whose landed body was not what the poster believed it
		// had sent, reported upward as a success — so a post that is not verified is not finished.
		const landed = yield* getComment(repo, posted.value.id);
		const mismatch =
			landed._tag === "Failure"
				? `the read-back itself failed: ${landed.reason}`
				: normalizeForReadback(landed.value) === normalizeForReadback(body)
					? null
					: "the landed body differs from what was sent";
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`report note: posted comment ${posted.value.id} on #${issue} but the read-back is wrong: ${mismatch}. The comment exists and needs fixing by hand.`,
				diagnostics,
			);
		}

		return json
			? answer(
					JSON.stringify({
						id: posted.value.id,
						url: posted.value.url,
						issue,
						redactions,
						bodyBytes: new TextEncoder().encode(body).length,
					}),
					diagnostics,
				)
			: answer(`${posted.value.id}\t${posted.value.url}`, diagnostics);
	});
