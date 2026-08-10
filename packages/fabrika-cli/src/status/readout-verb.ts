/**
 * `status readout` — the landed-decision digest as published in the durable artifact.
 *
 * The display half. The producer is `governance` (#4949); this verb ranks nothing and re-derives
 * nothing — it decodes the registered `governance-digest` wire format and prints what it holds.
 *
 * **Four readings, and `absent` is only one of them.** `found`, `absent` and `malformed` are all
 * facts about the repository at exit `0`; a failed fetch, an unreadable freshness stamp and an
 * unregistered format are UNKNOWN at exit `11`. Collapsing any of the three into `absent` reports a
 * proven negative over evidence never held — the hazard `../wire/codes.ts` names when it seats
 * `ARTIFACT_UNKNOWN` deliberately apart from `ABSENT`.
 *
 * **`<as-of>` is the artifact comment's own `updated_at`, never the fetch time.** Printing the
 * fetch time for a digest written three weeks ago claims a freshness nobody has (#3148, #3330,
 * #4338).
 */
import {Effect} from "effect";
import type {Shell} from "../io/git.ts";
import {listComments, openIssuesTitled} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {findFormat} from "../wire/registry.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {type AsOf, asOfToken, fromArtifact, noAsOf, row} from "./fields.ts";

const VERB = "status readout";

/** The registered wire format this verb decodes. Not registered yet — tracked at #5199. */
export const DIGEST_FORMAT = "governance-digest";

/** The heading the digest comment carries. */
export const DIGEST_HEADING = "## Governance readout";

/** The exact title of the durable artifact issue, when no explicit number is supplied. */
export const ARTIFACT_TITLE = "Governance readout";

/** The environment variable that names the artifact issue. Never a constant issue number. */
export const ARTIFACT_ISSUE_ENV = "FABRIKA_GOVERNANCE_READOUT_ISSUE";

export type ReadoutState = "found" | "absent" | "malformed";

export type ReadoutRead =
	/** The decoder does not exist, so nothing about the digest is knowable. */
	| {readonly _tag: "NoFormat"}
	/** No artifact resolved — a **proven** fact about the repository, and the caller bootstraps one. */
	| {readonly _tag: "NoArtifact"; readonly repo: string}
	/** The artifact could not be fetched, or its freshness could not be established. */
	| {
			readonly _tag: "Unfetchable";
			readonly repo: string;
			readonly issue: number | null;
			readonly reason: string;
	  }
	| {
			readonly _tag: "Fetched";
			readonly repo: string;
			readonly issue: number;
			readonly scanned: number;
			/** The most recently updated comment carrying the heading, or `null` when none does. */
			readonly digest: {readonly body: string; readonly updatedAt: string} | null;
	  };

/** A positive integer, or `null` — the shape a supplied issue number must have. */
export const issueNumberOf = (value: string): number | null =>
	/^\d+$/.test(value.trim()) && Number.parseInt(value.trim(), 10) > 0
		? Number.parseInt(value.trim(), 10)
		: null;

/**
 * Which comment is the digest, stated so staleness cannot hide: the **most recently updated**
 * comment carrying the heading, and that comment's conformance alone decides `found` vs `malformed`.
 * Skipping a newer non-conforming publication in favour of an older valid one would render a stale
 * digest as current.
 */
export const digestComment = <A extends {readonly body: string; readonly updatedAt: string}>(
	comments: ReadonlyArray<A>,
): A | null => {
	const carrying = comments.filter((comment) =>
		comment.body.split("\n").some((line) => line.trim() === DIGEST_HEADING),
	);
	return carrying.reduce<A | null>(
		(newest, comment) =>
			newest === null || comment.updatedAt > newest.updatedAt ? comment : newest,
		null,
	);
};

