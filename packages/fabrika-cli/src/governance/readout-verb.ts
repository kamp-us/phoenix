/**
 * `governance readout` — compose the ranked rows through the `governance-digest` wire format, upsert
 * them into the durable artifact, and read them back.
 *
 * **Non-blocking by construction.** This verb writes a comment and nothing else. It sets no label,
 * touches no PR, and has no exit code meaning "the corpus is in a bad state" — a digest that could red
 * would be the human gate the #4927 ruling retired, wearing a new name. Every outcome here is either
 * "the readout landed" or "the readout did not land".
 *
 * **The artifact issue is resolved, never a constant.** `$FABRIKA_GOVERNANCE_READOUT_ISSUE`, else the
 * single open issue titled exactly `Governance readout`, else a refusal naming both lookups — a
 * guessed number would publish the digest onto somebody else's issue.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, getIssue, listComments, openIssuesTitled} from "../io/issues.ts";
import {patchComment, viewerLogin} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {resolveTargetRepo} from "../review/target.ts";
import {latestByWriteRecency} from "../review/write-recency.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	emitFromFields,
	parseFields,
	read as readDigest,
	renderRows,
} from "../wire/governance-digest.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "./authored.ts";
import {
	INCOMPLETE_SCAN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";

const VERB = "governance readout";

/** The title the artifact issue carries when no number and no env var name it. */
export const ARTIFACT_TITLE = "Governance readout";
export const ARTIFACT_ENV = "FABRIKA_GOVERNANCE_READOUT_ISSUE";

const SURFACE: AuthoredSurface = {
	verb: VERB,
	noun: "the assembled body",
	emptyMessage: `${VERB}: no rows on stdin — an empty readout is not a readout.`,
	bareAtMessage: `${VERB}: the body is a bare "@" path reference — the rows never arrived. Send them on stdin.`,
	leakCorrection: "cite it repo-relative.",
};

export interface ReadoutOptions {
	/** The artifact issue, or `null` to resolve it from the environment and then from the title. */
	readonly issue: number | null;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

type Artifact =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Issue"; readonly issue: number};

const resolveArtifact = (
	repo: string,
	explicit: number | null,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Artifact, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (explicit !== null) return {_tag: "Issue" as const, issue: explicit};
		const named = (env[ARTIFACT_ENV] ?? "").trim();
		if (named !== "") {
			const parsed = Number.parseInt(named, 10);
			return Number.isInteger(parsed) && parsed > 0
				? {_tag: "Issue" as const, issue: parsed}
				: {
						_tag: "Refused" as const,
						outcome: refuse(
							OFF_VOCABULARY,
							`${VERB}: $${ARTIFACT_ENV} is "${named}", which is not an issue number.`,
						),
					};
		}
		const titled = yield* openIssuesTitled(repo, ARTIFACT_TITLE);
		if (titled._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot search ${repo} for an open issue titled "${ARTIFACT_TITLE}": ${titled.reason} — nothing was written.`,
				),
			};
		}
		const only = titled.value[0];
		if (only === undefined || titled.value.length > 1) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					ZERO_SCOPE,
					`${VERB}: no artifact issue given, \`$${ARTIFACT_ENV}\` is unset, and ${repo} has ${only === undefined ? "no" : `${titled.value.length}`} open issue${only === undefined ? "" : "s"} titled "${ARTIFACT_TITLE}" — refusing to guess where the digest lands.`,
				),
			};
		}
		return {_tag: "Issue" as const, issue: only.number};
	});

/**
 * Why the read-back does not show the same rows in the same order, or `null` when it does.
 *
 * The rows go through the format's own `read` and are compared **in order** — a digest is ranked, so
 * a set comparison would pass a readout whose ranking the write reversed. The whole body is then
 * compared through the imported `normalizeForReadback`, whose trailing-newline step is the one a
 * re-derivation drops.
 */
