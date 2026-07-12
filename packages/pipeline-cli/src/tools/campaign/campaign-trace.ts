/**
 * `campaign verify-trace` pure core — IO-free, total, unit-testable. Decides whether a
 * wave-labeled cluster carries a valid **founder-approval trace**: the single durable,
 * auditable artifact that authorizes a wave to become a campaign.
 *
 * The whole point is fail-closed authorization. The campaign skill is invoker-agnostic — a
 * human OR an agent may run it (issue #2658, story 2) — so there is no human-at-keyboard guard
 * like `release`'s; the sole authorization is this trace, and the mechanism must default-DENY
 * so that neither an agent nor a human can conjure a campaign the founder never approved. PASS
 * is returned ONLY on positive evidence — a present, well-formed, founder-authored, wave-bound
 * marker; absence, malformation, a non-founder author, and zero scope each fail closed (ADR 0092).
 *
 * The trace shape (pinned here; grounded in the gated-audit-wave play, where audit findings are
 * returned to the founder for approval BEFORE anything is filed). A campaign is authorized only
 * by a founder-authored comment — on any issue carrying the wave label — whose FIRST line is:
 *
 *   campaign-approve: <wave-label> · <ISO-8601-UTC>
 *
 *   - <wave-label>   MUST equal the wave label under verification — binds the approval to THIS
 *                    cluster, so a valid approval of one wave never authorizes another.
 *   - <ISO-8601-UTC> MUST be a valid ISO-8601 UTC instant — records WHEN approval was granted,
 *                    making the trace auditable after the fact.
 *   - author         MUST be the founder — the identity is injected as config by the IO shell
 *                    (`github.ts`), never hardcoded here (no named identity in a committed
 *                    artifact; the founder login is a parameter this core compares against).
 *
 * The marker is emphasis-tolerant (a leading `**`), case-insensitive on the keyword, and anchored
 * to line one — a comment that merely *quotes* the marker mid-body never counts (the same
 * line-one anchoring the `verdict` and `claim` markers use). This module never touches the
 * network or disk; the `gh api` boundary that gathers the cluster + its markers lives in `github.ts`.
 */

/** The ISO-8601 UTC instant grammar the approval timestamp must satisfy (a `Z` suffix ⇒ UTC). */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * The approval-marker keyword prefix — "does this comment even attempt an approval?" Line-one
 * anchored (no `m` flag), emphasis-tolerant, case-insensitive. Separates an approval *attempt*
 * (which, if malformed, fails closed as `malformed`) from unrelated chatter (which is `absent`).
 */
const APPROVE_PREFIX_RE = /^\s*\*{0,2}\s*campaign-approve:/i;

/**
 * The full approval-marker grammar: `campaign-approve: <label> · <ts>`. Captures the wave label
 * (everything up to the `·` separator, no whitespace) and the raw timestamp token. A structural
 * match is necessary but NOT sufficient — the label must still bind to the queried wave and the
 * timestamp must still be a valid ISO-8601 UTC instant (both checked in `parseApproval`).
 */
const APPROVE_RE = /^\s*\*{0,2}\s*campaign-approve:\s*(?<label>[^\s·]+)\s*·\s*(?<ts>\S+)\s*$/i;

/**
 * One candidate approval comment, reduced to the fields the decision needs. Gathered from the
 * cluster at the `gh api` boundary (`github.ts`); the core never fetches it.
 */
export interface ApprovalComment {
	/** Server-assigned, strictly-monotonic comment id — the tiebreak sub-key for the earliest marker. */
	readonly id: number;
	/** The comment author's login (compared, case-insensitively, against the founder identity). */
	readonly author: string;
	/** ISO-8601 UTC creation time — the primary key for picking the earliest founder approval. */
	readonly createdAt: string;
	/** The raw comment body (matched against the approval grammar). */
	readonly body: string;
	/** The cluster issue this comment was found on — carried through for the report. */
	readonly issue: number;
}

/** The facts the decision is a pure function of — all gathered before the core runs. */
export interface VerifyTraceInput {
	/** The wave label whose cluster is being verified (the label the trace binds to). */
	readonly waveLabel: string;
	/** The founder's GitHub login — injected config, the authorization anchor. Never hardcoded. */
	readonly founderLogin: string;
	/** How many issues carry the wave label. Zero ⇒ the label names nothing ⇒ zero-scope. */
	readonly clusterSize: number;
	/** Every candidate approval comment found across the cluster (any author, any shape). */
	readonly comments: ReadonlyArray<ApprovalComment>;
}

/**
 * The verdict — a discriminated union so an invalid state is unrepresentable: a PASS always
 * carries the resolved founder + timestamp evidence, and each fail shape carries exactly the
 * evidence for *why* it failed. Every non-PASS is a fail-closed refusal (ADR 0092).
 */
export type TraceVerdict =
	| {
			readonly pass: true;
			readonly waveLabel: string;
			readonly approvedBy: string;
			readonly at: string;
			readonly commentId: number;
			readonly issue: number;
	  }
	/** No wave to bind to, no founder identity, or the label names zero issues — nothing to verify. */
	| {readonly pass: false; readonly reason: "zero-scope"; readonly detail: string}
	/** The cluster is non-empty but carries no `campaign-approve:` attempt at all. */
	| {readonly pass: false; readonly reason: "absent"; readonly detail: string}
	/** An approval attempt exists but is malformed or bound to a different wave label. */
	| {readonly pass: false; readonly reason: "malformed"; readonly detail: string}
	/** A well-formed, wave-bound approval exists but no author is the founder. */
	| {
			readonly pass: false;
			readonly reason: "non-founder-author";
			readonly detail: string;
			readonly authors: ReadonlyArray<string>;
	  };

