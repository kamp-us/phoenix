/**
 * Shoot a surface in a named colour scheme, and prove the page resolved to it. Pure — no browser;
 * `capture.ts` emulates the scheme on the shot's context and hands the root attribute it read back
 * to {@link readSchemeProof}.
 *
 * The request rides the browser's own `prefers-color-scheme` emulation, so no app's storage key is
 * compiled in here: an app left on its system-following default renders the emulated scheme. That
 * request is a fact about the browser, not about the page — an app with a stored choice or a
 * hard-coded scheme paints its own — so the shot is proved against the scheme the page itself
 * published on its root element. Which attribute carries it is the consumer's declaration
 * (`uiCapture.scheme.rootAttribute`), never a name fabrika knows.
 * @ruling https://github.com/kamp-us/phoenix/issues/8134
 */

/** The closed set a `--scheme` operand names — the two values `prefers-color-scheme` can emulate. */
export const COLOR_SCHEMES = ["light", "dark"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

export const isColorScheme = (value: string): value is ColorScheme =>
	(COLOR_SCHEMES as readonly string[]).includes(value);

/** A consumer's scheme declaration: the root attribute its page publishes the resolved scheme on. */
export interface SchemeDeclaration {
	readonly rootAttribute: string;
}

/** One shot's scheme request: what the context emulates, and where the page's answer is read. */
export interface SchemeRequest {
	readonly scheme: ColorScheme;
	readonly rootAttribute: string;
}

/**
 * No operand renders at the browser's default exactly as before, with no emulation and no proof
 * owed. The three refusing arms are refused before a browser launches, because the alternative is
 * the default scheme's page under the requested name — or, for a repeat, a second shot overwriting
 * the first's file.
 */
export type SchemeOperandsRead =
	| {readonly _tag: "Default"}
	| {readonly _tag: "Requested"; readonly requests: readonly [SchemeRequest, ...SchemeRequest[]]}
	| {readonly _tag: "Unknown"; readonly value: string}
	| {readonly _tag: "Repeated"; readonly value: string}
	| {readonly _tag: "Undeclared"; readonly value: string};

export const parseSchemeOperands = (
	operands: readonly string[],
	declared: SchemeDeclaration | null,
): SchemeOperandsRead => {
	const unknown = operands.find((value) => !isColorScheme(value));
	if (unknown !== undefined) return {_tag: "Unknown", value: unknown};
	const repeated = operands.find((value, index) => operands.indexOf(value) !== index);
	if (repeated !== undefined) return {_tag: "Repeated", value: repeated};
	const [first, ...rest] = operands.filter(isColorScheme);
	if (first === undefined) return {_tag: "Default"};
	if (declared === null) return {_tag: "Undeclared", value: first};
	const request = (scheme: ColorScheme): SchemeRequest => ({
		scheme,
		rootAttribute: declared.rootAttribute,
	});
	return {_tag: "Requested", requests: [request(first), ...rest.map(request)]};
};

/**
 * What the page published as its resolved scheme, read off its root attribute.
 *
 * `Unreadable` stays apart from `Mismatch`: both refuse, but only one is a fact about the page.
 */
export type SchemeProof =
	| {readonly _tag: "Proven"; readonly scheme: ColorScheme}
	| {readonly _tag: "Mismatch"; readonly rendered: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

export const readSchemeProof = (requested: SchemeRequest, attributeValue: unknown): SchemeProof => {
	if (typeof attributeValue !== "string") {
		return {
			_tag: "Unreadable",
			reason: `the page's root carries no ${requested.rootAttribute} attribute`,
		};
	}
	return attributeValue === requested.scheme
		? {_tag: "Proven", scheme: requested.scheme}
		: {_tag: "Mismatch", rendered: attributeValue};
};
