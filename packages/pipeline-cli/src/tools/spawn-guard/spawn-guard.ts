/**
 * `@kampus/spawn-guard` core — the pure, IO-free decisions for issue #744:
 * the spawn-model allowlist guard, the `WORKFLOW_MODEL` pin resolution, and the
 * per-session cost formatter. No Node, no Effect, no env reads here — `bin.ts`
 * does the IO and hands these pure values to render. Three concerns:
 *
 *  1. `decideSpawn(requested, pin)` — the allowlist guard. The harness spawns a
 *     subagent (Task/Workflow) on some model; this decides allow / allow-inherit / deny.
 *     Per ADR 0092 it **fails closed**: an off-allowlist model is a DENY, never a silent
 *     allow. When the request is unset, the spawn is allowed to **inherit** the session
 *     model (the Task tool rejects the full pin id, so the guard can't rewrite it in —
 *     #776). The inherit decision used to hinge on the `WORKFLOW_MODEL` env pin being
 *     allowlisted — but that pin is uncommitted and operator-shell-only, so a fresh
 *     clone / CI / cron / new operator without it re-hit the #776 fail-closed-on-unset
 *     symptom. So an **absent** pin now falls back to a committed `DEFAULT_PIN` (ADR
 *     0116): unset spawns resolve to allow-inherit durably, independent of the launching
 *     shell — the spawn still inherits the session model, only the gate stops blocking it.
 *     An explicit off-allowlist request is still denied even when a valid pin exists, so a
 *     bad model can't smuggle past, and a **present-but-off-allowlist** pin (a real
 *     misconfiguration, not an absence) still denies rather than silently defaulting.
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

/**
 * Harness model aliases → canonical allowlist IDs. The Task/Workflow `model` param is
 * expressed in the harness's short vocabulary (`opus`, `opus[1m]`), never the canonical
 * `claude-opus-4-8*` id — so an explicit `opus` spawn (the very Opus-4.8 family the
 * allowlist exists to permit) was denied by an allowlist that held only canonical ids
 * (#2565). Only the Opus-4.8 family has an entry — `sonnet` / `haiku` are deliberately
 * absent, so they never canonicalize onto the allowlist and stay a fail-closed DENY
 * (ADR 0092). Mapping resolves an alias for the allowlist *check* only; the guard never
 * rewrites the request to the canonical id (#776 — the Task tool rejects the full id).
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
	opus: "claude-opus-4-8",
	"opus[1m]": "claude-opus-4-8[1m]",
};

/**
 * The committed, allowlisted pin an unset `WORKFLOW_MODEL` falls back to (ADR 0116).
 * Durable in source, so an unset spawn resolves to allow-inherit regardless of the
 * launching shell — the fix for the #943 fragility where the inherit path depended on
 * an uncommitted, operator-shell-only env pin. Must stay a member of `ALLOWLIST`.
 */
export const DEFAULT_PIN = "claude-opus-4-8[1m]";

export type SpawnDecision =
	| {readonly kind: "allow"; readonly model: string; readonly checked: string}
	| {
			readonly kind: "allow-inherit";
			readonly pin: string;
			// true when `pin` came from the committed DEFAULT_PIN (no env pin), not WORKFLOW_MODEL.
			readonly defaulted: boolean;
			readonly checked: string;
	  }
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

/**
 * Resolve a harness alias to its canonical id; a value that is not an alias (including a
 * canonical id already) passes through unchanged. Null/empty normalizes to null.
 */
export const canonicalModel = (model: string | null | undefined): string | null => {
	const m = norm(model);
	if (m === null) return null;
	return MODEL_ALIASES[m] ?? m;
};

export const isOnAllowlist = (model: string | null | undefined): boolean => {
	const m = canonicalModel(model);
	return m !== null && ALLOWLIST.includes(m);
};

/**
 * The allowlist guard decision for a spawn.
 *
 * - `requested` — the model the Task/Workflow spawn asked for (the `tool_input.model`),
 *   or null when the spawn left it unset.
 * - `pin` — the resolved `WORKFLOW_MODEL` env value, or null when unset.
 *
 * Rules (fail-closed, ADR 0092; durable default pin, ADR 0116). This core owns the full
 * allow/inherit/deny decision — `bin.ts` only renders it, never re-derives the outcome.
 * The **effective pin** is the env `WORKFLOW_MODEL` when set, else the committed
 * `DEFAULT_PIN` — so an *absent* pin no longer fails closed (the #943 fragility), but a
 * *present-but-wrong* pin still surfaces as a misconfiguration:
 * - requested on allowlist → **allow** (the explicit, valid choice stands).
 * - requested unset, effective pin on allowlist → **allow-inherit**: the spawn inherits
 *   the session model. The guard can't rewrite the request to the pin id (the Task tool
 *   rejects the full id `claude-opus-4-8[1m]`, #776), so an unset request rides the
 *   already-allowlisted session model rather than a forced pin. An absent env pin resolves
 *   to `DEFAULT_PIN`, so this holds on a fresh clone / CI / cron with no `WORKFLOW_MODEL`.
 * - otherwise → **deny**. An explicit off-allowlist request is denied even when a valid
 *   pin exists (the pin can't override it, #776; `explicitOffAllowlist` flags this), and a
 *   request paired with a **present** off-allowlist pin is denied — a misconfigured env pin
 *   never silently falls back to the default; only an *absent* pin defaults.
 */
export const decideSpawn = (
	requested: string | null | undefined,
	pin: string | null | undefined,
): SpawnDecision => {
	const req = norm(requested);
	const p = norm(pin);
	// An absent env pin falls back to the committed default; a present pin is honored as-is
	// (so a misconfigured WORKFLOW_MODEL still denies rather than masking under the default).
	const defaulted = p === null;
	const effectivePin = p ?? DEFAULT_PIN;
	const checked = `allowlist=[${ALLOWLIST.join(", ")}] requested=${req ?? "<unset>"} WORKFLOW_MODEL=${p ?? "<unset>"} effectivePin=${effectivePin}${defaulted ? "(default)" : ""}`;

	if (req !== null && isOnAllowlist(req)) {
		return {kind: "allow", model: req, checked};
	}
	if (isOnAllowlist(effectivePin)) {
		// effectivePin is on the allowlist ⇒ non-null. An unset request inherits the session
		// model; an explicit off-allowlist request is denied — the pin can't rewrite it in (#776).
		if (req === null) {
			return {kind: "allow-inherit", pin: effectivePin, defaulted, checked};
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
