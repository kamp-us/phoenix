/**
 * `publish-isolation-guard`'s pure half — is every PUBLISHED package's runtime dependency graph
 * installable from a clean registry (ADR 0201 §3)?
 *
 * The forcing incident: a `@kampus/*` CLI published green at 0.2.0 yet was uninstallable, because it
 * declared three phoenix-private `workspace:*` packages as registry deps (#3802).
 *
 * The published set is DERIVED from `.github/workflows/publish.yml`'s release-tag grammar rather
 * than hand-kept here: a parallel list drifts from what actually publishes, and the drift is only
 * discovered by an external install failing. A tag prefix that maps to no member is that drift, and
 * it fails closed at the IO boundary in `./publish-isolation-verb.ts`.
 */

/**
 * The dep fields that ship in the published artifact — `optionalDependencies` and
 * `peerDependencies` resolve from the registry at install time exactly like `dependencies`.
 * `devDependencies` are OUT of scope: they are not in the tarball, so a private `@kampus/*` devDep
 * cannot break an external install.
 */
export const RUNTIME_DEP_FIELDS = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

/** One runtime dependency entry from a published manifest. */
export interface DepEntry {
	/** One of {@link RUNTIME_DEP_FIELDS}. */
	readonly field: string;
	readonly name: string;
	/** The raw specifier — `catalog:`, `workspace:*`, `^1.2.3`. */
	readonly value: string;
}

/** A published `package.json` reduced to its repo-relative path, package name, and runtime deps. */
export interface PublishedManifest {
	/** Repo-relative, e.g. `packages/fabrika-cli/package.json`. */
	readonly path: string;
	readonly name: string;
	readonly deps: ReadonlyArray<DepEntry>;
}

/**
 * A dep that breaks publish isolation. Two kinds, both the #3802 class:
 * - `workspace-link`: a `workspace:` specifier — never resolvable from a registry.
 * - `private-kampus-dep`: a `@kampus/*` dep that is not itself published, so a clean registry has
 *   nothing to resolve it to.
 */
export interface IsolationViolation {
	readonly path: string;
	readonly field: string;
	readonly name: string;
	readonly value: string;
	readonly kind: "workspace-link" | "private-kampus-dep";
}

/**
 * The verdict. A union, so a pass can never carry violations and the two failures each carry
 * exactly their own evidence. `scanned` is the set of published package NAMES covered.
 */
export type PublishIsolationVerdict =
	| {readonly pass: true; readonly scanned: ReadonlyArray<string>}
	/** No published package in scope — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"}
	| {
			readonly pass: false;
			readonly reason: "linked-private-deps";
			readonly scanned: ReadonlyArray<string>;
			readonly violations: ReadonlyArray<IsolationViolation>;
	  };

const KAMPUS_SCOPE = "@kampus/";

/** `@kampus/fabrika-cli` → `fabrika-cli`; `effect` → `effect`. */
export const unscopedName = (name: string): string =>
	name.startsWith("@") ? (name.split("/")[1] ?? name) : name;

/**
 * Decide the verdict over the published manifests. A `@kampus/*` dep that IS itself in the
 * published set resolves cleanly, so it passes.
 */
export const judge = (manifests: ReadonlyArray<PublishedManifest>): PublishIsolationVerdict => {
	if (manifests.length === 0) {
		return {pass: false, reason: "zero-scope"};
	}
	const publishedNames = new Set(manifests.map((m) => m.name));
	const scanned = manifests.map((m) => m.name);
	const violations: Array<IsolationViolation> = [];
	for (const m of manifests) {
		for (const dep of m.deps) {
			// `workspace:` is checked first: it is the most actionable diagnosis (the exact #3802
			// form) even when the dep is also `@kampus/*`-scoped.
			if (dep.value.startsWith("workspace:")) {
				violations.push({
					path: m.path,
					field: dep.field,
					name: dep.name,
					value: dep.value,
					kind: "workspace-link",
				});
			} else if (dep.name.startsWith(KAMPUS_SCOPE) && !publishedNames.has(dep.name)) {
				violations.push({
					path: m.path,
					field: dep.field,
					name: dep.name,
					value: dep.value,
					kind: "private-kampus-dep",
				});
			}
		}
	}
	if (violations.length > 0) {
		return {pass: false, reason: "linked-private-deps", scanned, violations};
	}
	return {pass: true, scanned};
};

