/**
 * `report file` — compose the intake issue, guard it, create it, and read back what landed.
 *
 * **One transaction.** Every step is a precondition or a postcondition of *this observation is now
 * an issue in the intake queue*, and splitting them would hand a caller the chance to skip one.
 *
 * The check order is local-first: everything decidable from the bytes on stdin runs before any
 * network read, so a refusable body costs no API call and a refusal always names the cheapest
 * correctable thing first.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	createIssue,
	currentBranch,
	type Existence,
	getIssue,
	type IssueRecord,
	listLabels,
	resolveRepo,
} from "../io/issues.ts";
import {sessionIdFrom} from "../io/session-id.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	CLASSIFIED,
	EMPTY_STDIN,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	checkSections,
	classifyingPrefix,
	composeBody,
	deriveVocabulary,
	labelKind,
	normalizeForReadback,
	REQUIRED_SECTIONS,
	renderFooter,
} from "./compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "./leaks.ts";

export interface FileOptions {
	readonly title: string;
	readonly label: string;
	readonly redact: boolean;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The fd-0 read, injected so the failed-read and TTY paths are testable without a descriptor. */
	readonly stdin: Effect.Effect<StdinRead>;
	/** The footer's timestamp, injected so a filing is byte-reproducible in a test. */
	readonly now: () => Date;
}

const utc = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

/**
 * What the read-back found wrong, or `null` when the issue landed as composed.
 *
 * Four assertions, in the order a failure is most likely to explain the rest: it exists; it carries
 * `--label` and only that label; its body carries the never-dropped marker and all six headings;
 * and its body matches what was composed under the normalised comparison.
 */
export const readbackMismatch = (
	landed: Existence<IssueRecord>,
	label: string,
	composed: string,
): string | null => {
	if (landed._tag === "Absent") return "the issue is not readable after the create";
	if (landed._tag === "Unknown") return `the read-back itself failed: ${landed.reason}`;
	const issue = landed.value;
	if (issue.labels.length !== 1 || issue.labels[0] !== label) {
		return `it carries labels [${issue.labels.join(", ")}] rather than exactly "${label}"`;
	}
	if (!issue.body.includes("Filed by an agent")) {
		return "the body is missing the `Filed by an agent` marker";
	}
	const missing = REQUIRED_SECTIONS.find((heading) => !issue.body.includes(heading));
	if (missing !== undefined) return `the body is missing section "${missing}"`;
	return normalizeForReadback(issue.body) === normalizeForReadback(composed)
		? null
		: "the landed body differs from what was composed";
};

export const runFile = (
	options: FileOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {label, json, title} = options;

		if (title.trim() === "") {
			return refuse(FAILED, "report file: --title is empty — refusing to file an untitled report.");
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"report file: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const read = yield* options.stdin;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`report file: could not read stdin: ${read.reason} — the body is UNKNOWN, never empty.`,
			);
		}
		// A TTY with nothing piped in never reached a read, but the caller's correction is identical
		// to an empty pipe's — send the body — and nothing was proven UNKNOWN, so it seats here rather
		// than on the failed-read code.
		const sections = read._tag === "NoStdin" ? "" : read.text;
		const bytesIn = new TextEncoder().encode(sections).length;
		if (sections.trim() === "") {
			return refuse(
				EMPTY_STDIN,
				bytesIn === 0
					? "report file: stdin was read and held 0 bytes — refusing to file a bodyless issue."
					: `report file: stdin was read and held ${bytesIn} bytes of whitespace — refusing to file a bodyless issue.`,
			);
		}

		if (isBareAtReference(sections)) {
			return refuse(
				BARE_AT_PATH,
				'report file: the body is a bare "@" path reference — the composed body never arrived. Send it on stdin; --redact does not apply.',
			);
		}

		const problem = checkSections(sections);
		if (problem !== null) {
			return refuse(
				BAD_SECTIONS,
				problem._tag === "Missing"
					? `report file: section "${problem.heading}" is missing.`
					: problem._tag === "Empty"
						? `report file: section "${problem.heading}" is empty.`
						: `report file: sections are out of order — "${problem.heading}" follows "${problem.after}".`,
			);
		}

		const footer = renderFooter({
			session: sessionIdFrom(options.env),
			model: options.env.ANTHROPIC_MODEL ?? options.env.CLAUDE_MODEL ?? null,
			branch: yield* currentBranch,
			timestamp: utc(options.now()),
		});
		// Scanned after composition, so nothing the verb itself appends can escape the predicate.
		const composed = composeBody(sections, footer);
		const scan = scanBody(composed);
		if (scan.leaks.length > 0 && !options.redact) {
			return refuse(
				LEAKED_PATH,
				`report file: the body carries ${scan.leaks.length} machine-local path(s) — refusing to post them to a public issue.`,
				renderLeaks(scan.leaks),
			);
		}
		const body = options.redact ? scan.redacted : composed;
		const redactions = options.redact
			? scan.leaks.map((leak) => ({line: leak.line, class: leak.class}))
			: [];
		const redactionNotes = redactions.map(
			(r) => `report file: redacted a machine-local path — line ${r.line}, ${r.class}`,
		);

		const labels = yield* listLabels(repo);
		if (labels._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`report file: cannot read the label set of ${repo}: ${labels.reason} — whether "${label}" exists is UNKNOWN, so nothing was filed.`,
			);
		}
		if (!labels.value.includes(label)) {
			return refuse(
				NO_TARGET,
				`report file: ${repo} has no "${label}" label — the issue would be filed outside the intake queue. Create the label, then re-run.`,
			);
		}

		const vocabulary = deriveVocabulary(labels.value);
		const kind = labelKind(label, vocabulary);
		if (kind !== null) {
			return refuse(
				CLASSIFIED,
				`report file: --label "${label}" is a ${kind} label — intake applies neither. Triage classifies; this verb files.`,
			);
		}
		const prefix = classifyingPrefix(title, vocabulary);
		if (prefix !== null) {
			return refuse(
				CLASSIFIED,
				`report file: the title leads with the classification prefix "${prefix}" — intake files type-neutral titles. Drop the prefix.`,
			);
		}

		const bodyBytes = new TextEncoder().encode(body).length;
		const scope = `report file: ${repo}, ${bytesIn} byte(s) read, ${REQUIRED_SECTIONS.length} section(s) seen, label "${label}" checked against ${labels.value.length} label(s), ${vocabulary.words.size} classification term(s) derived.`;

		const created = yield* createIssue(repo, title, body, label);
		if (created._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`report file: could not create the issue in ${repo}: ${created.reason} — the filing is UNKNOWN. Re-run \`report dedup\` before re-filing; the create may have landed.`,
				[scope, ...redactionNotes],
			);
		}

		// A create call's own response is the server echoing the request; a fresh read is the only
		// evidence the issue is in the queue (#3173).
		const mismatch = readbackMismatch(yield* getIssue(repo, created.value.number), label, body);
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`report file: created #${created.value.number} but the read-back is wrong: ${mismatch}. The issue exists and needs fixing by hand.`,
				[scope, ...redactionNotes],
			);
		}

		const diagnostics = [scope, ...redactionNotes];
		return json
			? answer(
					JSON.stringify({
						number: created.value.number,
						url: created.value.url,
						label,
						redactions,
						bodyBytes,
					}),
					diagnostics,
				)
			: answer(`${created.value.number}\t${created.value.url}`, diagnostics);
	});
