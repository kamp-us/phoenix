/**
 * The spawn-model decision — pure, and the whole of the defence.
 *
 * A `PreToolUse` hook on a subagent spawn gets one chance to say whether the spawn may run on the
 * model it asked for. The crash mode is a spawn that quietly runs on a cheaper or wronger model than
 * the fleet is meant to use, which nothing downstream reports: the tokens go, the run looks normal.
 * So the decision fails closed — a model that is present and off the allowlist is a DENY, never a
 * shrug (ADR [0092](../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)).
 *
 * Everything here is a function of two values, `(requested, pin)`, so every branch is testable
 * without a harness, a process or a fixture. The verb beside this file does the IO and renders what
 * this returns; it re-derives no part of the outcome.
 */
import {ALLOWLIST, canonicalModel, DEFAULT_PIN, isAllowlisted, normalizeModel} from "../models.ts";

export type SpawnDecision =
	/** An explicit, allowlisted model. `model` is what was asked for; `canonical` is what it resolved to. */
	| {
			readonly _tag: "Allow";
			readonly model: string;
			readonly canonical: string;
			readonly checked: string;
	  }
	/**
	 * No model was asked for, so the spawn inherits the session's. The pin is *not* written into the
	 * request — the spawn tool rejects a full canonical id (v1's #776) — it only has to be a model the
	 * allowlist admits for the inherit to be safe.
	 */
	| {
			readonly _tag: "AllowInherit";
			readonly pin: string;
			/** The pin came from {@link DEFAULT_PIN}, not from `WORKFLOW_MODEL`. */
			readonly defaulted: boolean;
			readonly checked: string;
	  }
	| {
			readonly _tag: "Deny";
			readonly requested: string | null;
			/** An explicit off-allowlist request, which no pin can override (v1's #776). */
			readonly explicit: boolean;
			readonly checked: string;
	  };

/** What the decision looked at, verbatim, so a refusal is never reported over unstated scope. */
const scopeOf = (
	requested: string | null,
	pin: string | null,
	effectivePin: string,
	defaulted: boolean,
): string =>
	[
		`allowlist=[${ALLOWLIST.join(", ")}]`,
		`requested=${requested ?? "<unset>"}`,
		`canonical=${canonicalModel(requested) ?? "<unset>"}`,
		`WORKFLOW_MODEL=${pin ?? "<unset>"}`,
		`effectivePin=${effectivePin}${defaulted ? " (committed default)" : ""}`,
	].join(" ");

/**
 * Decide a spawn from the model it asked for and the `WORKFLOW_MODEL` pin.
 *
 * - An allowlisted request is allowed — the explicit, valid choice stands.
 * - An **unset** request is allowed to inherit the session model, provided the effective pin is
 *   itself allowlisted. An absent pin resolves to the committed default (ADR 0116), so this holds
 *   on a machine that has never exported `WORKFLOW_MODEL`.
 * - Everything else denies. That includes an explicit off-allowlist model *even when a good pin
 *   exists*, and any request when the pin is **present but off the allowlist** — a misconfigured pin
 *   is a state to surface, not one to silently paper over with the default.
 */
export const decideSpawn = (
	requested: string | null | undefined,
	pin: string | null | undefined,
): SpawnDecision => {
	const request = normalizeModel(requested);
	const configured = normalizeModel(pin);
	const defaulted = configured === null;
	const effectivePin = configured ?? DEFAULT_PIN;
	const checked = scopeOf(request, configured, effectivePin, defaulted);

	if (request !== null && isAllowlisted(request)) {
		return {_tag: "Allow", model: request, canonical: canonicalModel(request) ?? request, checked};
	}
	if (isAllowlisted(effectivePin)) {
		return request === null
			? {_tag: "AllowInherit", pin: effectivePin, defaulted, checked}
			: {_tag: "Deny", requested: request, explicit: true, checked};
	}
	return {_tag: "Deny", requested: request, explicit: false, checked};
};

/** Pull `tool_input.model` off a captured envelope. Anything that is not a string reads as unset. */
export const requestedModelOf = (payload: Record<string, unknown>): string | null => {
	const toolInput = payload.tool_input;
	if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) return null;
	const model = (toolInput as Record<string, unknown>).model;
	return typeof model === "string" ? normalizeModel(model) : null;
};

/** The `PreToolUse` reply shape: a permission decision plus a message naming what was checked. */
export interface PermissionOutput {
	readonly hookSpecificOutput: {
		readonly hookEventName: "PreToolUse";
		readonly permissionDecision: "allow" | "deny";
		readonly permissionDecisionReason?: string;
	};
	readonly systemMessage: string;
}

const VERB = "fabrika hook spawn";

/** Render a decision as the harness reply. The outcome is {@link decideSpawn}'s; this only says it. */
export const permissionOutput = (decision: SpawnDecision): PermissionOutput => {
	switch (decision._tag) {
		case "Allow":
			return {
				hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow"},
				systemMessage: `${VERB}: allow ${decision.model} — ${decision.checked}`,
			};
		case "AllowInherit":
			return {
				hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow"},
				systemMessage: `${VERB}: allow unset (inherit the session model; ${
					decision.defaulted ? "committed default pin" : "WORKFLOW_MODEL pin"
				} ${decision.pin} is allowlisted) — ${decision.checked}`,
			};
		case "Deny": {
			const reason = decision.explicit
				? `explicit model ${decision.requested} is not on the allowlist, and the pin cannot override an explicit request`
				: `model ${decision.requested ?? "<unset>"} is not on the allowlist and no allowlisted pin resolves`;
			return {
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: `${VERB}: DENY — ${reason}. ${decision.checked}`,
				},
				systemMessage: `${VERB}: DENY ${decision.requested ?? "<unset>"} — ${decision.checked}`,
			};
		}
	}
};
