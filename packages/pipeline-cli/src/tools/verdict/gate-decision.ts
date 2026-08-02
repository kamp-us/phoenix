/**
 * The pure enqueue-gate core of `verdict gate` — ship-it Step 2's per-required-namespace
 * conjunction, made executable.
 *
 * Step 2's rule was already correct in prose ("code present but the review-code namespace is
 * empty → unverified (no review-code PASS)"), but nothing *computed* it: the shipper resolved
 * each namespace with a separate `verdict read` and then decided by eyeball whether the union
 * covered every required namespace. That leaves the ABSENCE branch to an agent's attention span,
 * and PR #3944 enqueued with no verdict bound to its live head at all (#3982). This core makes
 * absence a refusal by construction: the decision is a total function of (required namespaces,
 * comments, authorized authors, head), so "no verdict found" cannot read as "nothing blocking".
 *
 * Two forms of pass, and they are not interchangeable (ADR 0111/0151):
 *  - a NON-§CP namespace passes only on a bindable first-line `review-<gate>: PASS @ <sha>`;
 *  - a §CP namespace passes on the canonical SHA-less ADVISORY, whose head binding lives ONLY in
 *    the body's `Reviewed-head: @ <sha>` line. A §CP PR must never be required to carry (nor be
 *    satisfied by) a bindable first-line PASS — that drops the §CP verdict into the auto-merge
 *    namespace, the ADR 0111 hazard.
 * So `verdict read --gate code` legitimately resolving `none` on a §CP PR is the EXPECTED advisory
 * shape, not an absent verdict — which is exactly the confusion a bolted-on absence check would
 * make, refusing every §CP enqueue.
 */
import {
	boundHead,
	compareWriteRecency,
	GATE_KEYWORD,
	GATES,
	isBoundToHead,
	outcomeCommentId,
	outcomeSha,
	pickInForce,
	polarityRe,
	resolveVerdict,
	reviewedHeadSha,
	type VerdictComment,
	type VerdictGate,
	type VerdictOutcome,
	type VerdictState,
	verdictState,
} from "./verdict-match.ts";

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

/** Which verdict FORM satisfied (or was found in) a namespace — the ADR 0111 distinction. */
export type VerdictForm = "marker" | "advisory" | "none";

/**
 * One namespace's resolved verdict against the PR's live head — the SINGLE resolution record both
 * `verdict gate` and `verdict read` are computed from (#4049 AC2).
 *
 * `outcome` is the resolution; `state`, `commentId` and `sha` are DERIVED from it, never computed a
 * second way. That is what makes the two verbs structurally unable to disagree: `gate` reads
 * `state`, `read` prints `outcome` and tests it with `isReviewed`, and both go through
 * `verdictState`.
 */
export interface NamespaceDecision {
	readonly gate: VerdictGate;
	/** `review-code` / `review-doc` / `review-skill` / `review-design` — the namespace label. */
	readonly namespace: string;
	/**
	 * `pass` — a current-head PASS (or §CP PASS-equivalent advisory) stands.
	 * `fail` — the newest current-head verdict is a FAIL (the veto; the repair round-trip is the author's).
	 * `absent` — NO consumable verdict exists in this namespace at all (the #3944 hole).
	 * `unverified` — a verdict exists but is not bound to the live head (stale / SHA-less / not-all-PASS).
	 */
	readonly state: VerdictState;
	readonly form: VerdictForm;
	/** The resolved verdict itself — what `verdict read` prints and branches on. */
	readonly outcome: VerdictOutcome;
	readonly commentId: number | null;
	/** The head the found verdict binds, when it binds one. */
	readonly sha: string | null;
	readonly reason: string;
}

/** The per-namespace inputs — `GateDecisionInput` minus the required SET (a property of the whole PR). */
export interface NamespaceInput {
	readonly comments: ReadonlyArray<VerdictComment>;
	/** The write+ collaborator logins — the ADR 0055 trust root (resolved by the IO shell). */
	readonly authorizedAuthors: ReadonlyArray<string>;
	/** The PR's live head SHA — the head every verdict must bind (ADR 0058 rule 3). */
	readonly headSha: string;
	/** Is this a §CP (control-plane / blocking-set) PR, whose pass path is the advisory (ADR 0111/0151)? */
	readonly controlPlane: boolean;
}

export interface GateDecisionInput extends NamespaceInput {
	/**
	 * Every namespace this PR's diff requires — the `class-probe classify --namespaces` set, which
	 * derives one gate per artifact class present plus `review-design` when the diff is UI-affecting.
	 * A PR spanning an ADR plus a `.glossary/**` row requires BOTH review-doc AND review-code
	 * (`.glossary/**` rides has-code), and satisfying only one must not be enough.
	 */
	readonly requiredGates: ReadonlyArray<VerdictGate>;
}

