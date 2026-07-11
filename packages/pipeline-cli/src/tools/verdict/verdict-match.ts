/**
 * The pure verdict-match core of `verdict` — IO-free, total, unit-testable.
 *
 * The single discriminator the `review-*` / `ship-it` / `write-code`-repair / `heal-ci`
 * skills each hand-rolled inline as `jq` reads: given a PR's comment bodies + the PR's
 * current HEAD sha, is HEAD reviewed in this gate's namespace, and by which marker? The
 * exact decision the inline reads get subtly wrong — a SHA-less advisory must NOT satisfy
 * a SHA-bound check, and a verdict bound to a *stale* head must NOT pass — re-encoded here
 * as one deterministic, table-tested function (ADR 0058, the SHA-bound verdict contract).
 *
 * The marker grammar, the emphasis-tolerant anchor, and the `@ <sha>` capture are
 * single-sourced from gh-issue-intake-formats.md §5/§6 and ADR 0058; this core is the
 * deterministic decision the IO shell (`github.ts`) drives at the boundary. The author-gate
 * (ADR 0055 write+ trust root) is resolved by the shell and handed in as `authorizedAuthors`,
 * exactly as `epic-lock`'s claim core takes it — a forged marker from a non-collaborator
 * never enters the candidate set, and an empty authorized set resolves NO verdict (fail-closed).
 */

/** The four PR-layer gate namespaces (ADR 0058 §Scope + ADR 0150/0162). */
export type VerdictGate = "code" | "doc" | "skill" | "design";

/** A resolved verdict's polarity — the reviewer's go/no-go. */
export type Polarity = "PASS" | "FAIL";

/** The marker keyword for each gate — `review-<gate>:` is the namespaced first token. */
export const GATE_KEYWORD: Record<VerdictGate, string> = {
	code: "review-code",
	doc: "review-doc",
	skill: "review-skill",
	design: "review-design",
};

export const GATES: ReadonlyArray<VerdictGate> = ["code", "doc", "skill", "design"];

/**
 * Namespace-membership matcher: does the body's first line open with this gate's marker?
 * PASS / FAIL / advisory all match (they share the `review-<gate>:` prefix) — this is the
 * "is this a marker in my namespace at all" test the `post` upsert scans with, and the
 * cross-namespace guard (`review-code:` never matches the `doc` namespace and vice versa).
 * Anchored at string start with no `m` flag, so it tests the very first line only — a
 * comment that merely *quotes* a marker mid-body never matches (§5/§6).
 */
export const namespaceRe = (gate: VerdictGate): RegExp =>
	new RegExp(`^\\s*\\*{0,2}\\s*${GATE_KEYWORD[gate]}:`, "i");

/**
 * Bindable-verdict matcher: `review-<gate>: (PASS|FAIL) @ <sha>` — captures the polarity
 * (group 1) and the bound head SHA (group 2, ≥7 hex). The `@ <sha>` **immediately after**
 * PASS/FAIL is the fixed token order (§5) — a trailing `@ <sha>` after the em-dash tail does
 * NOT match, exactly as `ship-it`'s capture refuses it (#625).
 */
export const verdictRe = (gate: VerdictGate): RegExp =>
	new RegExp(
		`^\\s*\\*{0,2}\\s*${GATE_KEYWORD[gate]}:\\s*(PASS|FAIL)\\s*@\\s*([0-9a-f]{7,40})`,
		"i",
	);

/**
 * Polarity-only matcher: `review-<gate>: (PASS|FAIL)` with no `@ <sha>` requirement. This is
 * the looser namespace-verdict test `ship-it` filters candidates with before the SHA capture —
 * it matches a legacy/pre-0058 SHA-less PASS/FAIL marker too, which the resolution then
 * classifies as `sha-less` (never a current-head PASS). An `advisory` line is deliberately
 * NOT matched (it carries no PASS/FAIL), so it never enters the machine-verdict namespace.
 */
export const polarityRe = (gate: VerdictGate): RegExp =>
	new RegExp(`^\\s*\\*{0,2}\\s*${GATE_KEYWORD[gate]}:\\s*(PASS|FAIL)`, "i");

/** A PR/issue comment as the issues/comments REST endpoint surfaces it (only these fields matter). */
export interface VerdictComment {
	/** Server-assigned, strictly-monotonic, globally-unique comment id (the tiebreak sub-key). */
	readonly id: number;
	/** The comment author's login (checked against the authorized set). */
	readonly author: string;
	/** ISO-8601 UTC creation time (the latest-wins primary key). */
	readonly createdAt: string;
	/** The raw comment body (matched against the namespace/verdict matchers). */
	readonly body: string;
}

/** A parsed verdict first line: its polarity and its bound head SHA (`null` when SHA-less). */
export interface ParsedVerdict {
	readonly polarity: Polarity;
	readonly sha: string | null;
}

/**
 * Parse the polarity + bound SHA out of a first-line marker, or `null` when the body is not
 * a PASS/FAIL verdict in this gate's namespace. A bindable marker yields `{polarity, sha}`;
 * a namespaced-but-SHA-less PASS/FAIL yields `{polarity, sha: null}` (a legacy marker); a
 * non-verdict (chatter, an `advisory` line, another gate's marker) yields `null`.
 */
export const parseVerdict = (body: string, gate: VerdictGate): ParsedVerdict | null => {
	const bound = verdictRe(gate).exec(body);
	if (bound?.[1] && bound[2]) {
		return {polarity: bound[1].toUpperCase() as Polarity, sha: bound[2].toLowerCase()};
	}
	const bare = polarityRe(gate).exec(body);
	if (bare?.[1]) {
		return {polarity: bare[1].toUpperCase() as Polarity, sha: null};
	}
	return null;
};