/** A structurally-parsed, wave-bound, valid-timestamp approval — the only kind that can PASS. */
interface WellFormedApproval {
	readonly comment: ApprovalComment;
	readonly at: string;
}

const isValidIsoUtc = (ts: string): boolean => ISO_UTC_RE.test(ts) && !Number.isNaN(Date.parse(ts));

const sameLogin = (a: string, b: string): boolean =>
	a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Classify one comment against the queried wave: `well-formed` (grammar matches, timestamp is a
 * valid ISO-8601 UTC instant, and the label binds to this wave), `attempt` (the keyword prefix is
 * present but one of those checks fails — a malformed or mis-bound approval), or `null` (not an
 * approval attempt at all). The three-way split is what lets `verifyTrace` distinguish the
 * `malformed` failure from `absent`.
 */
const classify = (
	comment: ApprovalComment,
	waveLabel: string,
): WellFormedApproval | "attempt" | null => {
	if (!APPROVE_PREFIX_RE.test(comment.body)) return null;
	const m = APPROVE_RE.exec(comment.body);
	const label = m?.groups?.label;
	const ts = m?.groups?.ts;
	if (label === undefined || ts === undefined) return "attempt";
	if (label !== waveLabel) return "attempt";
	if (!isValidIsoUtc(ts)) return "attempt";
	return {comment, at: ts};
};

/** Order approvals earliest-first by `(createdAt, id)` — the earliest founder approval is the one recorded. */
const earliest = (a: WellFormedApproval, b: WellFormedApproval): number =>
	a.comment.createdAt < b.comment.createdAt
		? -1
		: a.comment.createdAt > b.comment.createdAt
			? 1
			: a.comment.id - b.comment.id;

/**
 * Decide the verdict over the gathered facts. Default-DENY: PASS is returned ONLY when a
 * well-formed, wave-bound approval authored by the founder exists; every other input — empty
 * scope, no attempt, a malformed/mis-bound attempt, a well-formed approval by a non-founder —
 * fails closed. The precedence when no founder approval exists is most-informative-first:
 * a well-formed non-founder approval reports `non-founder-author`, else a bare attempt reports
 * `malformed`, else `absent`.
 */
export const verifyTrace = (input: VerifyTraceInput): TraceVerdict => {
	const waveLabel = input.waveLabel.trim();
	if (waveLabel === "") {
		return {
			pass: false,
			reason: "zero-scope",
			detail: "no wave label given — nothing to bind an approval to",
		};
	}
	if (input.founderLogin.trim() === "") {
		return {
			pass: false,
			reason: "zero-scope",
			detail:
				"no founder identity configured — cannot verify founder authorship (fail-closed, never a login fallback)",
		};
	}
	if (input.clusterSize <= 0) {
		return {
			pass: false,
			reason: "zero-scope",
			detail: `the wave label '${waveLabel}' names zero issues — an empty cluster cannot be approved (ADR 0092)`,
		};
	}

	const wellFormed: Array<WellFormedApproval> = [];
	let sawAttempt = false;
	for (const comment of input.comments) {
		const c = classify(comment, waveLabel);
		if (c === null) continue;
		if (c === "attempt") {
			sawAttempt = true;
			continue;
		}
		wellFormed.push(c);
	}

	const byFounder = wellFormed
		.filter((w) => sameLogin(w.comment.author, input.founderLogin))
		.sort(earliest);
	const founderApproval = byFounder[0];
	if (founderApproval !== undefined) {
		return {
			pass: true,
			waveLabel,
			approvedBy: founderApproval.comment.author,
			at: founderApproval.at,
			commentId: founderApproval.comment.id,
			issue: founderApproval.comment.issue,
		};
	}

	if (wellFormed.length > 0) {
		const authors = [...new Set(wellFormed.map((w) => w.comment.author))];
		return {
			pass: false,
			reason: "non-founder-author",
			detail: `a well-formed campaign-approve marker for '${waveLabel}' exists but no author is the founder ('${input.founderLogin}') — refusing to authorize a campaign the founder never approved`,
			authors,
		};
	}
	if (sawAttempt) {
		return {
			pass: false,
			reason: "malformed",
			detail: `a campaign-approve marker was found on the '${waveLabel}' cluster but it is malformed or bound to a different wave — the trace must read exactly 'campaign-approve: ${waveLabel} · <ISO-8601-UTC>'`,
		};
	}
	return {
		pass: false,
		reason: "absent",
		detail: `no campaign-approve marker found on the '${waveLabel}' cluster — a founder-approval trace is required before this wave can become a campaign`,
	};
};

/** Render the human-readable report for a verdict (ADR 0092 §1 "emit what you scanned/decided"). */
export const renderReport = (verdict: TraceVerdict): string => {
	if (verdict.pass) {
		return (
			`campaign verify-trace: PASS — wave '${verdict.waveLabel}' carries a founder-approval trace ` +
			`(approved by ${verdict.approvedBy} at ${verdict.at}, comment ${verdict.commentId} on #${verdict.issue})`
		);
	}
	const prefix = `campaign verify-trace: FAIL (${verdict.reason}) — `;
	if (verdict.reason === "non-founder-author") {
		return `${prefix}${verdict.detail}. Marker author(s): ${verdict.authors.join(", ") || "<none>"}.`;
	}
	return `${prefix}${verdict.detail}.`;
};
