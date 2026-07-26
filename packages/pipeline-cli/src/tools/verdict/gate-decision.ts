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
	isBoundToHead,
	parseVerdict,
	pickInForce,
	polarityRe,
	reviewedHeadSha,
	type VerdictComment,
	type VerdictGate,
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

/** One required namespace's resolved state against the PR's live head. */
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
	readonly state: "pass" | "fail" | "absent" | "unverified";
	readonly form: VerdictForm;
	readonly commentId: number | null;
	/** The head the found verdict binds, when it binds one. */
	readonly sha: string | null;
	readonly reason: string;
}

export interface GateDecisionInput {
	readonly comments: ReadonlyArray<VerdictComment>;
	/** The write+ collaborator logins — the ADR 0055 trust root (resolved by the IO shell). */
	readonly authorizedAuthors: ReadonlyArray<string>;
	/**
	 * Every namespace this PR's diff requires — the `class-probe classify --namespaces` set, which
	 * derives one gate per artifact class present plus `review-design` when the diff is UI-affecting.
	 * A PR spanning an ADR plus a `.glossary/**` row requires BOTH review-doc AND review-code
	 * (`.glossary/**` rides has-code), and satisfying only one must not be enough.
	 */
	readonly requiredGates: ReadonlyArray<VerdictGate>;
	/** The PR's live head SHA — the head every verdict must bind (ADR 0058 rule 3). */
	readonly headSha: string;
	/** Is this a §CP (control-plane / blocking-set) PR, whose pass path is the advisory (ADR 0111/0151)? */
	readonly controlPlane: boolean;
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

const decideNamespace = (gate: VerdictGate, input: GateDecisionInput): NamespaceDecision => {
	const namespace = GATE_KEYWORD[gate];
	const base = {gate, namespace} as const;
	const marker = pickInForce(
		input.comments,
		input.authorizedAuthors,
		polarityRe(gate),
		gate,
		input.headSha,
	);
	// A non-§CP PR's advisory is NOT a candidate at all: it carries no bindable head and is not a
	// PASS, so it must neither satisfy the namespace nor shadow an older bindable marker — exactly
	// what `verdict read` already does by matching on `polarityRe` only.
	const advisory = input.controlPlane
		? pickInForce(input.comments, input.authorizedAuthors, advisoryRe(gate), gate, input.headSha)
		: undefined;
	const latest = inForceOf(marker, advisory, gate, input.headSha);

	if (latest === undefined) {
		return {
			...base,
			state: "absent",
			form: "none",
			commentId: null,
			sha: null,
			reason: input.controlPlane
				? `unverified (no ${namespace} PASS): no authorized ${namespace} verdict on this PR — neither a bindable PASS marker nor a §CP advisory`
				: `unverified (no ${namespace} PASS): no authorized ${namespace} verdict on this PR at all`,
		};
	}

	if (latest === advisory) {
		const sha = reviewedHeadSha(latest.body);
		if (sha === null) {
			return {
				...base,
				state: "unverified",
				form: "advisory",
				commentId: latest.id,
				sha: null,
				reason: `unverified (§CP ${namespace} advisory carries no 'Reviewed-head: @ <sha>' body binding — an advisory is SHA-less in line 1 by design, so the body anchor is its only head binding, ADR 0151)`,
			};
		}
		if (!isBoundToHead(sha, input.headSha)) {
			return {
				...base,
				state: "unverified",
				form: "advisory",
				commentId: latest.id,
				sha,
				reason: `unverified (§CP ${namespace} advisory reviewed-head stale — body @ ${sha} ≠ current head ${input.headSha})`,
			};
		}
		if (failCheckboxRe.test(latest.body)) {
			return {
				...base,
				state: "unverified",
				form: "advisory",
				commentId: latest.id,
				sha,
				reason: `unverified (§CP ${namespace} advisory not all-PASS — a body checkbox is [FAIL])`,
			};
		}
		return {
			...base,
			state: "pass",
			form: "advisory",
			commentId: latest.id,
			sha,
			reason: `§CP ${namespace} advisory at the current head, all-PASS — the ADR 0111/0151 PASS-equivalent`,
		};
	}

	// `polarityRe` matched, so `parseVerdict` cannot be null here — the `?? null` collapses the
	// unreachable branch into the same fail-closed `absent` rather than asserting non-null.
	const parsed = parseVerdict(latest.body, gate);
	if (parsed === null) {
		return {
			...base,
			state: "absent",
			form: "none",
			commentId: latest.id,
			sha: null,
			reason: `unverified (no ${namespace} PASS): the latest authorized comment in this namespace carries no readable polarity`,
		};
	}
	if (parsed.sha === null) {
		return {
			...base,
			state: "unverified",
			form: "marker",
			commentId: latest.id,
			sha: null,
			reason: `unverified (verdict not bound to current head): the latest ${namespace} marker is SHA-less (pre-0058)`,
		};
	}
	if (!isBoundToHead(parsed.sha, input.headSha)) {
		return {
			...base,
			state: "unverified",
			form: "marker",
			commentId: latest.id,
			sha: parsed.sha,
			reason: `unverified (verdict not bound to current head): the latest ${namespace} marker binds ${parsed.sha}, not the current head ${input.headSha}`,
		};
	}
	return {
		...base,
		state: parsed.polarity === "PASS" ? "pass" : "fail",
		form: "marker",
		commentId: latest.id,
		sha: parsed.sha,
		reason:
			parsed.polarity === "PASS"
				? `current-head ${namespace} PASS @ ${parsed.sha}`
				: `latest verdict is FAIL (${namespace}) @ ${parsed.sha}`,
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