/**
 * Is a verdict's bound SHA bound to the PR's current head? Prefix-match in either direction —
 * either side may be abbreviated (§ADR 0058 rule 3). A `null`/empty bound SHA, or an empty
 * head, is **never** current (the load-bearing fail-closed: a legacy SHA-less marker must not
 * read as current, the exact ship-it `is_current` short-circuit that a jq `sha: null` broke).
 */
export const isBoundToHead = (sha: string | null | undefined, head: string): boolean => {
	if (!sha || !head) return false;
	const a = sha.toLowerCase();
	const b = head.toLowerCase();
	return a.startsWith(b) || b.startsWith(a);
};

/** The resolved verdict for a (PR, gate) — exactly one of four states against the current head. */
export type VerdictOutcome =
	/** No authorized PASS/FAIL marker exists in this namespace (or the authorized set was empty). */
	| {readonly _tag: "none"}
	/** The latest authorized marker carries no `@ <sha>` (a pre-0058 legacy marker) — refuse. */
	| {readonly _tag: "sha-less"; readonly commentId: number; readonly polarity: Polarity}
	/** The latest authorized marker is bound to a different (stale) head — refuse. */
	| {
			readonly _tag: "stale";
			readonly commentId: number;
			readonly polarity: Polarity;
			readonly sha: string;
	  }
	/** The latest authorized marker is bound to the current head — its polarity decides. */
	| {
			readonly _tag: "current";
			readonly commentId: number;
			readonly polarity: Polarity;
			readonly sha: string;
	  };

export interface ResolveVerdictInput {
	readonly comments: ReadonlyArray<VerdictComment>;
	/** The write+ collaborator logins — the ADR 0055 trust root (resolved by the IO shell). */
	readonly authorizedAuthors: ReadonlyArray<string>;
	readonly gate: VerdictGate;
	/** The PR's current head SHA every verdict must be bound to (ADR 0058 rule 3). */
	readonly headSha: string;
}

/**
 * Resolve the (PR, gate) verdict against the current head, re-encoding ADR 0058 rule 3
 * exactly: author-gate to write+ collaborators (a forged marker is invisible), keep only
 * PASS/FAIL markers in this namespace, take the **newest** by `(createdAt, id)` (latest-wins,
 * so a newer FAIL vetoes an older PASS and a re-review overwrites), then classify by the
 * SHA-staleness test — `current` iff its `@ <sha>` prefix-matches the head, else `stale`;
 * `sha-less` when the newest marker carries no `@ <sha>`; `none` when the authorized candidate
 * set is empty. Fail-closed everywhere: an empty authorized set is `none`, never a false win.
 */
export const resolveVerdict = (input: ResolveVerdictInput): VerdictOutcome => {
	const authorized = new Set(input.authorizedAuthors);
	const re = polarityRe(input.gate);
	const candidates = input.comments.filter(
		(comment) => authorized.has(comment.author) && re.test(comment.body),
	);
	candidates.sort((a, b) =>
		a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id,
	);
	const latest = candidates[candidates.length - 1];
	// `latest` is absent only for an empty candidate set, and `parseVerdict` is null only for a
	// non-PASS/FAIL body — but polarityRe already filtered candidates to PASS/FAIL markers, so both
	// guards collapse to the same fail-closed `none` (no consumable verdict in this namespace).
	const parsed = latest ? parseVerdict(latest.body, input.gate) : null;
	if (latest === undefined || parsed === null) return {_tag: "none"};
	if (parsed.sha === null) {
		return {_tag: "sha-less", commentId: latest.id, polarity: parsed.polarity};
	}
	if (!isBoundToHead(parsed.sha, input.headSha)) {
		return {_tag: "stale", commentId: latest.id, polarity: parsed.polarity, sha: parsed.sha};
	}
	return {_tag: "current", commentId: latest.id, polarity: parsed.polarity, sha: parsed.sha};
};

/**
 * The `read` verb's decision: is HEAD reviewed with the expected polarity? True **only** for a
 * current-head-bound verdict whose polarity matches — a `sha-less`, `stale`, or `none` outcome
 * is never satisfied. `ship-it` expects `PASS`; `write-code`-repair expects `FAIL` (the seam it
 * consumes). This is the single boolean the inline `is_current`-then-polarity checks recomputed.
 */
export const isReviewed = (outcome: VerdictOutcome, expect: Polarity): boolean =>
	outcome._tag === "current" && outcome.polarity === expect;

/**
 * A machine-readable reason for a non-satisfying `read` outcome — the named refusal `ship-it`
 * prints (`unverified (verdict not bound to current head)` for `sha-less`/`stale`).
 */
export const outcomeReason = (outcome: VerdictOutcome, expect: Polarity): string => {
	switch (outcome._tag) {
		case "none":
			return "no authorized verdict in this namespace";
		case "sha-less":
			return "unverified (verdict not bound to current head): latest marker is SHA-less (pre-0058)";
		case "stale":
			return `unverified (verdict not bound to current head): latest marker bound to ${outcome.sha}, not the current head`;
		case "current":
			return outcome.polarity === expect
				? `reviewed: current-head ${outcome.polarity} @ ${outcome.sha}`
				: `current-head verdict is ${outcome.polarity}, expected ${expect}`;
	}
};

/**
 * The `post` namespace guard: does this body's first line open with the gate's marker? A
 * verdict body must carry its OWN gate's marker on line one — `post`-ing a `review-code`
 * marker on a doc PR is the cross-namespace emission bug this refuses fail-closed. Accepts
 * every valid first line for the gate (PASS / FAIL / advisory), rejects any other gate's
 * marker and any non-marker first line.
 */
export const isNamespaceMarker = (body: string, gate: VerdictGate): boolean =>
	namespaceRe(gate).test(body);