const mismatchOf = (
	body: string,
	expected: ReadonlyArray<string>,
	composed: string,
): string | null => {
	const normalized = normalizeForReadback(body);
	const parsed = readDigest(normalized);
	if (parsed._tag !== "Found") return parsed.reason;
	const got = renderRows(parsed.value);
	if (got.length !== expected.length) {
		return `read back ${got.length} row(s), expected ${expected.length}`;
	}
	for (const [index, row] of expected.entries()) {
		if (got[index] !== row)
			return `row ${index + 1} read back as "${got[index]}", expected "${row}"`;
	}
	return normalized === normalizeForReadback(composed)
		? null
		: "the comment's bytes are not the ones that were sent";
};

export const runReadout = (
	options: ReadoutOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {json} = options;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;

		// The rows are parsed BEFORE the artifact is resolved: an off-vocabulary kind is the caller's
		// to fix, and reaching GitHub first would make a bad row's refusal depend on the network.
		const rows = parseFields(authored.text);
		if (rows._tag === "Unusable") {
			return refuse(OFF_VOCABULARY, `${VERB}: ${rows.reason}.`);
		}
		const composed = emitFromFields(authored.text);
		if (composed._tag === "Unusable") {
			return refuse(OFF_VOCABULARY, `${VERB}: ${composed.reason}.`);
		}
		const body = composed.bytes;

		const leaked = leakRefusal(SURFACE, body);
		if (leaked !== null) return leaked;

		const artifact = yield* resolveArtifact(repo, options.issue, options.env);
		if (artifact._tag === "Refused") return artifact.outcome;
		const issue = artifact.issue;

		const found = yield* getIssue(repo, issue);
		if (found._tag === "Absent") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: issue #${issue} not found in ${repo} — the readout artifact is absent; front-door creates it (#4952).`,
			);
		}
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue}: ${found.reason} — nothing was written.`,
			);
		}
		if (found.value.state !== "open") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: issue #${issue} is closed — a readout nobody reads is not a readout.`,
			);
		}

		const me = yield* viewerLogin;
		if (me._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the authenticated user: ${me.reason} — nothing was written.`,
			);
		}
		const comments = yield* listComments(repo, issue);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue}: ${comments.reason} — nothing was written.`,
			);
		}
		if (comments.value.length < found.value.comments) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${comments.value.length} of ${found.value.comments} comments on #${issue} — refusing to upsert against a partial sweep.`,
			);
		}
		const mine = latestByWriteRecency(
			comments.value.filter(
				(comment) => comment.author === me.value && readDigest(comment.body)._tag === "Found",
			),
		);

		let landed: {readonly id: number; readonly url: string} | null = null;
		let failure: string | null = null;
		if (mine === undefined) {
			const created = yield* createComment(repo, issue, body);
			if (created._tag === "Failure") failure = created.reason;
			else landed = {id: created.value.id, url: created.value.url};
		} else {
			const edited = yield* patchComment(repo, mine.id, body);
			if (edited._tag === "Failure") failure = edited.reason;
			else landed = {id: mine.id, url: edited.value};
		}
		if (landed === null) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: create/edit failed: ${failure ?? "unknown"} — UNKNOWN whether the readout landed; re-read #${issue} before retrying.`,
			);
		}
		const upsert = mine === undefined ? "created" : "edited";

		const back = yield* getComment(repo, landed.id);
		const mismatch =
			back._tag === "Failure" ? back.reason : mismatchOf(back.value, renderRows(rows.rows), body);
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: landed, but the read-back does not yield the same rows (${mismatch}) — inspect comment ${landed.id}.`,
			);
		}

		const diagnostics = [`${VERB}: upserted ${rows.rows.length} row(s) onto #${issue}.`];
		return json
			? answer(
					JSON.stringify({
						outcome: "readout",
						issue,
						rows: rows.rows.length,
						upsert,
						commentUrl: landed.url,
					}),
					diagnostics,
				)
			: answer(`readout\t${issue}\t${rows.rows.length}\t${upsert}\t${landed.url}`, diagnostics);
	});