/** One violation as its own report line, carrying the why and the fix. */
export const violationLine = (v: IsolationViolation): string =>
	v.kind === "workspace-link"
		? `  ${v.path}: ${v.field} \`${v.name}\` links \`${v.value}\` — a workspace: specifier never resolves from a clean registry (the #3802 class). ` +
			"Fix: inline it as a tool, or depend on a PUBLISHED version instead."
		: `  ${v.path}: ${v.field} \`${v.name}\` (\`${v.value}\`) is a private/unpublished @kampus package — an external install cannot resolve it (the #3802 class, ADR 0201 §3). ` +
			"Fix: inline it, or publish that package and depend on its registry version.";

/** The human report for a verdict — it names what was scanned, not only what failed (ADR 0092). */
export const renderReport = (verb: string, verdict: PublishIsolationVerdict): string => {
	if (verdict.pass) {
		const n = verdict.scanned.length;
		return `${verb}: ${n} published package${n === 1 ? "" : "s"} (${verdict.scanned.join(", ")}) link${n === 1 ? "s" : ""} no private/unpublished @kampus deps`;
	}
	if (verdict.reason === "zero-scope") {
		return (
			`${verb}: derived ZERO published packages — fail-closed (ADR 0092). ` +
			"Does publish.yml still declare a `<name>-v<version>` release-tag grammar, and does its prefix map to a workspace member?"
		);
	}
	const n = verdict.violations.length;
	return (
		`${verb}: ${n} publish-isolation violation${n === 1 ? "" : "s"} ` +
		`across ${verdict.scanned.length} published package${verdict.scanned.length === 1 ? "" : "s"} (${verdict.scanned.join(", ")}):\n${verdict.violations.map(violationLine).join("\n")}`
	);
};

/**
 * The release-tag prefixes `publish.yml` declares — each `^<prefix>-v(` anchor names a published
 * artifact (`^fabrika-cli-v([0-9].*)$` → `fabrika-cli`).
 *
 * The anchor form is what makes this discriminating: a `fabrika-cli-v<version>` mention in a prose
 * comment carries no leading `^` and no `(`, so it does not match and cannot inflate the scope.
 */
export const parsePublishedTagPrefixes = (workflowYaml: string): ReadonlyArray<string> => {
	const out = new Set<string>();
	const re = /\^([A-Za-z0-9][\w.-]*?)-v\(/g;
	for (let m = re.exec(workflowYaml); m !== null; m = re.exec(workflowYaml)) {
		if (m[1] !== undefined) out.add(m[1]);
	}
	return [...out].sort();
};

export interface PublishedResolution {
	/** Members whose unscoped name matches a published tag prefix. */
	readonly published: ReadonlyArray<PublishedManifest>;
	/** Prefixes that matched no member — publish.yml/workspace drift, which the verb reds on. */
	readonly unmatchedPrefixes: ReadonlyArray<string>;
}

/**
 * Map the tag prefixes onto workspace members by unscoped package name. A prefix with no matching
 * member is surfaced as drift rather than silently narrowing scope — a narrowed scope is how the
 * derived set stops being honest against publish.yml.
 */
export const resolvePublished = (
	prefixes: ReadonlyArray<string>,
	members: ReadonlyArray<PublishedManifest>,
): PublishedResolution => {
	const byUnscoped = new Map<string, Array<PublishedManifest>>();
	for (const m of members) {
		const key = unscopedName(m.name);
		const bucket = byUnscoped.get(key);
		if (bucket) bucket.push(m);
		else byUnscoped.set(key, [m]);
	}
	const published: Array<PublishedManifest> = [];
	const unmatchedPrefixes: Array<string> = [];
	for (const prefix of prefixes) {
		const hits = byUnscoped.get(prefix);
		if (hits === undefined || hits.length === 0) unmatchedPrefixes.push(prefix);
		else published.push(...hits);
	}
	return {published, unmatchedPrefixes};
};

/** A parsed `package.json` flattened into `DepEntry`s over the runtime fields only. */
export const manifestRuntimeDeps = (pkg: Record<string, unknown>): ReadonlyArray<DepEntry> => {
	const out: Array<DepEntry> = [];
	for (const field of RUNTIME_DEP_FIELDS) {
		const block = pkg[field];
		if (block === null || typeof block !== "object") continue;
		for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
			if (typeof value === "string") out.push({field, name, value});
		}
	}
	return out;
};
