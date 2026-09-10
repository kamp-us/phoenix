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
import {isMap, isScalar, parseDocument} from "yaml";
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
	| {readonly _tag: "Unparseable"; readonly reason: string};

/** Read all catalog maps; only a declared dependency's conflicting pins prevent its answer. */
export const parseCatalog = (
	text: string,
	declarations: ReadonlyArray<string> = [],
): CatalogRead => {
	const doc = parseDocument(text, {strict: true});
	if (doc.errors.length > 0) {
		return {
			_tag: "Unparseable",
			reason: doc.errors.map((error) => error.message.split("\n")[0]).join("; "),
		};
	}
	if (!isMap(doc.contents))
		return {_tag: "Unparseable", reason: "workspace manifest must be a map"};
	const pins = new Map<string, Set<string>>();
	const readMap = (value: unknown, name: string): string | null => {
		if (!isMap(value)) return `${name} must be a map of package names to string pins`;
		for (const pair of value.items) {
			if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value === "") {
				return `${name} contains a non-string or empty package name`;
			}
			if (
				!isScalar(pair.value) ||
				typeof pair.value.value !== "string" ||
				pair.value.value.trim() === ""
			) {
				return `${name}.${pair.key.value} pins no version string`;
			}
			const versions = pins.get(pair.key.value) ?? new Set<string>();
			versions.add(pair.value.value);
			pins.set(pair.key.value, versions);
		}
		return null;
	};
	const hasDefault = doc.contents.has("catalog");
	const hasNamed = doc.contents.has("catalogs");
	if (hasDefault) {
		const reason = readMap(doc.contents.get("catalog", true), "catalog");
		if (reason !== null) return {_tag: "Unparseable", reason};
	}
	if (hasNamed) {
		const named = doc.contents.get("catalogs", true);
		if (!isMap(named))
			return {_tag: "Unparseable", reason: "catalogs must be a map of named catalogs"};
		for (const pair of named.items) {
			if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value === "") {
				return {
					_tag: "Unparseable",
					reason: "catalogs contains a non-string or empty catalog name",
				};
			}
			const reason = readMap(pair.value, `catalogs.${pair.key.value}`);
			if (reason !== null) return {_tag: "Unparseable", reason};
		}
	}
	for (const line of declarations) {
		const token = ANCHOR_DECLARATION.exec(line)?.[1];
		const split = token === undefined ? null : splitAnchorToken(token);
		if (split === null) continue;
		const versions = pins.get(split.pkg);
		if (versions !== undefined && versions.size > 1) {
			return {
				_tag: "Unparseable",
				reason:
					split.pkg +
					" has conflicting catalog pins: " +
					[...versions].join(", ") +
					"; a dependency declaration needs one distinct pin",
			};
		}
	}
	const catalog = Object.fromEntries(
		[...pins].flatMap(([pkg, versions]) =>
			versions.size === 1 ? [...versions].map((version) => [pkg, version]) : [],
		),
	);
	return {_tag: "Ok", catalog: hasDefault || hasNamed ? catalog : null};
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
