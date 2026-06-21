/**
 * `@kampus/spawn-guard` core — the pure, IO-free decisions for issue #744:
 * the spawn-model allowlist guard, the `WORKFLOW_MODEL` pin resolution, and the
 * per-session cost formatter. No Node, no Effect, no env reads here — `bin.ts`
 * does the IO and hands these pure values to render. Three concerns:
 *
 *  1. `decideSpawn(requested, pin)` — the allowlist guard. The harness spawns a
 *     subagent (Task/Workflow) on some model; this decides allow / allow-inherit / deny.
 *     Per ADR 0092 it **fails closed**: an unset OR off-allowlist model is a DENY,
 *     never a silent allow. When the request is unset and the `WORKFLOW_MODEL` pin is
 *     itself on the allowlist, the spawn is allowed to **inherit** the session model
 *     (the Task tool rejects the full pin id, so the guard can't rewrite it in — #776);
 *     an explicit off-allowlist request is denied even when a valid pin exists, so a bad
 *     model can't smuggle past, and a pin that is itself off-allowlist gives no inheritance.
 *  2. `formatSessionCost(input)` — the statusline cost renderer. Takes the cost/token
 *     figures Claude Code hands a statusLine command and returns one compact line.
 *
 * The allowlist is the **Opus 4.8 family** — the model the fleet must run, per the
 * claude-api skill's "ALWAYS use claude-opus-4-8" rule. fable-5 / sonnet / haiku are
 * deliberately OFF the list: the "tokens going brrrr" leak this issue closes is a
 * silent fable-5 spawn, so an off-allowlist model is exactly what must be refused.
 */

/** Canonical model IDs allowed for a spawned subagent (claude-api skill, opus-4.8 family). */
export const ALLOWLIST: ReadonlyArray<string> = ["claude-opus-4-8", "claude-opus-4-8[1m]"] as const;

export type SpawnDecision =
	| {readonly kind: "allow"; readonly model: string; readonly checked: string}
	| {readonly kind: "allow-inherit"; readonly pin: string; readonly checked: string}
	| {
			readonly kind: "deny";
			readonly requested: string | null;
			// true when the request was explicit + off-allowlist but a valid pin exists: denied
			// because the Task tool rejects the full pin id (#776), so the pin can't override it.
			readonly explicitOffAllowlist: boolean;
			readonly checked: string;
	  };

const norm = (m: string | null | undefined): string | null => {
	if (m == null) return null;
	const t = m.trim();
	return t.length === 0 ? null : t;
};

export const isOnAllowlist = (model: string | null | undefined): boolean => {
	const m = norm(model);
	return m !== null && ALLOWLIST.includes(m);
};

/**
 * The allowlist guard decision for a spawn.
 *
 * - `requested` — the model the Task/Workflow spawn asked for (the `tool_input.model`),
 *   or null when the spawn left it unset.
 * - `pin` — the resolved `WORKFLOW_MODEL` env value, or null when unset.
 *
 * Rules (fail-closed, ADR 0092). This core owns the full allow/inherit/deny decision —
 * `bin.ts` only renders it, never re-derives the outcome:
 * - requested on allowlist → **allow** (the explicit, valid choice stands).
 * - requested unset, pin on allowlist → **allow-inherit**: the spawn inherits the
 *   session model. The guard can't rewrite the request to the pin id (the Task tool
 *   rejects the full id `claude-opus-4-8[1m]`, #776), so an unset request rides the
 *   already-allowlisted session model rather than a forced pin.
 * - otherwise → **deny**. An explicit off-allowlist request is denied even when a valid
 *   pin exists (the pin can't override it, #776; `explicitOffAllowlist` flags this), and
 *   an unset/off-allowlist request with no valid pin is denied too — an unset model is a
 *   deny, not a pass, the silent-default leak this guard exists to kill.
 */
export const decideSpawn = (
	requested: string | null | undefined,
	pin: string | null | undefined,
): SpawnDecision => {
	const req = norm(requested);
	const p = norm(pin);
	const checked = `allowlist=[${ALLOWLIST.join(", ")}] requested=${req ?? "<unset>"} WORKFLOW_MODEL=${p ?? "<unset>"}`;

	if (req !== null && isOnAllowlist(req)) {
		return {kind: "allow", model: req, checked};
	}
	if (isOnAllowlist(p)) {
		// p is on the allowlist ⇒ non-null. An unset request inherits the session model;
		// an explicit off-allowlist request is denied — the pin can't rewrite it in (#776).
		if (req === null) {
			return {kind: "allow-inherit", pin: p as string, checked};
		}
		return {kind: "deny", requested: req, explicitOffAllowlist: true, checked};
	}
	return {kind: "deny", requested: req, explicitOffAllowlist: false, checked};
};

export interface SessionCostInput {
	/** Total session cost in USD, as Claude Code reports it (e.g. `cost.total_cost_usd`). */
	readonly totalCostUsd?: number | null;
	/** Total session tokens (input + output) where the harness exposes them. */
	readonly totalTokens?: number | null;
	/** The active model id, if the statusLine payload carries it. */
	readonly model?: string | null;
}

const fmtUsd = (usd: number): string => {
	// Sub-cent spend reads as $0.00; show 4 dp under a cent so an early session isn't "free".
	const dp = usd > 0 && usd < 0.01 ? 4 : 2;
	return `$${usd.toFixed(dp)}`;
};

const fmtTokens = (tokens: number): string => {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K tok`;
	return `${tokens} tok`;
};

/**
 * Render the per-session cost/token figure for the statusline. Tolerates a missing
 * cost or token field (an early session, or a payload that omits one) — it shows what
 * it has and falls back to a stable placeholder rather than a crash or a blank line.
 */
export const formatSessionCost = (input: SessionCostInput): string => {
	const parts: string[] = [];
	const cost = input.totalCostUsd;
	if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
		parts.push(fmtUsd(cost));
	}
	const tokens = input.totalTokens;
	if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
		parts.push(fmtTokens(Math.round(tokens)));
	}
	const figure = parts.length > 0 ? parts.join(" · ") : "cost n/a";
	const model = norm(input.model);
	return model !== null ? `${model} · ${figure}` : figure;
};
