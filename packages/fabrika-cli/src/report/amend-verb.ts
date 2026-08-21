/**
 * `report amend` — append a dated section to an existing issue's body over the guarded path.
 *
 * **This verb exists because there was no public one, and the hand-rolled call that filled the gap
 * posts a path.** `gh api -X PATCH -f body=@file` takes its value as a raw string, so the literal
 * `@/path/to/file` lands as the whole body and the write returns success — #6708 and #6736 on
 * 2026-08-21. The plumbing was already here; what was missing was a reachable seat for it, since
 * `triage enrich` is stage-scoped and cannot serve an append to an already-triaged issue.
 *
 * The scan reads the appended section only. Redacting the prior body would make an append a rewrite
 * of text this verb never authored, which is the one thing it must never do.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	type Existence,
	getIssue,
	type IssueRecord,
	patchIssueBody,
	resolveRepo,
} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {compose} from "./amend.ts";
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
import {isBareAtReference, renderLeaks, scanBody} from "./leaks.ts";

export interface AmendOptions {
	readonly issue: number;
	readonly redact: boolean;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
	readonly now: () => Date;
}

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * What the read-back found wrong after the PATCH, or `null` when the amendment landed.
 *
 * A read-back that could not be performed folds into the same clause as one that came back wrong, so
 * the verb has a single `READBACK_MISMATCH` message — the shape `report note` and `report file` use.
 */
const readbackMismatch = (
	landed: Existence<IssueRecord>,
	prior: string,
	appended: string,
): string | null => {
	if (landed._tag === "Absent") return "the issue is not readable after the write";
	if (landed._tag === "Unknown") return `the read-back itself failed: ${landed.reason}`;
	const body = normalizeForReadback(landed.value.body);
	// Both halves are the append's whole claim, so both are proven: a landed body missing the prior
	// text is a replacement wearing an append's shape, and GitHub keeps no history to recover it.
	if (!body.includes(normalizeForReadback(appended))) {
		return "the appended amendment is not in the landed body";
	}
	if (!body.includes(normalizeForReadback(prior))) {
		return "the prior body did not survive the write";
	}
	return null;
};

export const runAmend = (
	options: AmendOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, json} = options;

		if (!Number.isInteger(issue) || issue <= 0) {
			return refuse(FAILED, `report amend: --issue ${issue} is not an issue number.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"report amend: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const read = yield* options.stdin;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`report amend: could not read stdin: ${read.reason} — the amendment is UNKNOWN, never empty.`,
			);
		}
		const sent = read._tag === "NoStdin" ? "" : read.text;
		const bytesIn = bytes(sent);
		if (sent.trim() === "") {
			return refuse(
				EMPTY_STDIN,
				bytesIn === 0
					? "report amend: stdin was read and held 0 bytes — refusing to append an empty amendment."
					: `report amend: stdin was read and held ${bytesIn} bytes of whitespace — refusing to append an empty amendment.`,
			);
		}

		if (isBareAtReference(sent)) {
			return refuse(
				BARE_AT_PATH,
				'report amend: the amendment is a bare "@" path reference — the composed section never arrived. Send it on stdin; --redact does not apply.',
			);
		}

		const scan = scanBody(sent);
		if (scan.leaks.length > 0 && !options.redact) {
			return refuse(
				LEAKED_PATH,
				`report amend: the amendment carries ${scan.leaks.length} machine-local path(s) — refusing to append them to a public issue.`,
				renderLeaks(scan.leaks),
			);
		}
		const section = options.redact ? scan.redacted : sent;
		const redactions = options.redact
			? scan.leaks.map((leak) => ({line: leak.line, class: leak.class}))
			: [];
		const redactionNotes = redactions.map(
			(r) => `report amend: redacted a machine-local path — line ${r.line}, ${r.class}`,
		);

		const target = yield* getIssue(repo, issue);
		if (target._tag === "Absent") {
			return refuse(NO_TARGET, `report amend: ${repo} has no issue #${issue}.`);
		}
		if (target._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`report amend: cannot read #${issue} in ${repo}: ${target.reason} — whether the issue exists is UNKNOWN, so nothing was written.`,
			);
		}

		if (target.value.isPullRequest) {
			return refuse(
				NO_TARGET,
				`report amend: #${issue} in ${repo} is a pull request, not an issue — a PR body is written by \`build pr-body\`.`,
			);
		}

		const prior = target.value.body;
		const amendment = compose(prior, section, options.now());

		const scope = `report amend: ${repo}#${issue}, ${bytesIn} byte(s) read, appended to ${bytes(prior)} byte(s) of prior body.`;
		const closed = target.value.state === "closed" ? [`report amend: #${issue} is closed.`] : [];
		const diagnostics = [scope, ...closed, ...redactionNotes];

		const written = yield* patchIssueBody(repo, issue, amendment.body);
		if (written._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`report amend: could not write the body of #${issue}: ${written.reason} — the amendment is UNKNOWN. Re-read the issue before retrying; the append may have landed.`,
				diagnostics,
			);
		}

		const wrong = readbackMismatch(yield* getIssue(repo, issue), prior, amendment.appended);
		if (wrong !== null) {
			return refuse(
				READBACK_MISMATCH,
				`report amend: wrote the body of #${issue} but the read-back is wrong: ${wrong}. The issue exists and needs fixing by hand.`,
				diagnostics,
			);
		}

		return json
			? answer(
					JSON.stringify({
						issue,
						url: target.value.url,
						redactions,
						appendedBytes: bytes(amendment.appended),
						bodyBytes: bytes(amendment.body),
					}),
					diagnostics,
				)
			: answer(`${issue}\t${target.value.url}`, diagnostics);
	});
