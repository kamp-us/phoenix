/**
 * `publish-isolation-guard` pure core — decide whether every PUBLISHED pipeline
 * package's runtime dependency graph is self-contained: zero phoenix-private
 * `@kampus/*` links, installable from a clean registry state. IO-free and total;
 * every decision is a deterministic transform over already-gathered facts. The
 * filesystem + `publish.yml` boundary lives in `gate.ts`; this module never touches
 * disk.
 *
 * The rule enforces ADR 0201 §3 (isolated publishing = decoupled dependency graph):
 * a published artifact must depend only on things a clean registry can resolve. The
 * forcing incident: `pipeline-cli@0.2.0` published green yet was uninstallable because
 * it declared three phoenix-private `workspace:*` packages as registry deps (#3802,
 * inlined in #3805). ADR 0201 turns that from review vigilance into this fail-closed
 * invariant — the #3802 class becomes unrepresentable.
 *
 * Scope is DERIVED, never a hand-maintained parallel list: the published-package set
 * comes from `publish.yml`'s release-tag grammar (`parsePublishedTagPrefixes`), mapped
 * to workspace members by unscoped package name (`resolvePublished`). A prefix that
 * maps to no member is drift and fails closed in `gate.ts`. Fail-closed on zero scope
 * too (ADR 0092): an empty published set is a misconfiguration, not a vacuous green.
 */

/**
 * The dep fields that ship in the published artifact — `optionalDependencies` and
 * `peerDependencies` resolve from the registry at install time just like
 * `dependencies`. `devDependencies` are OUT of scope: they don't ship in the tarball,
 * so a private `@kampus/*` devDep can't break an external install (ADR 0201 §3).
 */
export const RUNTIME_DEP_FIELDS = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

/** One runtime dependency entry from a published manifest, reduced to the facts the decision needs. */
export interface DepEntry {
	/** Which runtime field it came from — one of `RUNTIME_DEP_FIELDS`. */
	readonly field: string;
	readonly name: string;
	/** The raw version specifier, e.g. `catalog:`, `workspace:*`, or `^1.2.3`. */
	readonly value: string;
}

/** A published `package.json` reduced to its repo-relative path, package name, and runtime deps. */
export interface PublishedManifest {
	/** Repo-relative path, e.g. `packages/pipeline-cli/package.json`. */
	readonly path: string;
	/** The `name` field, e.g. `@kampus/pipeline-cli`. */
	readonly name: string;
	readonly deps: ReadonlyArray<DepEntry>;
}

/**
 * A dep that breaks publish isolation. Two kinds, both the #3802 class:
 * - `workspace-link`: a `workspace:*` specifier — never resolvable from a registry.
 * - `private-kampus-dep`: a `@kampus/*` dep whose target is not itself in the published
 *   set, so it's unpublished/private and a clean registry can't resolve it.
 */
export interface IsolationViolation {
	readonly path: string;
	readonly field: string;
	readonly name: string;
	readonly value: string;
	readonly kind: "workspace-link" | "private-kampus-dep";
}

/**
 * The guard verdict. A discriminated union so an invalid state is unrepresentable: a
 * pass never carries violations, and the two failure shapes (zero-scope vs linked
 * private deps) are distinct and each carries exactly its evidence. `scanned` is the
 * set of published package NAMES the verdict covered.
 */
export type PublishIsolationVerdict =
	| {readonly pass: true; readonly scanned: ReadonlyArray<string>}
	/** No published package in scope — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"}
	/** Published packages exist but at least one links a private/unpublished dep. */
	| {
			readonly pass: false;
			readonly reason: "linked-private-deps";
			readonly scanned: ReadonlyArray<string>;
			readonly violations: ReadonlyArray<IsolationViolation>;
	  };

const KAMPUS_SCOPE = "@kampus/";

/** The unscoped part of a package name — `@kampus/pipeline-cli` → `pipeline-cli`, `effect` → `effect`. */
export const unscopedName = (name: string): string =>
	name.startsWith("@") ? (name.split("/")[1] ?? name) : name;

