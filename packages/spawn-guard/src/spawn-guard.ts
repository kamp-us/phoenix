/**
 * `@kampus/spawn-guard` core — the pure, IO-free decisions for issue #744:
 * the spawn-model allowlist guard, the `WORKFLOW_MODEL` pin resolution, and the
 * per-session cost formatter. No Node, no Effect, no env reads here — `bin.ts`
 * does the IO and hands these pure values to render. Three concerns:
 *
 *  1. `decideSpawn(requested, pin)` — the allowlist guard. The harness spawns a
 *     subagent (Task/Workflow) on some model; this decides allow / rewrite / deny.
 *     Per ADR 0092 it **fails closed**: an unset OR off-allowlist model is a DENY,
 *     never a silent allow. A `WORKFLOW_MODEL` pin that is itself on the allowlist
 *     **rewrites** a requested-but-missing/disallowed model to the pin (the
 *     deterministic-model knob); a pin that is itself off-allowlist is rejected so a
 *     misconfigured pin can't smuggle a bad model past the guard.
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
	| {
			readonly kind: "rewrite";
			readonly from: string;
			readonly model: string;
			readonly checked: string;
	  }
	| {readonly kind: "deny"; readonly requested: string | null; readonly checked: string};

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
 * Rules (fail-closed, ADR 0092):
 * - requested on allowlist → **allow** (the explicit, valid choice stands).
 * - requested off/absent, pin on allowlist → **rewrite** to the pin (the deterministic
 *   knob: a workflow's subagents inherit the pinned model rather than a session default).
 * - otherwise (no valid requested, no valid pin) → **deny**. An unset model is a deny,
 *   not a pass — the silent-default leak this guard exists to kill.
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
		// p is on the allowlist ⇒ non-null. Rewrite the absent/disallowed request to the pin.
		return {kind: "rewrite", from: req ?? "<unset>", model: p as string, checked};
	}
	return {kind: "deny", requested: req, checked};
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
