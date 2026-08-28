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

const CURRENT_BODY = `<One sentence: what shape this describes, and where in the tree it applies.>

## The shape

<The pattern itself, with a fenced example lifted from a test or a real call site.>

## When this applies

<The current in-repo scope, representative source paths, and the boundary where it stops applying.>
`;

const prospectiveBody = (
	decision: string,
): string => `<One sentence: what prospective shape this describes and where it is intended to apply.>

## The shape

<The pattern itself, with a fenced example grounded in authoritative source or docs.>

## Prospective scope

<The intended scope and boundary. Do not claim current call sites that do not exist.>

## Binding decision

<Explain how [the binding decision](${decision}) requires this shape.>
`;

const WHY_BODY = `
## Why it is not obvious

<What a reader would otherwise invent, and why that version is worse.>
`;

/** The canonical pattern doc, ready to write for either admitted authoring path. */
export const docTemplate = (
	title: string,
	anchorToken: string | null,
	decision: string | null = null,
	sourceEvidence: string | null = null,
): string => {
	const body = decision === null ? CURRENT_BODY : prospectiveBody(decision);
	const evidence = sourceEvidence === null ? "" : `\n${sourceEvidence}\n`;
	const anchor = anchorToken === null ? "" : `\n${anchorLine(anchorToken)}\n`;
	return `# ${title}\n\n${body}${WHY_BODY}${evidence}${anchor}`;
};
