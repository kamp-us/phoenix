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
 *
 * `resolveVerdict` is the ONE notion of "which verdict is in force" (#4049). It used to answer that
 * by polarity-matching alone, while `gate-decision.ts` answered it by latest-wins across marker AND
 * §CP advisory — so on a §CP PR whose body-only repair left the head deliberately unmoved, a
 * superseded same-head FAIL stayed resolvable as current to `read` forever while `gate` correctly
 * saw the newer advisory. Consumer-dependent divergence on the same marker set is the defect; the
 * fix is that `gate` now projects THIS resolution rather than computing a second one.
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

/**
 * The §CP advisory first line: `review-<gate>: advisory — blocking-set PR (manual merge)`. Anchored
 * to the first line like every other marker matcher, and deliberately NOT polarity-bearing — an
 * advisory carries no PASS/FAIL, so `polarityRe` never matches it and the two candidate sets are
 * disjoint.
 */
export const advisoryRe = (gate: VerdictGate): RegExp =>
	new RegExp(`^\\s*\\*{0,2}\\s*${GATE_KEYWORD[gate]}:\\s*advisory\\b`, "i");

/** A recorded `[FAIL]` checkbox anywhere in an advisory body — the not-all-PASS tell. */
const failCheckboxRe = /^\s*[-*]?\s*\[\s*FAIL\s*\]/im;

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

/**
 * Which verdict FORM is in force — the ADR 0111/0151 distinction between a bindable first-line
 * `PASS|FAIL @ <sha>` marker and the §CP advisory, whose head binding lives only in its body's
 * `Reviewed-head:` anchor. `none` is the empty namespace.
 */
export type VerdictForm = "marker" | "advisory" | "none";

/** The resolved verdict for a (PR, gate) against the current head — the in-force artifact's state. */
export type VerdictOutcome =
	/** No authorized verdict artifact in this namespace (or the authorized set was empty). */
	| {readonly _tag: "none"; readonly form: "none"}
	/**
	 * Nothing binds the in-force artifact to a head: a pre-0058 marker with no `@ <sha>`, or a §CP
	 * advisory with no `Reviewed-head:` anchor (an advisory is SHA-less in line 1 by design, so the
	 * body anchor is its only binding — ADR 0151). `polarity` is null for the advisory form, which
	 * carries no PASS/FAIL. Refuse either way.
	 */
	| {
			readonly _tag: "sha-less";
			readonly form: "marker" | "advisory";
			readonly commentId: number;
			readonly polarity: Polarity | null;
	  }
	/** The in-force artifact binds a different (stale) head — refuse. */
	| {
			readonly _tag: "stale";
			readonly form: "marker" | "advisory";
			readonly commentId: number;
			readonly polarity: Polarity | null;
			readonly sha: string;
	  }
	/**
	 * The in-force artifact binds the current head and carries a polarity — a marker's own PASS/FAIL,
	 * or a §CP all-PASS advisory read as the ADR 0111/0151 PASS-equivalent.
	 */
	| {
			readonly _tag: "current";
			readonly form: "marker" | "advisory";
			readonly commentId: number;
			readonly polarity: Polarity;
			readonly sha: string;
	  }
	/**
	 * The in-force §CP advisory binds the current head but records a `[FAIL]` checkbox, so it is not
	 * the all-PASS PASS-equivalent — and it is not a marker FAIL either (its remedy is a re-review,
	 * not the author's repair round-trip). Its own terminal state, refused by both polarities.
	 */
	| {
			readonly _tag: "advisory-not-all-pass";
			readonly form: "advisory";
			readonly commentId: number;
			readonly sha: string;
	  };

/**
 * The four states a namespace resolves to — the vocabulary `verdict gate` reports per required
 * namespace, and the same projection `read`'s `--expect` matches against, so the two verbs cannot
 * disagree about which verdict is in force (#4049).
 */
export type VerdictState = "pass" | "fail" | "absent" | "unverified";

export interface ResolveVerdictInput {
	readonly comments: ReadonlyArray<VerdictComment>;
	/** The write+ collaborator logins — the ADR 0055 trust root (resolved by the IO shell). */
	readonly authorizedAuthors: ReadonlyArray<string>;
	readonly gate: VerdictGate;
	/** The PR's current head SHA every verdict must be bound to (ADR 0058 rule 3). */
	readonly headSha: string;
	/**
	 * Is this a §CP (control-plane / blocking-set) PR, whose verdict form is the SHA-less advisory
	 * (ADR 0111/0151)? Required, never defaulted: on a §CP PR the advisory is the newest artifact a
	 * body-only repair leaves behind, and omitting it is exactly the #4049 divergence — a superseded
	 * same-head FAIL resolving as the in-force verdict forever. A non-§CP PR's advisory is not a
	 * candidate at all: it is not a PASS and binds no head in line one, so it must neither satisfy
	 * the namespace nor shadow an older bindable marker.
	 */
	readonly controlPlane: boolean;
}

/** Newest of two optional candidates by `(createdAt, id)` — the same latest-wins key as the markers. */
const newerOf = (
	a: VerdictComment | undefined,
	b: VerdictComment | undefined,
): VerdictComment | undefined => {
	if (a === undefined) return b;
	if (b === undefined) return a;
	if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b;
	return a.id > b.id ? a : b;
};

/**
 * Classify a §CP advisory that won the latest-wins pick: its head binding is the body's
 * `Reviewed-head:` anchor (ADR 0151), and it is the PASS-equivalent only when every recorded
 * checkbox is `[PASS]`.
 */
const resolveAdvisory = (advisory: VerdictComment, headSha: string): VerdictOutcome => {
	const sha = reviewedHeadSha(advisory.body);
	if (sha === null) {
		return {_tag: "sha-less", form: "advisory", commentId: advisory.id, polarity: null};
	}
	if (!isBoundToHead(sha, headSha)) {
		return {_tag: "stale", form: "advisory", commentId: advisory.id, polarity: null, sha};
	}
	if (failCheckboxRe.test(advisory.body)) {
		return {_tag: "advisory-not-all-pass", form: "advisory", commentId: advisory.id, sha};
	}
	return {_tag: "current", form: "advisory", commentId: advisory.id, polarity: "PASS", sha};
};

/**
 * The latest-wins pick, shared by `resolveVerdict` and the §CP advisory resolution: among the
 * comments an authorized (write+, ADR 0055) author posted whose body matches `re`, the newest by
 * `(createdAt, id)`. `undefined` when the authorized candidate set is empty — the fail-closed
 * "nothing to consume in this namespace", never a false win.
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
	candidates.sort((a, b) =>
		a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id,
	);
	return candidates[candidates.length - 1];
};

/**
 * Resolve which verdict is IN FORCE for a (PR, gate) against the current head — the single
 * resolution `verdict read` and `verdict gate` both consume (#4049).
 *
 * Author-gate to write+ collaborators (a forged artifact is invisible, ADR 0055), take the
 * **newest** authorized artifact by `(createdAt, id)` across the namespace's candidate forms — the
 * PASS/FAIL markers always, plus the §CP advisory when `controlPlane` — then classify it by the
 * ADR-0058 rule-3 staleness test against its own head binding (a marker's `@ <sha>`; an advisory's
 * body `Reviewed-head:` anchor).
 *
 * Latest-wins across BOTH forms is the load-bearing part. A §CP body-only repair deliberately does
 * not move the head — moving it would dismiss the control-plane approval and force a full
 * re-review — so staleness-invalidation cannot retire the superseded FAIL markers it repaired, and
 * a polarity-only candidate set (which an advisory, carrying no PASS/FAIL, can never enter) keeps
 * resolving one of them as current forever (#4049). Recency across the whole namespace is what
 * retires them; nothing here moves or needs the head to move.
 *
 * Fail-closed everywhere: an empty authorized set is `none`, never a false win.
 */
export const resolveVerdict = (input: ResolveVerdictInput): VerdictOutcome => {
	const marker = pickLatestAuthorized(
		input.comments,
		input.authorizedAuthors,
		polarityRe(input.gate),
	);
	const advisory = input.controlPlane
		? pickLatestAuthorized(input.comments, input.authorizedAuthors, advisoryRe(input.gate))
		: undefined;
	const latest = newerOf(marker, advisory);
	if (latest === undefined) return {_tag: "none", form: "none"};
	if (latest === advisory) return resolveAdvisory(latest, input.headSha);
	// `parseVerdict` is null only for a non-PASS/FAIL body, which `polarityRe` already excluded —
	// the unreachable branch collapses into the same fail-closed `none` rather than a non-null assert.
	const parsed = parseVerdict(latest.body, input.gate);
	if (parsed === null) return {_tag: "none", form: "none"};
	if (parsed.sha === null) {
		return {_tag: "sha-less", form: "marker", commentId: latest.id, polarity: parsed.polarity};
	}
	if (!isBoundToHead(parsed.sha, input.headSha)) {
		return {
			_tag: "stale",
			form: "marker",
			commentId: latest.id,
			polarity: parsed.polarity,
			sha: parsed.sha,
		};
	}
	return {
		_tag: "current",
		form: "marker",
		commentId: latest.id,
		polarity: parsed.polarity,
		sha: parsed.sha,
	};
};

/**
 * Project a resolved outcome onto the four namespace states. This is the ONE place "is the in-force
 * verdict a pass / a fail / absent / unverified" is decided, so `read`'s `--expect` match and
 * `gate`'s per-namespace conjunction are the same question asked twice, not two rules (#4049).
 */
export const verdictState = (outcome: VerdictOutcome): VerdictState => {
	if (outcome._tag === "none") return "absent";
	if (outcome._tag === "current") return outcome.polarity === "PASS" ? "pass" : "fail";
	return "unverified";
};

/**
 * The `read` verb's decision: is HEAD reviewed with the expected polarity? True **only** when the
 * in-force verdict's state matches — `ship-it` expects `PASS`, `write-code`-repair expects `FAIL`
 * (the seam it consumes). Expressed through `verdictState` so a `read --expect PASS` is satisfied
 * by exactly what `gate` calls a pass, and `--expect FAIL` by exactly what `gate` calls a fail.
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
			return outcome.form === "advisory"
				? "unverified (verdict not bound to current head): the §CP advisory carries no 'Reviewed-head: @ <sha>' body binding (ADR 0151)"
				: "unverified (verdict not bound to current head): latest marker is SHA-less (pre-0058)";
		case "stale":
			return outcome.form === "advisory"
				? `unverified (verdict not bound to current head): the §CP advisory's Reviewed-head is ${outcome.sha}, not the current head`
				: `unverified (verdict not bound to current head): latest marker bound to ${outcome.sha}, not the current head`;
		case "advisory-not-all-pass":
			return `unverified (§CP advisory @ ${outcome.sha} is not all-PASS — a body checkbox is [FAIL])`;
		case "current":
			if (outcome.polarity !== expect) {
				return `current-head verdict is ${outcome.polarity}, expected ${expect}`;
			}
			return outcome.form === "advisory"
				? `reviewed: current-head §CP all-PASS advisory @ ${outcome.sha} (the ADR 0111/0151 PASS-equivalent)`
				: `reviewed: current-head ${outcome.polarity} @ ${outcome.sha}`;
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