/**
 * Decide the verdict over the published manifests. Fails closed on an empty set (ADR
 * 0092), else reds on any runtime dep that is a `workspace:*` link or a `@kampus/*`
 * dep whose target is not itself published (the #3802 class). A `@kampus/*` dep that
 * IS in the published set resolves cleanly, so it passes.
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
			// `workspace:*` is checked first: it's the most actionable diagnosis (the exact
			// #3802 form) even when the dep is also `@kampus/*`-scoped.
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

/** Render the human-readable report for a verdict (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: PublishIsolationVerdict): string => {
	if (verdict.pass) {
		return `publish-isolation-guard: ${verdict.scanned.length} published package${verdict.scanned.length === 1 ? "" : "s"} (${verdict.scanned.join(", ")}) link${verdict.scanned.length === 1 ? "s" : ""} no private/unpublished @kampus deps`;
	}
	if (verdict.reason === "zero-scope") {
		return (
			"publish-isolation-guard: derived ZERO published packages — fail-closed (ADR 0092). " +
			"Does publish.yml still declare a `<name>-v<version>` release-tag grammar, and does its prefix map to a workspace member?"
		);
	}
	const lines = verdict.violations.map((v) =>
		v.kind === "workspace-link"
			? `  ${v.path}: ${v.field} \`${v.name}\` links \`${v.value}\` — a workspace: specifier never resolves from a clean registry (the #3802 class). ` +
				`Fix: inline it as a tool, or depend on a PUBLISHED version instead.`
			: `  ${v.path}: ${v.field} \`${v.name}\` (\`${v.value}\`) is a private/unpublished @kampus package — an external install can't resolve it (the #3802 class, ADR 0201 §3). ` +
				`Fix: inline it, or publish that package and depend on its registry version.`,
	);
	return (
		`publish-isolation-guard: ${verdict.violations.length} publish-isolation violation${verdict.violations.length === 1 ? "" : "s"} ` +
		`across ${verdict.scanned.length} published package${verdict.scanned.length === 1 ? "" : "s"} (${verdict.scanned.join(", ")}):\n${lines.join("\n")}`
	);
};

/**
 * Extract the release-tag prefixes from `publish.yml`'s tag-grammar regexes. Each
 * `^<prefix>-v(...)` anchor names a published artifact (e.g. `^pipeline-cli-v([0-9].*)$`
 * → prefix `pipeline-cli`). This grounds the guard's scope in the release pipeline's
 * OWN source of truth (ADR 0201 §4) rather than a parallel hand-kept list — the
 * criterion's "never a hardcoded ad-hoc list divorced from what actually publishes."
 *
 * Minimal and dependency-free: it keys on the regex-anchor form `^<prefix>-v(`, which
 * is discriminating — the bare `pipeline-cli-v<version>` mentions in prose comments
 * carry no leading `^` and no `(`, so they don't match.
 */
export const parsePublishedTagPrefixes = (workflowYaml: string): ReadonlyArray<string> => {
	const out = new Set<string>();
	const re = /\^([A-Za-z0-9][\w.-]*?)-v\(/g;
	for (let m = re.exec(workflowYaml); m !== null; m = re.exec(workflowYaml)) {
		if (m[1] !== undefined) out.add(m[1]);
	}
	return [...out].sort();
};

/** The outcome of mapping publish.yml's tag prefixes onto workspace members. */
export interface PublishedResolution {
	/** Members whose unscoped name matches a published tag prefix. */
	readonly published: ReadonlyArray<PublishedManifest>;
	/** Prefixes that matched no member — publish.yml/workspace drift; the gate fails closed on these. */
	readonly unmatchedPrefixes: ReadonlyArray<string>;
}

/**
 * Map the published tag prefixes onto the enumerated workspace members by unscoped
 * package name (`@kampus/pipeline-cli`'s unscoped `pipeline-cli` matches the
 * `pipeline-cli` tag). A prefix with no matching member is surfaced as drift so the
 * gate can fail closed rather than silently narrow scope — keeping the derived set
 * honest against publish.yml.
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

/**
 * Extract the `packages:` sequence globs from a `pnpm-workspace.yaml`'s text — the
 * declared workspace shape the member scan grounds in, rather than a hardcoded literal.
 * A minimal, dependency-free YAML slice (reads the top-level `packages:` block's
 * `- <glob>` items, stops at the next top-level key); sufficient for this file's flat
 * shape, not a general YAML parser.
 */
export const parseWorkspacePackageGlobs = (yaml: string): ReadonlyArray<string> => {
	const out: Array<string> = [];
	let inPackages = false;
	for (const raw of yaml.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (/^packages:\s*$/.test(line)) {
			inPackages = true;
			continue;
		}
		if (!inPackages) continue;
		if (/^\S/.test(line) && !line.startsWith("-")) break;
		const m = /^\s*-\s*(.+?)\s*$/.exec(line);
		if (m?.[1] !== undefined) out.push(m[1].replace(/^['"]|['"]$/g, ""));
	}
	return out;
};

/** Flatten a parsed `package.json` object into `DepEntry`s over the runtime dep fields only. */
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
