/**
 * Shoot a surface in a locale other than the app's default, by seeding the `localStorage` key the
 * consuming app reads its locale from. Pure — no browser; `capture.ts` installs the seed and hands
 * the page's rendered `lang` back to {@link readLocaleProof}.
 *
 * Neither the key nor the values are fabrika's: both come from the consumer's `uiCapture.locale`
 * declaration, and the operand is checked against that declared list before a browser launches.
 *
 * The proof exists for the same reason the flag and tier proofs do. A seed the app never read
 * paints the default-locale page cleanly, which is a valid PNG under the requested locale's name,
 * and no byte check can tell the two apart — so the page's own `document.documentElement.lang` is
 * read back and has to name the requested value.
 * @ruling https://github.com/kamp-us/phoenix/issues/9893
 */

/** A consumer's locale declaration: the storage key it reads, and the closed set it accepts. */
export interface LocaleDeclaration {
	readonly storageKey: string;
	readonly values: readonly string[];
}

/** The one key and value a capture context is seeded with before it navigates. */
export interface LocaleSeed {
	readonly storageKey: string;
	readonly value: string;
}

/**
 * Three arms: no operand renders at the app's default exactly as before; an operand this cannot
 * honor is refused before a browser launches, because the alternative is the default-locale page
 * under the requested name.
 */
export type LocaleOperandRead =
	| {readonly _tag: "Default"}
	| {readonly _tag: "Seeded"; readonly seed: LocaleSeed}
	| {readonly _tag: "Malformed"; readonly value: string; readonly reason: string};

export const parseLocaleOperand = (
	operand: string | null,
	declared: LocaleDeclaration | null,
): LocaleOperandRead => {
	if (operand === null) return {_tag: "Default"};
	if (declared === null) {
		return {
			_tag: "Malformed",
			value: operand,
			reason: "this repo declares no uiCapture.locale, so there is no storage key to seed",
		};
	}
	if (!declared.values.includes(operand)) {
		return {
			_tag: "Malformed",
			value: operand,
			reason: `the declared locales are ${declared.values.join(", ")}`,
		};
	}
	return {_tag: "Seeded", seed: {storageKey: declared.storageKey, value: operand}};
};

/**
 * Whether the page rendered in the seeded locale, read off its own `lang`.
 *
 * `Unreadable` stays apart from `Mismatch`: both refuse, but only one is a fact about the page.
 */
export type LocaleProof =
	| {readonly _tag: "Seeded"}
	| {readonly _tag: "Mismatch"; readonly rendered: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

export const readLocaleProof = (requested: string, renderedLang: unknown): LocaleProof => {
	if (typeof renderedLang !== "string") {
		return {_tag: "Unreadable", reason: "the page's lang did not read back as a string"};
	}
	return renderedLang === requested ? {_tag: "Seeded"} : {_tag: "Mismatch", rendered: renderedLang};
};
