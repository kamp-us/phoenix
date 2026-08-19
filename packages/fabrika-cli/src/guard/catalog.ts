/**
 * `catalog-guard`'s pure half — is every dependency in a workspace `package.json` sourced from the
 * pnpm `catalog:` (or an internal `workspace:` ref) rather than a hardcoded version string (#2737)?
 *
 * The rule is the root `CLAUDE.md`'s "Every dependency via `catalog:`": one shared version per dep,
 * declared once in `pnpm-workspace.yaml`. A hardcoded semver introduces a second version and breaks
 * frozen-lockfile CI downstream — PR #535 hardcoded `@distilled.cloud/cloudflare` and did exactly
 * that. The convention was written but unenforced, so it held only by reviewer vigilance.
 *
 * Scope and the fail-closed floor live at the IO boundary in `./catalog-verb.ts`; this module never
 * touches disk and never decides what a scan covered.
 */

import {type Annotation, atFile, atLine} from "./annotate.ts";

/** One dependency entry from a manifest, reduced to the facts the decision needs. */
export interface DepEntry {
	/** `dependencies` / `devDependencies` / `peerDependencies`. */
	readonly field: string;
	readonly name: string;
	/** The raw specifier — `catalog:`, `workspace:*`, or a hardcoded `^1.2.3`. */
	readonly value: string;
}

/** A workspace `package.json` reduced to its repo-relative path and its dep entries. */
export interface PackageManifest {
	/** Repo-relative — `packages/foo/package.json`, or `package.json` for the root. */
	readonly path: string;
	readonly deps: ReadonlyArray<DepEntry>;
}

/**
 * An explicit, reasoned exception to the catalog rule. A dep is exempt only when its `name` matches
 * AND (`path` is unset OR equals the manifest's path). `reason` is mandatory so an exception can
 * never be added without a recorded justification (#2737).
 */
export interface AllowlistEntry {
	readonly name: string;
	/** Scope the exemption to a single manifest; unset ⇒ exempt in every manifest. */
	readonly path?: string;
	readonly reason: string;
}

/**
 * The sanctioned non-catalog deps. Empty today — every workspace member is already on
 * `catalog:`/`workspace:`. Add an entry ONLY for a genuinely unavoidable exception, each with a
 * recorded `reason`; a silent tolerance is the bug #2737 exists to prevent.
 */
export const DEFAULT_ALLOWLIST: ReadonlyArray<AllowlistEntry> = [];

/** A dep whose value is neither `catalog:` nor `workspace:` nor allowlisted. */
export interface CatalogViolation {
	readonly path: string;
	readonly field: string;
	readonly name: string;
	readonly value: string;
}

/** The manifest fields the catalog rule governs (#2737). */
export const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

/** Flatten a parsed `package.json` object into `DepEntry`s over the governed fields. */
export const manifestDeps = (pkg: Record<string, unknown>): ReadonlyArray<DepEntry> => {
	const out: Array<DepEntry> = [];
	for (const field of DEP_FIELDS) {
		const block = pkg[field];
		if (block === null || typeof block !== "object") continue;
		for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
			if (typeof value === "string") out.push({field, name, value});
		}
	}
	return out;
};

/** Compliant iff the value defers to the catalog or to an internal workspace package. */
const isCompliantValue = (value: string): boolean =>
	value.startsWith("catalog:") || value.startsWith("workspace:");

const isAllowlisted = (
	entry: DepEntry,
	path: string,
	allowlist: ReadonlyArray<AllowlistEntry>,
): boolean =>
	allowlist.some((a) => a.name === entry.name && (a.path === undefined || a.path === path));

/** Every dep across the scanned manifests that pins a hardcoded version, in scan order. */
export const findViolations = (
	manifests: ReadonlyArray<PackageManifest>,
	allowlist: ReadonlyArray<AllowlistEntry> = DEFAULT_ALLOWLIST,
): ReadonlyArray<CatalogViolation> => {
	const violations: Array<CatalogViolation> = [];
	for (const m of manifests) {
		for (const dep of m.deps) {
			if (isCompliantValue(dep.value)) continue;
			if (isAllowlisted(dep, m.path, allowlist)) continue;
			violations.push({path: m.path, field: dep.field, name: dep.name, value: dep.value});
		}
	}
	return violations;
};

