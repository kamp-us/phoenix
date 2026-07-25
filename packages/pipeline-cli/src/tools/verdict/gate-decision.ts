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
 * So a §CP namespace whose only artifact is the advisory is a legitimate pass, not an absent verdict
 * — which is exactly the confusion a bolted-on absence check would make, refusing every §CP enqueue.
 *
 * This module decides the SET; it no longer decides which verdict is in force in a single namespace.
 * That is `resolveVerdict`'s, whose §CP-aware latest-wins pick `read` consumes too — one resolution,
 * two verbs, so a superseded same-head FAIL cannot be current to one and superseded to the other
 * (#4049).
 */
import {
	GATE_KEYWORD,
	resolveVerdict,
	type VerdictComment,
	type VerdictForm,
	type VerdictGate,
	type VerdictOutcome,
	type VerdictState,
	verdictState,
} from "./verdict-match.ts";

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
	readonly state: VerdictState;
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

/**
 * The namespace-labelled prose for a resolved outcome. Prose only — the *decision* it narrates was
 * already made by `resolveVerdict`, so there is no second rule here to drift from `read`'s.
 */
const namespaceReason = (
	namespace: string,
	outcome: VerdictOutcome,
	input: GateDecisionInput,
): string => {
	switch (outcome._tag) {
		case "none":
			return input.controlPlane
				? `unverified (no ${namespace} PASS): no authorized ${namespace} verdict on this PR — neither a bindable PASS marker nor a §CP advisory`
				: `unverified (no ${namespace} PASS): no authorized ${namespace} verdict on this PR at all`;
		case "sha-less":
			return outcome.form === "advisory"
				? `unverified (§CP ${namespace} advisory carries no 'Reviewed-head: @ <sha>' body binding — an advisory is SHA-less in line 1 by design, so the body anchor is its only head binding, ADR 0151)`
				: `unverified (verdict not bound to current head): the latest ${namespace} marker is SHA-less (pre-0058)`;
		case "stale":
			return outcome.form === "advisory"
				? `unverified (§CP ${namespace} advisory reviewed-head stale — body @ ${outcome.sha} ≠ current head ${input.headSha})`
				: `unverified (verdict not bound to current head): the latest ${namespace} marker binds ${outcome.sha}, not the current head ${input.headSha}`;
		case "advisory-not-all-pass":
			return `unverified (§CP ${namespace} advisory not all-PASS — a body checkbox is [FAIL])`;
		case "current":
			if (outcome.form === "advisory") {
				return `§CP ${namespace} advisory at the current head, all-PASS — the ADR 0111/0151 PASS-equivalent`;
			}
			return outcome.polarity === "PASS"
				? `current-head ${namespace} PASS @ ${outcome.sha}`
				: `latest verdict is FAIL (${namespace}) @ ${outcome.sha}`;
	}
};

const decideNamespace = (gate: VerdictGate, input: GateDecisionInput): NamespaceDecision => {
	const namespace = GATE_KEYWORD[gate];
	const outcome = resolveVerdict({
		comments: input.comments,
		authorizedAuthors: input.authorizedAuthors,
		gate,
		headSha: input.headSha,
		controlPlane: input.controlPlane,
	});
	return {
		gate,
		namespace,
		state: verdictState(outcome),
		form: outcome.form,
		commentId: outcome._tag === "none" ? null : outcome.commentId,
		sha:
			outcome._tag === "current" ||
			outcome._tag === "stale" ||
			outcome._tag === "advisory-not-all-pass"
				? outcome.sha
				: null,
		reason: namespaceReason(namespace, outcome, input),
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