export interface GateDecision {
	/** May the merge authority enqueue? True ONLY when every required namespace resolved `pass`. */
	readonly enqueueable: boolean;
	readonly decisions: ReadonlyArray<NamespaceDecision>;
	/** The single named outcome line — a ship-it refusal reason, or the clearance. */
	readonly reason: string;
}

/** Newest of two optional candidates — the same write-recency key `pickLatestAuthorized` orders by. */
const newerOf = (
	a: VerdictComment | undefined,
	b: VerdictComment | undefined,
): VerdictComment | undefined => {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return compareWriteRecency(a, b) > 0 ? a : b;
};

/**
 * The in-force one of the two forms — the same live-head-first rule `pickInForce` applies WITHIN a
 * form, applied ACROSS them (#4189): a candidate bound to the live head strictly outranks one that
 * is not, and recency decides only when both bind it (or neither does, where the fallback keeps the
 * existing stale/SHA-less refusal intact). See `pickInForce` for why recency alone is not the key.
 */
const inForceOf = (
	a: VerdictComment | undefined,
	b: VerdictComment | undefined,
	gate: VerdictGate,
	headSha: string,
): VerdictComment | undefined => {
	const aAtHead = a !== undefined && isBoundToHead(boundHead(a.body, gate), headSha);
	const bAtHead = b !== undefined && isBoundToHead(boundHead(b.body, gate), headSha);
	if (aAtHead !== bAtHead) return aAtHead ? a : b;
	return newerOf(a, b);
};

/** What an arm resolves; `state`/`commentId`/`sha` are then derived from `outcome`, never restated. */
interface Resolution {
	readonly outcome: VerdictOutcome;
	readonly form: VerdictForm;
	readonly reason: string;
}

/**
 * The §CP advisory arm: classify an advisory that won the in-force pick by its ADR-0151 body anchor.
 * The marker arm is `resolveVerdict` (which this file does not duplicate) — the two are the only
 * ways a namespace resolves.
 */
const resolveAdvisory = (
	advisory: VerdictComment,
	namespace: string,
	headSha: string,
): Resolution => {
	const sha = reviewedHeadSha(advisory.body);
	if (sha === null) {
		return {
			outcome: {_tag: "sha-less", commentId: advisory.id, polarity: "PASS"},
			form: "advisory",
			reason: `unverified (§CP ${namespace} advisory carries no 'Reviewed-head: @ <sha>' body binding — an advisory is SHA-less in line 1 by design, so the body anchor is its only head binding, ADR 0151)`,
		};
	}
	if (!isBoundToHead(sha, headSha)) {
		return {
			outcome: {_tag: "stale", commentId: advisory.id, polarity: "PASS", sha},
			form: "advisory",
			reason: `unverified (§CP ${namespace} advisory reviewed-head stale — body @ ${sha} ≠ current head ${headSha})`,
		};
	}
	if (failCheckboxRe.test(advisory.body)) {
		return {
			outcome: {_tag: "advisory-not-all-pass", commentId: advisory.id, sha},
			form: "advisory",
			reason: `unverified (§CP ${namespace} advisory not all-PASS — a body checkbox is [FAIL])`,
		};
	}
	return {
		outcome: {_tag: "current", commentId: advisory.id, polarity: "PASS", sha},
		form: "advisory",
		reason: `§CP ${namespace} advisory at the current head, all-PASS — the ADR 0111/0151 PASS-equivalent`,
	};
};

/**
 * The marker arm — DELEGATED to `resolveVerdict` rather than re-deriving its four-way
 * classification: it re-runs the identical `pickInForce(polarityRe(gate), …)` call that produced the
 * marker candidate, so it resolves the same comment by construction, and ADR 0058's staleness rule
 * stays written in exactly one place. Only the reason line is this file's.
 */
const resolveMarker = (gate: VerdictGate, namespace: string, input: NamespaceInput): Resolution => {
	const outcome = resolveVerdict({
		comments: input.comments,
		authorizedAuthors: input.authorizedAuthors,
		gate,
		headSha: input.headSha,
	});
	return {
		outcome,
		form: outcome._tag === "none" ? "none" : "marker",
		reason: markerReason(outcome, namespace, input.headSha),
	};
};

