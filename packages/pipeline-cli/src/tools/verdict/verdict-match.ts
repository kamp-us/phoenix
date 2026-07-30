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
import {findCommentLeaks} from "../leak-guard/leak-guard.ts";

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
	/** ISO-8601 UTC time the comment SLOT was opened — the write-recency FLOOR, not the ordering key. */
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

/** The resolved verdict for a (PR, gate) — exactly one of five states against the current head. */
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
	  }
	/**
	 * The in-force artifact is a §CP advisory bound to the current head whose body records a `[FAIL]`
	 * criterion (ADR 0111/0151). Deliberately NOT a FAIL: an advisory carries no polarity, and its
	 * remedy is a re-review, not the author's repair round-trip — which is what a FAIL marker names.
	 * Only `decideNamespace`'s §CP arm produces it; `resolveVerdict` (marker-only) never does.
	 */
	| {readonly _tag: "advisory-not-all-pass"; readonly commentId: number; readonly sha: string};

/**
 * The in-force STATE of a namespace — the one projection every consumer's satisfaction test goes
 * through, so `verdict read --expect` and `verdict gate` cannot answer the same (PR, gate, head,
 * §CP-ness) differently (#4049 AC2). `read` was polarity-matching while `gate` was latest-wins, and
 * a §CP body-only repair (the head deliberately never moves, so ADR 0058 staleness never fires) made
 * the two diverge permanently: `gate` saw the superseding advisory, `read` could not see an advisory
 * at all and kept resolving the superseded FAIL as current.
 */
export type VerdictState = "pass" | "fail" | "absent" | "unverified";

/** Project a resolved outcome onto its state — total, and the ONE place the mapping is written. */
export const verdictState = (outcome: VerdictOutcome): VerdictState => {
	switch (outcome._tag) {
		case "none":
			return "absent";
		case "sha-less":
		case "stale":
		case "advisory-not-all-pass":
			return "unverified";
		case "current":
			return outcome.polarity === "PASS" ? "pass" : "fail";
	}
};

/** The comment that resolved an outcome, or `null` when nothing resolved. */
export const outcomeCommentId = (outcome: VerdictOutcome): number | null =>
	outcome._tag === "none" ? null : outcome.commentId;

/** The head the resolving verdict binds, or `null` when it binds none. */
export const outcomeSha = (outcome: VerdictOutcome): string | null =>
	outcome._tag === "stale" || outcome._tag === "current" || outcome._tag === "advisory-not-all-pass"
		? outcome.sha
		: null;

export interface ResolveVerdictInput {
	readonly comments: ReadonlyArray<VerdictComment>;
	/** The write+ collaborator logins — the ADR 0055 trust root (resolved by the IO shell). */
	readonly authorizedAuthors: ReadonlyArray<string>;
	readonly gate: VerdictGate;
	/** The PR's current head SHA every verdict must be bound to (ADR 0058 rule 3). */
	readonly headSha: string;
}

/**
 * The write-recency stamp `post` writes into every verdict body it emits, and the ONE key every
 * recency comparison in this module orders by (#4200).
 *
 * `created_at` is when a comment SLOT was opened, not when the verdict it now carries was written:
 * `post` upserts in place at the same head (ADR 0213/#4007), so an in-place correction keeps the
 * `created_at` of the slot it was PATCHed into and reads as OLDER than a sibling run's comment that
 * was merely created later. #4198 removed the cross-head half of that defect by filtering candidates
 * to the live head first; this closes the residual, where BOTH candidates bind the live head and the
 * tiebreak among them decides alone — with no staleness backstop, so a live FAIL upserted into an old
 * slot silently loses to a stale PASS (the fail-OPEN direction).
 *
 * Deliberately a body-carried stamp rather than the REST `updated_at` (the rejected alternative, ADR
 * 0058): `updated_at` moves on any byte edit — a typo fix, a leak redaction, a human reformatting a
 * table — so a cosmetic edit to the older-AUTHORED verdict would re-crown it over the genuinely newer
 * one, and invisibly, since `updated_at` is not rendered. The stamp moves only when a verdict is
 * authored, is legible in the rendered comment, survives any storage/schema change, and sits inside
 * the ADR-0055 authorized-author trust boundary, where a hand-forged stamp is at least a VISIBLE
 * forgery. See the PR body for the full argument.
 *
 * Second-precision ISO-8601 UTC, matching GitHub's `created_at` shape exactly so the two are lexically
 * comparable — the whole point, since one falls back to the other.
 */
