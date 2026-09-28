/**
 * Shoot a surface under a named theme accent, and prove the page rendered in it. Pure — no browser;
 * `capture.ts` sets the attribute on the page's root after navigation and hands the value it read
 * back to {@link readAccentProof}.
 *
 * The lever is an attribute on `document.documentElement`, not a storage key: an app whose stylesheet
 * switches accents on that attribute paints whichever one it names. Neither the attribute nor the
 * values are fabrika's — both come from the consumer's `uiCapture.accent` declaration, and the operand
 * is checked against that declared list before a browser launches.
 *
 * The attribute is set after navigation rather than from an init script, because the parser creates
 * `<html>` after an init script runs and a value written in the markup would win. The proof then
 * reads the attribute back before the shot, so an app that re-asserts its own accent is caught rather
 * than recorded under the requested name.
 * @ruling https://github.com/kamp-us/phoenix/issues/10006
 */

/** A consumer's accent declaration: the root attribute it switches on, and the closed set it accepts. */
export interface AccentDeclaration {
	readonly rootAttribute: string;
	readonly values: readonly string[];
}

/** One run's accent request: the attribute set on the page's root, and the value it is set to. */
export interface AccentRequest {
	readonly rootAttribute: string;
	readonly value: string;
}

/**
 * No operand renders the app's own accent exactly as before, with nothing set and no proof owed. The
 * two refusing arms are refused before a browser launches, because the alternative is the default
 * accent's page under the requested name.
 */
export type AccentOperandRead =
	| {readonly _tag: "Default"}
	| {readonly _tag: "Requested"; readonly request: AccentRequest}
	| {readonly _tag: "Undeclared"; readonly value: string}
	| {readonly _tag: "Unknown"; readonly value: string; readonly declared: readonly string[]};

export const parseAccentOperand = (
	operand: string | null,
	declared: AccentDeclaration | null,
): AccentOperandRead => {
	if (operand === null) return {_tag: "Default"};
	if (declared === null) return {_tag: "Undeclared", value: operand};
	if (!declared.values.includes(operand)) {
		return {_tag: "Unknown", value: operand, declared: declared.values};
	}
	return {_tag: "Requested", request: {rootAttribute: declared.rootAttribute, value: operand}};
};

/**
 * The accent the page's root carried when it was read back.
 *
 * `Unreadable` stays apart from `Mismatch`: both refuse, but only one is a fact about the page.
 */
export type AccentProof =
	| {readonly _tag: "Proven"; readonly accent: string}
	| {readonly _tag: "Mismatch"; readonly rendered: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

export const readAccentProof = (requested: AccentRequest, attributeValue: unknown): AccentProof => {
	if (typeof attributeValue !== "string") {
		return {
			_tag: "Unreadable",
			reason: `the page's root carries no ${requested.rootAttribute} attribute`,
		};
	}
	return attributeValue === requested.value
		? {_tag: "Proven", accent: requested.value}
		: {_tag: "Mismatch", rendered: attributeValue};
};
