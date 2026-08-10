/**
 * The doc-level primitives three verbs share: the slug rule, the title derivation, the canonical
 * template `pattern new` writes, and the anchor line `pattern anchor` reads.
 *
 * The anchor line's bytes live here **once**, so the writer and the reader of that line cannot
 * disagree: {@link anchorLine} composes it and {@link ANCHOR_DECLARATION} parses it, and
 * {@link splitAnchorToken} is the one split rule both `--anchor` validation and the read apply.
 */

/** A slug is lowercase letters, digits and single hyphens — no leading, trailing or doubled hyphen. */
export const isKebabCase = (slug: string): boolean => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);

/**
 * The H1 text a bare slug derives: hyphens become spaces, the first character upper-cases.
 *
 * No acronym or digit special-casing. A doc wanting `Fate (Effect) server` passes `--title`; a
 * derivation that guessed at capitalisation would be wrong in a way no caller could predict.
 */
export const titleFrom = (slug: string): string =>
	slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * A `<pkg>@<version>` split at its **LAST** `@`, or `null`.
 *
 * The last rather than the first is what makes a scoped package work: `@nkzw/fate@1.3.1` yields
 * `@nkzw/fate` and `1.3.1`, where a first-`@` split would yield an empty package name.
 */
export const splitAnchorToken = (
	token: string,
): {readonly pkg: string; readonly version: string} | null => {
	const at = token.lastIndexOf("@");
	if (at <= 0) return null;
	const pkg = token.slice(0, at);
	const version = token.slice(at + 1);
	return pkg === "" || version === "" ? null : {pkg, version};
};

/** The strict grammar of an anchor declaration. The em-dash is literal. */
export const ANCHOR_DECLARATION = /^> Derived from `([^`]+)` — re-verify on pin bump\.$/;

/** The prefix a line opens with to *claim* an anchor, whether or not it then parses. */
export const ANCHOR_PREFIX = "> Derived from ";

/** The one composition of the anchor line, so the template and the parser share its bytes. */
export const anchorLine = (token: string): string =>
	`${ANCHOR_PREFIX}\`${token}\` — re-verify on pin bump.`;

const TEMPLATE_BODY = `<One sentence: what shape this describes, and where in the tree it applies.>

## The shape

<The pattern itself, with a fenced example lifted from a test or a real call site.>

## When this applies

<The two or more places it is used, by path, and the boundary where it stops applying.>

## Why it is not obvious

<What a reader would otherwise invent, and why that version is worse.>
`;

/**
 * The canonical pattern doc, ready to write.
 *
 * The three body headings mirror the admission bar the skill applies — used in 2+ places,
 * non-obvious, a future agent would invent worse — so a doc that cannot fill them is a doc that did
 * not clear the bar. It is a **starting shape and not a validated grammar**: nothing here or at any
 * gate checks a pattern doc's headings, which is why `4` is a deliberate gap in `codes.ts`.
 */
export const docTemplate = (title: string, anchorToken: string | null): string =>
	`# ${title}\n\n${TEMPLATE_BODY}${anchorToken === null ? "" : `\n${anchorLine(anchorToken)}\n`}`;