const writtenAtRe = /^[ \t]*Verdict-written:[ \t]*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)[ \t]*$/gim;

/**
 * The write time a verdict body stamps on itself, or `null` for an unstamped body (a pre-#4200
 * marker, or one hand-rolled through raw `gh api`). Takes the LAST match: `post` appends the stamp,
 * so a body that also quotes an earlier stamp in its prose still resolves to the real one.
 */
export const writtenAtOf = (body: string): string | null => {
	let last: string | null = null;
	for (const match of body.matchAll(writtenAtRe)) last = match[1] ?? last;
	return last;
};

/** Stamp `iso` onto a verdict body, replacing any stamp it already carries. */
export const withWrittenAt = (body: string, iso: string): string =>
	`${body.replace(writtenAtRe, "").replace(/\s+$/, "")}\n\nVerdict-written: ${iso}`;

/**
 * Normalize an epoch-millis instant to the stamp's second-precision ISO-8601 UTC shape. Dropping the
 * milliseconds is load-bearing, not cosmetic: `2026-07-26T00:49:26.123Z` sorts BELOW
 * `2026-07-26T00:49:26Z` lexically (`.` < `Z`), so a sub-second-precision stamp would read as older
 * than a `created_at` in the same second — an inversion in exactly the tight race this key exists to
 * order.
 */