const WHY = "a second version of a dep breaks frozen-lockfile CI (#535)";

/** The one-line summary of a scan that found nothing. */
export const cleanSummary = (verb: string, scanned: number): string =>
	`${verb}: all deps in ${scanned} workspace manifest${scanned === 1 ? "" : "s"} are on catalog:/workspace:`;

/** The report for the offending deps — one `<what's wrong> — <why>. Fix: <step>.` line each. */
export const violationReport = (
	verb: string,
	violations: ReadonlyArray<CatalogViolation>,
	scanned: number,
): string =>
	[
		`${verb}: ${violations.length} dependenc${violations.length === 1 ? "y" : "ies"} pin a hardcoded version instead of catalog: (of ${scanned} manifests scanned):`,
		...violations.map(
			(v) =>
				`  ${v.path}: ${v.field} \`${v.name}\` pins \`${v.value}\` instead of \`catalog:\` — ${WHY}. ` +
				`Fix: add \`${v.name}\` to the catalog: block in pnpm-workspace.yaml and set the dep value to \`catalog:\`.`,
		),
	].join("\n");

/**
 * One annotation per violation, on the manifest line that pins the version when `lineOf` can find
 * it — a file-level annotation otherwise, since GitHub drops a `line=` it cannot place (#3868).
 */
export const violationAnnotations = (
	violations: ReadonlyArray<CatalogViolation>,
	lineOf: (violation: CatalogViolation) => number | null = () => null,
): ReadonlyArray<Annotation> =>
	violations.map((v) => {
		const message = `${v.field} \`${v.name}\` pins \`${v.value}\` instead of \`catalog:\` — ${WHY}.`;
		const line = lineOf(v);
		return line === null
			? atFile("error", v.path, message)
			: atLine("error", v.path, line, message);
	});

/**
 * Does `segment` open with the JSON key `"<name>":`? Compared literally, never compiled into a
 * `RegExp` — a name is arbitrary manifest input, and `.` (legal in an npm name, e.g.
 * `@distilled.cloud/cloudflare`) would silently match a neighbour, while a regex metacharacter would
 * throw a `SyntaxError` out of the annotation build.
 */
const declaresKey = (segment: string, name: string): boolean => {
	const quoted = `"${name}"`;
	const trimmed = segment.trimStart();
	return trimmed.startsWith(quoted) && /^\s*:/.test(trimmed.slice(quoted.length));
};

/** The rest of `line` after `"<field>": {`, or `null` when the line doesn't open that field. */
const afterFieldOpen = (line: string, field: string): string | null => {
	const quoted = `"${field}"`;
	const trimmed = line.trimStart();
	if (!trimmed.startsWith(quoted)) return null;
	const open = /^\s*:\s*\{/.exec(trimmed.slice(quoted.length));
	return open === null ? null : trimmed.slice(quoted.length + open[0].length);
};

/** Whether the keys on the remainder of a field-opening line hold `name`, or close the block. */
const scanInlineKeys = (rest: string, name: string): "found" | "closed" | "open" => {
	const close = rest.indexOf("}");
	const inside = close === -1 ? rest : rest.slice(0, close);
	if (inside.split(",").some((part) => declaresKey(part, name))) return "found";
	return close === -1 ? "open" : "closed";
};

/**
 * The 1-based line of `"<name>"` inside the `"<field>"` block of a `package.json`'s text, or `null`
 * when it isn't there. Pure over the raw text because the parsed manifest carries no positions, and
 * a line is what puts the annotation on the offending diff line rather than at the top of the file.
 */
export const findDepLine = (text: string, field: string, name: string): number | null => {
	const lines = text.split("\n");
	let inField = false;
	for (const [i, line] of lines.entries()) {
		if (!inField) {
			const rest = afterFieldOpen(line, field);
			if (rest === null) continue;
			inField = true;
			// A compact `"dependencies": {"x": "1"},` declares its deps on the SAME line as the field;
			// without this the scan walks past them into the next field's block.
			const same = scanInlineKeys(rest, name);
			if (same !== "open") return same === "found" ? i + 1 : null;
			continue;
		}
		if (/^\s*\}/.test(line)) return null;
		if (declaresKey(line, name)) return i + 1;
	}
	return null;
};
