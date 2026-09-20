/**
 * `ThinkingLevel` — how hard the agent is asked to think, named the way a picker names it.
 *
 * Backend-blind by name and by vocabulary: this is the union of every level any layer offers, and
 * which of them a given session actually offers is the layer's own answer, carried on the
 * `thinking` event's `available` exactly as `ModelEvent.available` carries the offered models
 * (#8062). Pi advertises the whole seven for a reasoning model and `off` alone otherwise; Claude's
 * effort axis has five of them and neither `off` nor `minimal`, and the founder ruled that each
 * window shows only what its backend supports rather than mapping the missing two onto something.
 *
 * It rides no port, for the reason `ModelRef` does not: the picker lives in the window, which
 * already reads the whole `AiAgentSessionState` and writes through `dispatch`.
 */

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max"
	| "ultra";

/** The type as data, so a checkpoint can be read against it. */
export const thinkingLevels = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const satisfies ReadonlyArray<ThinkingLevel>;

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
	(thinkingLevels as ReadonlyArray<string>).includes(value as string);