export const toStampIso = (epochMillis: number): string =>
	new Date(epochMillis).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * When a comment's verdict was WRITTEN — its body stamp, floored at the comment's `created_at`.
 *
 * The floor is the fail-safe: a comment cannot have been written before its slot existed, so an
 * absent stamp (every pre-#4200 comment) and a backdated one both degrade to today's `created_at`
 * ordering — never to something worse. Forward forgery stays possible and stays visible; ADR 0055
 * already confines it to write+ collaborators.
 */
export const writeRecencyOf = (comment: VerdictComment): string => {
	const stamped = writtenAtOf(comment.body);
	return stamped !== null && stamped > comment.createdAt ? stamped : comment.createdAt;
};

/**
 * The single recency ordering over verdict comments: write-recency, then the server-assigned comment
 * id. Every "which of these is newer" question in this module and in `gate-decision.ts` answers
 * through this one comparator, so the marker set and the marker-vs-advisory fold cannot drift apart.
 */
export const compareWriteRecency = (a: VerdictComment, b: VerdictComment): number => {
	const ra = writeRecencyOf(a);
	const rb = writeRecencyOf(b);
	return ra < rb ? -1 : ra > rb ? 1 : a.id - b.id;
};

/**
 * The latest-wins pick within an already-scoped candidate set: among the comments an authorized
 * (write+, ADR 0055) author posted whose body matches `re`, the newest by write-recency
 * (`compareWriteRecency`). `undefined` when the authorized candidate set is empty — the fail-closed
 * "nothing to consume in this namespace", never a false win.
 *
 * This is recency ALONE — it is not the in-force resolver. Scope the candidate set to the live head
 * first (`pickInForce` below, #4189), then break ties here.
 */
export const pickLatestAuthorized = (
	comments: ReadonlyArray<VerdictComment>,
	authorizedAuthors: ReadonlyArray<string>,
	re: RegExp,
): VerdictComment | undefined => {
	const authorized = new Set(authorizedAuthors);
	const candidates = comments.filter(
		(comment) => authorized.has(comment.author) && re.test(comment.body),
	);
	candidates.sort(compareWriteRecency);
	return candidates[candidates.length - 1];
};

/**
 * The head a candidate binds itself to: its first-line marker's `@ <sha>`, else the §CP advisory's
 * `Reviewed-head:` body anchor (ADR 0151). `null` when it binds none — a pre-0058 SHA-less marker,
 * or an anchor-less advisory — which `isBoundToHead` then treats as never-current, fail-closed.
 */
export const boundHead = (body: string, gate: VerdictGate): string | null =>
	boundHeadShas(body, gate)[0] ?? null;

/**
 * The in-force pick: **filter to the live-head binding FIRST, latest-wins only among those.**
 *
 * This ordering is the whole fix for #4189 and it is ADR 0058's own rule: a verdict attests the
 * exact head it names, so the question "which verdict is in force" is first "which candidates
 * attest the head I am gating" and only then "which of those is newest". Picking by recency and
 * testing the head afterwards — on the winner alone — never consults the candidate that binds the
 * live head. Observed on PR #3955 — a green §CP PR that `verdict gate` refused for ~an hour because
 * a dead-head pair created at 00:32 outranked the live-head PASSes upserted at 00:49 into 00:09 slots.
 *
 * The fallback to the unfiltered set when NOTHING binds the live head is load-bearing, not a
 * loophole: it preserves the fail-closed classification downstream, which still reports the
 * `stale` / `sha-less` refusal with the offending comment named, exactly as before.
 *
 * Within the live-head set, latest-wins arbitrates — the arbitration the run-keyed upsert (#4016)
 * explicitly relies on to settle two surviving same-head verdicts — and it orders by WRITE recency,
 * not slot-creation time (`compareWriteRecency`, #4200). That distinction only bites here: when both
 * candidates bind the live head there is no staleness backstop, so a mis-pick is consumed at full
 * strength in either polarity.
 */
export const pickInForce = (
	comments: ReadonlyArray<VerdictComment>,
	authorizedAuthors: ReadonlyArray<string>,
	re: RegExp,
	gate: VerdictGate,
	headSha: string,
): VerdictComment | undefined => {
	const atHead = comments.filter((comment) =>
		isBoundToHead(boundHead(comment.body, gate), headSha),
	);
	return (
		pickLatestAuthorized(atHead, authorizedAuthors, re) ??
		pickLatestAuthorized(comments, authorizedAuthors, re)
	);
};

/**
 * Resolve the (PR, gate) verdict against the current head, re-encoding ADR 0058 rule 3
 * exactly: author-gate to write+ collaborators (a forged marker is invisible), keep only
 * PASS/FAIL markers in this namespace, take the in-force one (`pickInForce` — live-head
 * candidates first, latest-wins among them, so a newer FAIL vetoes an older PASS at the same
 * head and a re-review overwrites), then classify by the SHA-staleness test — `current` iff its
 * `@ <sha>` prefix-matches the head, else `stale`; `sha-less` when it carries no `@ <sha>`;
 * `none` when the authorized candidate set is empty. Fail-closed everywhere: an empty authorized
 * set is `none`, never a false win.
 *
 * This is the MARKER arm only — an advisory carries no polarity, so `polarityRe` deliberately never
 * matches one. The §CP-aware full resolution (marker ∪ advisory) is `decideNamespace` in
 * `gate-decision.ts`, which delegates its marker classification here so the two arms can't drift;
 * `Github.read` and `Github.gate` both consume THAT. Calling this directly answers "which bindable
 * marker is in force", never "which verdict is in force on a §CP PR" (#4049).
 */
export const resolveVerdict = (input: ResolveVerdictInput): VerdictOutcome => {
	const latest = pickInForce(
		input.comments,
		input.authorizedAuthors,
		polarityRe(input.gate),
		input.gate,
		input.headSha,
	);
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
 * The `read` verb's decision: is HEAD reviewed with the expected polarity? Expressed on
 * `verdictState` rather than on the raw tag, so it is satisfied by exactly what `verdict gate`
 * calls a pass (or a fail) and by nothing else — the anti-drift construction of #4049. `ship-it`
 * expects `PASS`; `write-code`-repair expects `FAIL` (the seam it consumes).
 */
export const isReviewed = (outcome: VerdictOutcome, expect: Polarity): boolean =>
	verdictState(outcome) === (expect === "PASS" ? "pass" : "fail");

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
		case "advisory-not-all-pass":
			return `unverified (§CP advisory at the current head is not all-PASS — a body checkbox is [FAIL]); its remedy is a re-review, not a repair round`;
		case "current":
			return outcome.polarity === expect
				? `reviewed: current-head ${outcome.polarity} @ ${outcome.sha}`
				: `current-head verdict is ${outcome.polarity}, expected ${expect}`;
	}
};

