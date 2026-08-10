/**
 * What a doc declares it is derived from, against what the workspace actually pins.
 *
 * **A line that opens `> Derived from ` and does not match the grammar in full is `malformed`, not a
 * non-declaration.** This is the load-bearing half. Treating a near miss as absent would answer
 * `unanchored` — *"this doc claims no dependency anchor"* — for a doc that visibly claims one, which
 * is a fail-open false negative. Counting it as malformed makes the verb say *"something here
 * declares an anchor I could not parse"*, which is true and actionable — the same discipline
 * `./drift.ts` applies to an unresolved path.
 */
import {ANCHOR_DECLARATION, ANCHOR_PREFIX, splitAnchorToken} from "./doc.ts";

export type DeclarationState = "matched" | "moved" | "unpinned" | "malformed";

export interface Declaration {
	/** The package name, or — on a malformed line — the line's text after the prefix, clamped. */
	readonly package: string;
	/** `null` on a malformed line: no `<pkg>@<version>` token could be split out of it. */
	readonly declaredVersion: string | null;
	/** `null` when the package is not a catalog key, and on a malformed line. */
	readonly pinnedVersion: string | null;
	readonly state: DeclarationState;
}

export type AnchorOutcome = DeclarationState | "unanchored" | "unborn";

/** Enough of the line to find it, with nothing that could break the one-line grammar. */
const echoOf = (line: string): string =>
	line
		.slice(ANCHOR_PREFIX.length)
		.replace(/[\t\n\r]+/g, " ")
		.slice(0, 120);

/** Every line claiming an anchor, in document order — parsed or not. */
export const declarationLinesIn = (text: string): ReadonlyArray<string> =>
	text.split("\n").filter((line) => line.startsWith(ANCHOR_PREFIX));

export type CatalogRead =
	| {readonly _tag: "Ok"; readonly catalog: Readonly<Record<string, string>> | null}
	/** The reader could not comprehend the manifest's catalog — UNKNOWN, never a pin and never `null`. */
	| {readonly _tag: "Unparseable"; readonly reason: string};

/** Enough of an offending line to find it, on one line and clamped. */
const lineEcho = (line: string): string =>
	line
		.trim()
		.replace(/[\t\n\r]+/g, " ")
		.slice(0, 80);

/**
 * The manifest's top-level `catalog:` map, as a block map of scalar pins.
 *
 * `catalog: null` is the **degrade** path, not a failure: a repo that pins nothing centrally is a
 * fact about that repo, so every declaration reports `unpinned` at exit `0`. Every other shape this
 * reader cannot comprehend — a flow map (`catalog: {…}`), a nested sub-map under a key, a
 * named-catalog `catalogs:` block — is UNKNOWN, **not** the degrade path: it is a map that is there
 * and was not read, so answering `unpinned` would be a confident wrong answer where the caller
 * deserves a refusal (#5361). The `7`/`11` split, applied to a file: a missing key is a verdict, a
 * document this reader could not read is a verdict about nothing.
 */
export const parseCatalog = (text: string): CatalogRead => {
	const lines = text.split("\n");
	for (const [at, line] of lines.entries()) {
		if (/^[ ]*\t/.test(line)) {
			return {_tag: "Unparseable", reason: `line ${at + 1} indents with a tab, which YAML forbids`};
		}
	}
	const named = lines.findIndex((line) => /^catalogs:/.test(line));
	if (named !== -1) {
		return {
			_tag: "Unparseable",
			reason: `line ${named + 1} opens a named-catalog "catalogs:" block, which this reader does not interpret`,
		};
	}
	const start = lines.findIndex((line) => /^catalog:/.test(line));
	if (start === -1) return {_tag: "Ok", catalog: null};
	const header = lines[start] ?? "";
	if (!/^catalog:\s*(#.*)?$/.test(header)) {
		return {
			_tag: "Unparseable",
			reason: `line ${start + 1} carries "catalog:" with inline content (\`${lineEcho(header)}\`), which this reader does not interpret`,
		};
	}

	const catalog: Record<string, string> = {};
	for (let at = start + 1; at < lines.length; at += 1) {
		const line = lines[at] ?? "";
		if (line.trim() === "" || /^\s*#/.test(line)) continue;
		if (!/^\s/.test(line)) break;
		const m = /^\s+(.+?)\s*:\s*(.*?)\s*$/.exec(line);
		if (m?.[1] === undefined || m[2] === undefined) {
			return {
				_tag: "Unparseable",
				reason: `line ${at + 1} sits under catalog: and is not a key/value pair`,
			};
		}
		const version = m[2].replace(/^['"]|['"]$/g, "");
		// An empty value heads a nested sub-map, whose children then land as sibling keys; a `{`/`[`
		// value is a flow collection. Either way the key's pin is not this line, and storing "" would
		// compare unequal to every declared version and report `moved` against a pin nobody wrote.
		if (version === "" || version.startsWith("{") || version.startsWith("[")) {
			return {
				_tag: "Unparseable",
				reason: `line ${at + 1} sits under catalog: and pins no version (\`${lineEcho(line)}\`)`,
			};
		}
		catalog[m[1].replace(/^['"]|['"]$/g, "")] = version;
	}
	return {_tag: "Ok", catalog};
};

/**
 * Resolve each declaration against the pins.
 *
 * The version comparison is **byte for byte**, with no semver interpretation: a doc's anchor records
 * the version its author actually read, and accepting a range would silently bless a version nobody
 * checked — the whole failure the line exists to catch.
 */
export const resolveDeclarations = (
	lines: ReadonlyArray<string>,
	catalog: Readonly<Record<string, string>> | null,
): ReadonlyArray<Declaration> =>
	lines.map((line): Declaration => {
		const token = ANCHOR_DECLARATION.exec(line)?.[1];
		const split = token === undefined ? null : splitAnchorToken(token);
		if (split === null) {
			return {
				package: echoOf(line),
				declaredVersion: null,
				pinnedVersion: null,
				state: "malformed",
			};
		}
		const pinned = catalog?.[split.pkg];
		if (pinned === undefined) {
			return {
				package: split.pkg,
				declaredVersion: split.version,
				pinnedVersion: null,
				state: "unpinned",
			};
		}
		return {
			package: split.pkg,
			declaredVersion: split.version,
			pinnedVersion: pinned,
			state: pinned === split.version ? "matched" : "moved",
		};
	});

/**
 * The outcome, by the contract's precedence: `moved`, then `malformed`, then `unpinned`, then
 * `matched`, then `unanchored`.
 *
 * **`malformed` does not fold into `unpinned`.** They ask opposite things of a caller: `unpinned`
 * says this repo no longer carries the dependency, which is a question about whether the doc still
 * applies at all; `malformed` says the anchor line is mistyped, which is a one-line repair. And
 * `unanchored` fires only when the doc carries no claiming line at all — not merely when none
 * parsed, which is what keeps a near miss from reading as clean.
 */
export const anchorOutcome = (declarations: ReadonlyArray<Declaration>): AnchorOutcome => {
	if (declarations.length === 0) return "unanchored";
	if (declarations.some((d) => d.state === "moved")) return "moved";
	if (declarations.some((d) => d.state === "malformed")) return "malformed";
	if (declarations.some((d) => d.state === "unpinned")) return "unpinned";
	return "matched";
};