/** The marker arm's reason line — the classification itself is `resolveVerdict`'s. */
const markerReason = (outcome: VerdictOutcome, namespace: string, headSha: string): string => {
	switch (outcome._tag) {
		case "none":
			return `unverified (no ${namespace} PASS): the latest authorized comment in this namespace carries no readable polarity`;
		case "sha-less":
			return `unverified (verdict not bound to current head): the latest ${namespace} marker is SHA-less (pre-0058)`;
		case "stale":
			return `unverified (verdict not bound to current head): the latest ${namespace} marker binds ${outcome.sha}, not the current head ${headSha}`;
		case "current":
			return outcome.polarity === "PASS"
				? `current-head ${namespace} PASS @ ${outcome.sha}`
				: `latest verdict is FAIL (${namespace}) @ ${outcome.sha}`;
		case "advisory-not-all-pass":
			// Unreachable: `resolveVerdict` is polarity-scoped and never sees an advisory.
			return `unverified (${namespace}): an advisory reached the marker arm`;
	}
};

/**
 * Resolve ONE namespace against the live head — the single in-force resolution `verdict gate` folds
 * over its required set and `verdict read` reads for its one gate (#4049).
 */
export const decideNamespace = (gate: VerdictGate, input: NamespaceInput): NamespaceDecision => {
	const namespace = GATE_KEYWORD[gate];
	const marker = pickInForce(
		input.comments,
		input.authorizedAuthors,
		polarityRe(gate),
		gate,
		input.headSha,
	);
	// A non-§CP PR's advisory is NOT a candidate at all: it carries no bindable head and is not a
	// PASS, so it must neither satisfy the namespace nor shadow an older bindable marker.
	const advisory = input.controlPlane
		? pickInForce(input.comments, input.authorizedAuthors, advisoryRe(gate), gate, input.headSha)
		: undefined;
	const latest = inForceOf(marker, advisory, gate, input.headSha);

	const resolution: Resolution =
		latest === undefined
			? {
					outcome: {_tag: "none"},
					form: "none",
					reason: input.controlPlane
						? `unverified (no ${namespace} PASS): no authorized ${namespace} verdict on this PR — neither a bindable PASS marker nor a §CP advisory`
						: `unverified (no ${namespace} PASS): no authorized ${namespace} verdict on this PR at all`,
				}
			: latest === advisory
				? resolveAdvisory(latest, namespace, input.headSha)
				: resolveMarker(gate, namespace, input);

	return {
		gate,
		namespace,
		state: verdictState(resolution.outcome),
		form: resolution.form,
		outcome: resolution.outcome,
		commentId: outcomeCommentId(resolution.outcome),
		sha: outcomeSha(resolution.outcome),
		reason: resolution.reason,
	};
};

/**
 * The enqueue decision: `enqueueable` iff EVERY required namespace resolves to a current-head PASS
 * (or, for a §CP PR, a current-head all-PASS advisory). Every other state — absent, stale, SHA-less,
 * not-all-PASS, FAIL — refuses with that namespace's named reason.
 *
 * Fail-closed on its own inputs, not just on the verdicts (ADR 0092):
 *  - an EMPTY required set refuses. Zero required gates would make the conjunction vacuously true,
 *    which is the un-gated merge dressed as a clean pass — the same zero-scope hole `class-probe`
 *    closes on a dropped stdin (#3786).
 *  - an EMPTY head refuses. With no head to bind against, `isBoundToHead` can never be satisfied,
 *    so an unresolvable head must be a named refusal rather than a silent all-stale sweep.
 * A FAIL anywhere is reported ahead of the other refusals: it is the one outcome with a different
 * remedy (the author's repair round-trip, not a re-review or a fresh gate run).
 */
export const decideGate = (input: GateDecisionInput): GateDecision => {
	if (input.requiredGates.length === 0) {
		return {
			enqueueable: false,
			decisions: [],
			reason:
				"refused (fail-closed, zero scope): no required review namespace was supplied — a zero-length required set makes the per-namespace conjunction vacuously true, i.e. an un-gated merge reported as a pass. Derive the set with `pipeline-cli class-probe classify --namespaces` (ADR 0092, #3786).",
		};
	}
	if (input.headSha.trim().length === 0) {
		return {
			enqueueable: false,
			decisions: [],
			reason:
				"refused (fail-closed): the PR's head SHA is empty/unresolvable — no verdict can be proven bound to a head that isn't known (ADR 0058 rule 3).",
		};
	}
	const decisions = [...new Set(input.requiredGates)].map((gate) => decideNamespace(gate, input));
	const failed = decisions.find((d) => d.state === "fail");
	const blocked = failed ?? decisions.find((d) => d.state !== "pass");
	if (blocked !== undefined) {
		const required = decisions.map((d) => d.namespace).join(" + ");
		return {
			enqueueable: false,
			decisions,
			reason: `refused — ${blocked.reason} [required: ${required}; head ${input.headSha}]`,
		};
	}
	return {
		enqueueable: true,
		decisions,
		reason: `enqueueable — every required namespace carries a current-head pass: ${decisions
			.map((d) => `${d.namespace} (${d.form})`)
			.join(" + ")} @ ${input.headSha}`,
	};
};