/**
 * The run-identity trailer `post` stamps on every verdict body it writes, and matches on to find
 * *its own* prior marker to upsert: an HTML comment (invisible in rendered markdown) carrying the
 * posting run's id.
 *
 * This is the missing dimension of the upsert key (#4016). Every pipeline review agent posts under
 * ONE shared GitHub identity, so "own-authored" does not distinguish reviewers — a concurrent
 * sibling in the same namespace matched the other reviewer's comment and PATCHed its verdict away,
 * server-side and silently. The run id (the agent's `CLAUDE_CODE_SESSION_ID`, the same
 * agent-distinguishable token ADR 0115 claims work under) is what the shared login cannot provide.
 *
 * Anchored per line with `m` so the trailer is matched wherever it sits in the body, and never
 * confused with prose that merely mentions one.
 */
const runTrailerRe =
	/^[ \t]*<!--[ \t]*verdict-run:[ \t]*([0-9A-Za-z][0-9A-Za-z._-]{7,127})[ \t]*-->[ \t]*$/m;

/**
 * The run id a verdict body was posted under, or `null` when it carries no trailer — a pre-#4016
 * marker, or one hand-rolled through raw `gh api`.
 */
export const runIdOf = (body: string): string | null =>
	runTrailerRe.exec(body)?.[1]?.toLowerCase() ?? null;

/**
 * A usable run id, or `null` for an absent/malformed one (an unset `CLAUDE_CODE_SESSION_ID`, a
 * value with whitespace or trailer-breaking characters). Every `null` here and in `runIdOf` is the
 * fail-safe: a run that cannot prove which marker is its own appends instead of upserting — an
 * extra comment, never a lost verdict.
 */
export const normalizeRunId = (raw: string | undefined | null): string | null => {
	const value = (raw ?? "").trim().toLowerCase();
	return /^[0-9a-z][0-9a-z._-]{7,127}$/.test(value) ? value : null;
};

/** Stamp `runId` onto a verdict body, replacing any trailer it already carries. */
export const withRunId = (body: string, runId: string): string =>
	`${body.replace(runTrailerRe, "").replace(/\s+$/, "")}\n\n<!-- verdict-run: ${runId} -->`;

/**
 * The `post` namespace guard: does this body's first line open with the gate's marker? A
 * verdict body must carry its OWN gate's marker on line one — `post`-ing a `review-code`
 * marker on a doc PR is the cross-namespace emission bug this refuses fail-closed. Accepts
 * every valid first line for the gate (PASS / FAIL / advisory), rejects any other gate's
 * marker and any non-marker first line.
 */
export const isNamespaceMarker = (body: string, gate: VerdictGate): boolean =>
	namespaceRe(gate).test(body);

/**
 * The `post` emission guard: does this body declare a PASS/FAIL polarity but carry no bindable
 * `@ <sha>` (≥7 hex)? Such a body posts an unbindable marker — the observed empty-SHA `@-` case
 * (#2646) — that the fail-closed read side then refuses (`sha-less`), false-BLOCKing a legitimate
 * ship until a manual re-post. `post` rejects it fail-closed at emission so the broken marker never
 * reaches GitHub. Keys on "polarity present ⇒ SHA required": an advisory (namespaced, no PASS/FAIL)
 * carries no polarity, so it returns false and stays postable SHA-less.
 */