export interface ReadoutSources {
	readonly repo: string;
	/** The positional argument, already validated, or `null`. */
	readonly issue: number | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Resolve the artifact and fetch it. The format check is the caller's first gate. */
export const readReadout = ({repo, issue, env}: ReadoutSources): Shell<ReadoutRead> =>
	Effect.gen(function* () {
		if (findFormat(DIGEST_FORMAT) === undefined) return {_tag: "NoFormat"} as const;

		const fromEnv = env[ARTIFACT_ISSUE_ENV];
		let target = issue ?? (fromEnv === undefined ? null : issueNumberOf(fromEnv));
		if (target === null) {
			const titled = yield* openIssuesTitled(repo, ARTIFACT_TITLE);
			if (titled._tag === "Failure") {
				return {_tag: "Unfetchable", repo, issue: null, reason: titled.reason} as const;
			}
			// Several issues sharing the title is not a resolution: guessing which one is the digest
			// would display somebody else's issue as the readout.
			if (titled.value.length !== 1) return {_tag: "NoArtifact", repo} as const;
			target = titled.value[0]?.number ?? null;
			if (target === null) return {_tag: "NoArtifact", repo} as const;
		}

		const comments = yield* listComments(repo, target);
		if (comments._tag === "Failure") {
			return {_tag: "Unfetchable", repo, issue: target, reason: comments.reason} as const;
		}
		const digest = digestComment(comments.value);
		if (digest !== null && digest.updatedAt === "") {
			return {
				_tag: "Unfetchable",
				repo,
				issue: target,
				reason: "carries no readable updated_at — the digest's freshness is UNKNOWN",
			} as const;
		}
		return {
			_tag: "Fetched",
			repo,
			issue: target,
			scanned: comments.value.length,
			digest: digest === null ? null : {body: digest.body, updatedAt: digest.updatedAt},
		} as const;
	});

/** The rendered reading: a state, its rows, its source and its freshness. */
export interface ReadoutReading {
	readonly state: ReadoutState;
	readonly rows: ReadonlyArray<string>;
	readonly source: string;
	readonly asOf: AsOf;
	readonly detail: string;
}

/** The refusal an UNKNOWN reading owes, or the reading itself. `null` state means exit `11`. */
export const readingOf = (read: ReadoutRead): ReadoutReading | null => {
	if (read._tag === "NoFormat" || read._tag === "Unfetchable") return null;
	if (read._tag === "NoArtifact") {
		return {
			state: "absent",
			rows: [],
			source: read.repo,
			asOf: noAsOf,
			detail: "no readout artifact",
		};
	}
	const source = `${read.repo}#${read.issue}`;
	if (read.digest === null) {
		return {
			state: "absent",
			rows: [],
			source,
			asOf: noAsOf,
			detail: `no digest block in ${source}`,
		};
	}
	const format = findFormat(DIGEST_FORMAT);
	// Unreachable through `readReadout`, which returns `NoFormat` before any fetch.
	if (format === undefined) return null;
	const decoded = format.read(read.digest.body);
	const asOf = fromArtifact(read.digest.updatedAt);
	if (decoded._tag === "Found") {
		return {
			state: "found",
			rows: decoded.value,
			source,
			asOf,
			detail: `${decoded.value.length} rows`,
		};
	}
	return decoded._tag === "Malformed"
		? {state: "malformed", rows: [], source, asOf, detail: decoded.reason}
		: {state: "absent", rows: [], source, asOf, detail: decoded.reason};
};

export interface ReadoutInput {
	readonly read: ReadoutRead;
	readonly json: boolean;
}

export const runReadout = ({read, json}: ReadoutInput): VerbOutcome => {
	if (read._tag === "NoFormat") {
		return refuse(
			PRECONDITION_UNKNOWN,
			`${VERB}: the ${DIGEST_FORMAT} format is not registered — the digest is UNKNOWN, never absent (#5199).`,
		);
	}
	if (read._tag === "Unfetchable") {
		const where = read.issue === null ? read.repo : `${read.repo}#${read.issue}`;
		return refuse(
			PRECONDITION_UNKNOWN,
			`${VERB}: cannot fetch ${where}: ${read.reason} — the digest is UNKNOWN, never absent.`,
		);
	}
	const reading = readingOf(read);
	// Unreachable: the two UNKNOWN tags are handled above and every other tag yields a reading.
	if (reading === null) return refuse(FAILED, `${VERB}: the reading could not be produced.`);

	const notice =
		read._tag === "NoArtifact"
			? `${VERB}: no artifact — $${ARTIFACT_ISSUE_ENV} unset and no open issue in ${read.repo} titled exactly "${ARTIFACT_TITLE}". Run: fabrika status bootstrap readout-artifact`
			: `${VERB}: read ${read.repo}#${read.issue}, ${read.scanned} comments scanned, digest ${reading.state}.`;

	if (json) {
		return answer(
			`${JSON.stringify({
				outcome: reading.state,
				rows: reading.rows,
				issue: read._tag === "Fetched" ? read.issue : null,
				repo: read.repo,
				asOf: reading.asOf.at,
				asOfKind: reading.asOf.kind,
				detail: reading.detail,
			})}\n`,
			[notice],
		);
	}
	const lines = [
		row(
			"readout",
			reading.state,
			String(reading.rows.length),
			reading.source,
			asOfToken(reading.asOf),
		),
		...reading.rows,
	];
	return answer(`${lines.join("\n")}\n`, [notice]);
};

/** The usage refusal a non-integer positional owes. */
export const badIssueRefusal = (value: string): VerbOutcome =>
	refuse(OFF_VOCABULARY, `${VERB}: "${value}" is not a positive issue number.`);