/** What `parseRequiredGates` resolved: the union of every occurrence, or the input error that refuses. */
export type RequiredParse =
	| {readonly _tag: "ok"; readonly gates: ReadonlyArray<VerdictGate>}
	| {readonly _tag: "error"; readonly reason: string};

/**
 * Parse the required-namespace set out of EVERY `--require` occurrence, tolerating both shapes the
 * producer emits: `class-probe classify --namespaces` output (`review-code`) and a bare gate name
 * (`code`). The occurrences are UNIONED, so `--require a --require b` and `--require a,b` are the
 * same required set — the flag-shape parity #4520 found broken.
 *
 * Taking `ReadonlyArray<string>` rather than `string` is the whole fix, and it is a type-level one:
 * the single-valued `Flag.string("require")` handed this function ONE occurrence, so every later
 * `--require` was dropped by the flag layer, upstream of the unrecognized-token refusal below —
 * which meant a guard whose stated purpose is "never shrink the gate conjunction" was structurally
 * unreachable for occurrence 2..n, born dead rather than drifted. With the flag now repeatable
 * (`Flag.atLeast(1)`), every occurrence reaches this parse and a bogus token in ANY of them refuses.
 */
export const parseRequiredGates = (occurrences: ReadonlyArray<string>): RequiredParse => {
	const tokens = occurrences
		.flatMap((raw) => raw.split(/[\s,]+/))
		.map((t) => t.trim().toLowerCase())
		.filter((t) => t.length > 0);
	const gates: VerdictGate[] = [];
	for (const token of tokens) {
		const name = token.startsWith("review-") ? token.slice("review-".length) : token;
		if (!(GATES as ReadonlyArray<string>).includes(name)) {
			return {
				_tag: "error",
				reason: `unrecognized required namespace '${token}' — expected review-<gate> or <gate>, one of ${GATES.join(" | ")}. Refusing to drop it from the required set (that would shrink the gate conjunction).`,
			};
		}
		gates.push(name as VerdictGate);
	}
	return {_tag: "ok", gates};
};

/**
 * The coverage assertion: an AFFIRMATIVE gate answer must be about exactly the namespaces it was
 * asked about — `decisions` must be one per DISTINCT requested gate, no more and no fewer.
 *
 * This is the general form of #4520, and it is the part that outlives the specific spelling.
 * Repeatable `--require` fixes the one path where a namespace went missing; this refuses ANY future
 * path that answers about fewer things than it was asked, because the defect's signature is a
 * *plausible value* rather than an error — the answer runs, exits clean, and is well-formed, just
 * smaller. The natural guards (did it run? did it exit 0? did it return a set?) are all satisfied by
 * the wrong answer, so only an explicit count can see it.
 *
 * The operands come from two different origins on purpose (`.patterns/skill-script-shell-shape.md`'s
 * rule, same idea): the requested set is the CLI's own parse of argv, the answered set comes back
 * over the `Github` service boundary. An assertion that re-derived `decisions` from `requiredGates`
 * inside `decideGate` would be true by construction and could never fire.
 *
 * Applied to a pass only: a refusal already refuses, and its own reason is the more useful one.
 */
export const coverageDefect = (
	requested: ReadonlyArray<VerdictGate>,
	decision: GateDecision,
): string | null => {
	const distinct = new Set(requested);
	const answered = new Set(decision.decisions.map((d) => d.gate));
	const missing = [...distinct].filter((g) => !answered.has(g));
	const extra = [...answered].filter((g) => !distinct.has(g));
	if (missing.length === 0 && extra.length === 0 && decision.decisions.length === distinct.size) {
		return null;
	}
	return `refused (fail-closed, coverage): the gate answered about ${decision.decisions.length} namespace(s) [${[...answered].join(", ") || "none"}] but was asked about ${distinct.size} [${[...distinct].join(", ") || "none"}]${missing.length > 0 ? ` — NEVER decided: ${missing.join(", ")}` : ""}${extra.length > 0 ? ` — decided unasked: ${extra.join(", ")}` : ""}. A pass that covers fewer namespaces than were required is an un-gated merge reported as a clean one (#4520).`;
};