export const isUnboundPolarityMarker = (body: string, gate: VerdictGate): boolean =>
	polarityRe(gate).test(body) && !verdictRe(gate).test(body);

/**
 * A well-formed EMITTED head SHA: the full 40-hex, terminated by whitespace or line/string end —
 * `(?=$|\s)` rejects a value that glues trailing garbage onto a hex prefix (`<40hex>/var/folders/…`)
 * as well as a bare non-hex path. This is deliberately STRICTER than the {7,40} read matchers
 * (`verdictRe` / ship-it's `Reviewed-head` read): staleness resolution must keep prefix-matching an
 * abbreviated SHA (ADR 0058 rule 3), but at EMISSION the full head SHA is always in hand, so an
 * emitted marker binds it exactly. Anything else is a defect the post guard refuses (#2683).
 */
const CLEAN_FULL_SHA = "[0-9a-f]{40}(?=$|\\s)";

const emittedMarkerRe = (gate: VerdictGate): RegExp =>
	new RegExp(
		`^\\s*\\*{0,2}\\s*${GATE_KEYWORD[gate]}:\\s*(?:PASS|FAIL)\\s*@\\s*${CLEAN_FULL_SHA}`,
		"i",
	);

const anyReviewedHeadLineRe = /^\s*Reviewed-head:/im;
const cleanReviewedHeadRe = new RegExp(`^\\s*Reviewed-head:\\s*@?\\s*${CLEAN_FULL_SHA}`, "im");

/**
 * The post-emission SHA-shape guard (#2683). A verdict body about to be POSTed must bind the FULL
 * 40-hex head SHA in every SHA field it carries; a partial/non-hex/path-glued value (the observed
 * `mktemp` scratch path leaked into the `@ <sha>` field on §CP PR #2680) both false-blocks ship-it
 * (the read side can't resolve it) and leaks a machine-local path into a public comment. Two fields
 * carry a SHA: the first-line PASS/FAIL marker's `@ <sha>`, and the §CP advisory's `Reviewed-head:`
 * anchor line (ADR 0151) — the latter is where the #2680 leak actually landed, invisible to the
 * first-line-only `isUnboundPolarityMarker`. Returns a human-readable defect description, or null
 * when every SHA field is a clean full 40-hex.
 */
export const malformedEmittedSha = (body: string, gate: VerdictGate): string | null => {
	if (polarityRe(gate).test(body) && !emittedMarkerRe(gate).test(body)) {
		return `the ${GATE_KEYWORD[gate]}: PASS/FAIL marker's '@ <sha>' is not a clean 40-hex head SHA — a partial/non-hex/path-glued value (e.g. an mktemp scratch path) false-blocks ship-it and leaks a machine-local path into a public comment (#2683)`;
	}
	if (anyReviewedHeadLineRe.test(body) && !cleanReviewedHeadRe.test(body)) {
		return `the 'Reviewed-head: @ <sha>' anchor line is not a clean 40-hex head SHA — the §CP advisory head binding (ADR 0151) leaked a non-hex/path value, the #2683 leak observed on PR #2680`;
	}
	return null;
};

/**
 * The `Reviewed-head:` anchor SHA (ADR 0151) — the §CP advisory's explicit head binding. Read-side
 * shape ({7,40} hex, `@`-optional) so the post-time cross-check can prefix-match an abbreviated
 * anchor against the live head; the stricter full-40-hex EMISSION shape is enforced separately by
 * `malformedEmittedSha`. Capture group 1 is the bound SHA.
 */
const reviewedHeadShaRe = /^\s*Reviewed-head:\s*@?\s*([0-9a-f]{7,40})/im;

/**
 * The head a §CP advisory binds itself to — its body's `Reviewed-head: @ <sha>` anchor (ADR 0151),
 * lowercased, or `null` when the body carries no well-formed anchor. A §CP advisory is SHA-less in
 * its FIRST line by design (ADR 0111), so this body anchor is the only head binding it has, and the
 * only thing that can make it a current-head verdict.
 */
export const reviewedHeadSha = (body: string): string | null =>
	reviewedHeadShaRe.exec(body)?.[1]?.toLowerCase() ?? null;

/**
 * Every head SHA a verdict body binds itself to: the first-line `PASS|FAIL @ <sha>` marker and the
 * §CP advisory's `Reviewed-head:` anchor. A SHA-less advisory binds nothing (empty array). These are
 * the fields the post-time cross-check (`headBindingDefect`) matches against the PR's live head.
 */
export const boundHeadShas = (body: string, gate: VerdictGate): ReadonlyArray<string> => {
	const shas: string[] = [];
	const parsed = parseVerdict(body, gate);
	if (parsed?.sha) shas.push(parsed.sha);
	const anchor = reviewedHeadShaRe.exec(body);
	if (anchor?.[1]) shas.push(anchor[1].toLowerCase());
	return shas;
};

/**
 * The HEAD dimension of the upsert key (#4007): do these two verdict bodies attest the SAME head?
 *
 * A verdict is SHA-bound (ADR 0058): a verdict bound to a different head is a **different fact**, not
 * a revision of the old one, so `post` may only PATCH a prior marker that attests the head the new
 * body attests. Without this, a re-gate at a new head edited the prior head's verdict in place — the
 * per-head history became unreconstructible from the PR surface, and a superseded-head marker could
 * mutate into a current-head one mid-queue (the mechanism behind #3982, where one comment went
 * FAIL → PASS → FAIL and the PR merged carrying a FAIL).
 *
 * The comparison is `isBoundToHead`'s prefix-match in either direction (rule 3), so an abbreviated
 * legacy binding still matches the full-40-hex head it names. Two bodies that bind NO head (a §CP
 * advisory with no `Reviewed-head:` anchor) are the same fact by construction and still upsert; a
 * bound body never matches an unbound one, so neither can overwrite the other.
 */
export const bindsSameHead = (a: string, b: string, gate: VerdictGate): boolean => {
	const headA = boundHead(a, gate);
	const headB = boundHead(b, gate);
	if (headA === null || headB === null) return headA === headB;
	return isBoundToHead(headA, headB);
};

/**
 * The post-time head cross-check (#3801) — the verdict-integrity hole this closes: a body composed
 * for PR B (bound to B's head SHA) that gets POSTed to PR A must be refused, because A's live head is
 * not B's. `emissionDefect` validates only marker *well-formedness*; the head-vs-target-PR binding
 * (`isBoundToHead`, ADR 0058 rule 3) was evaluated ONLY at read time, so a well-formed marker bound
 * to the WRONG PR's SHA was freely postable and caught only on read-back (and never at all if the
 * clobbering body happened to carry the victim's own head). This asserts, at post time, that every
 * SHA the body binds prefix-matches the target PR's current `head`. Returns the first mismatch as a
 * human-readable defect, or null when the body binds no SHA (a SHA-less advisory) or every bound SHA
 * matches the head. Fail-closed on an empty/unresolvable head: any bound SHA then mismatches (an
 * empty head is never `isBoundToHead`), so a body that binds a SHA is refused rather than posted
 * unverified — a SHA-less body still passes (nothing to verify).
 *
 * The two false-refusal cases the §CP guard-strengthening was weighed against (design note, per the
 * issue's AC1 — recorded here at the enforcement site rather than left a silent predicate):
 *
 *  1. A legit re-post racing a just-pushed head. A reviewer binds to head X, then someone force-pushes
 *     head Y before the `post` lands. This guard refuses the X-bound post. That refusal is CORRECT, not
 *     a false positive: a rebase/force-push staleness-invalidates the prior review (ADR 0058), so a
 *     verdict bound to X is genuinely un-attested for Y and must not be published against it — the same
 *     "rebase → re-review → ship is atomic" invariant, enforced one step earlier (at emit, not just at
 *     read). The reviewer re-resolves the head and re-reviews Y; nothing is lost.
 *  2. A deliberately stale-bound FAIL. Is posting a FAIL bound to an old head ever valid? No consumer
 *     honors it: `write-code`-repair reads `--expect FAIL` and acts ONLY on a `current`-head verdict, so
 *     a `stale` FAIL never drives repair anyway (it resolves `stale`, not satisfied). Refusing to POST a
 *     stale-bound FAIL removes nothing a reader would have used, and it keeps the namespace honest — a
 *     marker's `@ <sha>` always names the head it actually attests.
 */
export const headBindingDefect = (body: string, gate: VerdictGate, head: string): string | null => {
	for (const sha of boundHeadShas(body, gate)) {
		if (!isBoundToHead(sha, head)) {
			return `the verdict body binds head ${sha} but PR ${GATE_KEYWORD[gate]}'s current head is ${head || "<unresolved>"} — refusing to post a verdict bound to a DIFFERENT head (a cross-PR scratchpad clobber or a stale/rebased binding); re-review the current head and re-compose (ADR 0058 rule 3, #3801)`;
		}
	}
	return null;
};

/**
 * The single fail-closed gate every verdict EMISSION passes before it can reach GitHub — the one
 * source `Github.post` and `verdict validate` both consume so a raw-`gh api` skill and the tool
 * enforce identical rules. Returns the first structural defect (as a human-readable reason), or
 * null when the body is postable. Four ordered checks:
 *   1. cross-namespace — the first line must be *this* gate's marker (ADR 0058 §Scope); this also
 *      refuses the whole-body bare `@filepath` case, whose first line is not a marker (#2796);
 *   2. unbound polarity — a PASS/FAIL first line must carry a bindable `@ <sha>` (the `@-` bug, #2646);
 *   3. malformed emitted SHA — every SHA field (first-line marker + `Reviewed-head:` anchor) must be
 *      a clean full 40-hex, never a partial/non-hex/path-glued value (the mktemp-path leak, #2683/#2772);
 *   4. body-wide leak — NO machine-local path (home / `/var/folders` mktemp / `/private/tmp` / `/tmp`)
 *      anywhere in the body, closing the gap checks 1–3 miss: a temp path that sits in the verdict PROSE
 *      rather than a SHA field (checks 3's field-scan skips it) or a whole-body scratchpad ref would
 *      otherwise post a local path into a public comment (#2796/#2822). The verdict body must inline
 *      verdict TEXT with repo-relative paths only.
 */
export const emissionDefect = (body: string, gate: VerdictGate): string | null => {
	if (!isNamespaceMarker(body, gate)) {
		return `the body's first line is not a ${GATE_KEYWORD[gate]}: marker — a verdict must carry its own gate's marker on line one (the cross-namespace emission bug, ADR 0058 §Scope; also the whole-body bare @filepath case, #2796)`;
	}
	if (isUnboundPolarityMarker(body, gate)) {
		return `a ${GATE_KEYWORD[gate]}: PASS/FAIL verdict must carry a well-formed '@ <sha>' (≥7 hex) — this polarity-bearing body has an empty/malformed SHA, which posts an unbindable marker the fail-closed read side refuses (the '@-' emission bug, ADR 0058, #2646)`;
	}
	const shaDefect = malformedEmittedSha(body, gate);
	if (shaDefect !== null) return shaDefect;
	const leaks = findCommentLeaks(body);
	if (leaks.length > 0) {
		const leak = leaks[0];
		return `the verdict body carries a machine-local path (${leak?.matched} — ${leak?.reason}) — a verdict comment must inline verdict TEXT with repo-relative paths only, never a scratchpad/@-filepath ref or a temp path (the silent-gate-loss + path-leak recurrence, #2796/#2822/#2683/#2772)`;
	}
	return null;
};
