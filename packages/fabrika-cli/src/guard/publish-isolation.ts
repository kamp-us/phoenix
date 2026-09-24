/**
 * `publish-isolation-guard`'s pure half — is every PUBLISHED package's runtime dependency graph
 * installable from a clean registry?
 *
 * The forcing incident: a scoped CLI published green at 0.2.0 yet was uninstallable, because it
 * declared three repo-private `workspace:*` packages as registry deps.
 *
 * The published set is DERIVED from `.github/workflows/publish.yml`'s resolve arms rather than
 * hand-kept here: a parallel list drifts from what actually publishes, and the drift is only
 * discovered by an external install failing. Each arm publishes the member at its `PKG_DIR`, so the
 * set is keyed on that directory, never on a name another member could share. An arm the members
 * cannot answer with exactly one package is drift, and it fails closed at the IO boundary in
 * `./publish-isolation-verb.ts`.
 *
 * A `workspace:` link to a sibling that is itself in the published set passes: `pnpm publish`
 * rewrites the specifier to that sibling's registry version at pack time. A relative-path link
 * (`workspace:../<dir>`) and a `link:`/`file:`/`portal:` dep always red: the first packs as
 * whatever package sits in that directory, the others ship verbatim, and neither's dep name says
 * which package reaches the consumer.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9740#issuecomment-5803759118
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
 * A dep that breaks publish isolation. Four kinds, each unresolvable from a clean registry or not
 * provably resolvable:
 * - `workspace-link`: a `workspace:` specifier whose target is not in the published set — pnpm
 *   rewrites it to a version nothing on the registry carries.
 * - `workspace-path-link`: a `workspace:./…` or `workspace:../…` specifier — pnpm packs it as
 *   `npm:<name at that directory>@<version>`, a package the guard cannot name from the manifest.
 * - `local-path-link`: a `link:`, `file:` or `portal:` specifier — `pnpm publish` rewrites none of
 *   them, so the tarball points a consumer at a path on this machine.
 * - `private-kampus-dep`: a `@kampus/*` registry dep, named directly or through an `npm:` alias,
 *   that is not itself published, so a clean registry has nothing to resolve it to.
 */
export interface IsolationViolation {
	readonly path: string;
	readonly field: string;
	readonly name: string;
	readonly value: string;
	readonly kind:
		| "workspace-link"
		| "workspace-path-link"
		| "local-path-link"
		| "private-kampus-dep";
}

/**
 * The verdict. A union, so a pass can never carry violations and the two failures each carry
 * exactly their own evidence. `scanned` is the set of published package NAMES covered.
 */
export type PublishIsolationVerdict =
	| {readonly pass: true; readonly scanned: ReadonlyArray<string>}
	/** No published package in scope — fail closed, never a vacuous pass. */
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
 * Where a dep's specifier points once pnpm installs and packs it.
 * - `workspace-package`: a `workspace:` link resolved by name — the aliased name in
 *   `workspace:<name>@<range>`, else the dependency's own name. A range that only embeds
 *   `workspace:` (a peer's `^1 || workspace:*`) is one too: pnpm rewrites it by the dep's own name.
 * - `workspace-path`: `workspace:./…`, `workspace:../…` or an absolute path, resolved by directory.
 * - `local-path`: a `link:`, `file:` or `portal:` specifier, which `pnpm publish` ships verbatim.
 * - `registry`: anything else, named by the package it fetches — an `npm:<name>@<range>` alias's
 *   target, else the dependency's own name.
 */
export type DepTarget =
	| {readonly kind: "workspace-package"; readonly name: string}
	| {readonly kind: "workspace-path"; readonly path: string}
	| {readonly kind: "local-path"; readonly spec: string}
	| {readonly kind: "registry"; readonly name: string};

const WORKSPACE_PROTOCOL = "workspace:";
const NPM_PROTOCOL = "npm:";
const LOCAL_PROTOCOLS = ["link:", "file:", "portal:"] as const;
/** `<name>@` at the head of an alias remainder — scoped `@s/n@` or unscoped `n@`. */
const ALIASED_NAME = /^((?:@[^/@]+\/)?[^/@]+)@/;

export const depTarget = (dep: DepEntry): DepTarget => {
	const value = dep.value.trim();
	if (value.startsWith(WORKSPACE_PROTOCOL)) {
		const rest = value.slice(WORKSPACE_PROTOCOL.length);
		if (rest.startsWith(".") || rest.startsWith("/")) return {kind: "workspace-path", path: rest};
		return {kind: "workspace-package", name: ALIASED_NAME.exec(rest)?.[1] ?? dep.name};
	}
	if (value.includes(WORKSPACE_PROTOCOL)) return {kind: "workspace-package", name: dep.name};
	if (LOCAL_PROTOCOLS.some((p) => value.startsWith(p))) return {kind: "local-path", spec: value};
	if (value.startsWith(NPM_PROTOCOL)) {
		const rest = value.slice(NPM_PROTOCOL.length);
		return {kind: "registry", name: ALIASED_NAME.exec(rest)?.[1] ?? rest};
	}
	return {kind: "registry", name: dep.name};
};

const violationKind = (
	target: DepTarget,
	publishedNames: ReadonlySet<string>,
): IsolationViolation["kind"] | undefined => {
	switch (target.kind) {
		case "workspace-package":
			return publishedNames.has(target.name) ? undefined : "workspace-link";
		case "workspace-path":
			return "workspace-path-link";
		case "local-path":
			return "local-path-link";
		case "registry":
			return target.name.startsWith(KAMPUS_SCOPE) && !publishedNames.has(target.name)
				? "private-kampus-dep"
				: undefined;
	}
};

/**
 * Decide the verdict over the published manifests. A dep whose target is itself in the published
 * set resolves cleanly, whether it names a registry range or a `workspace:` link. The manifests'
 * names stand for the published packages only because {@link resolvePublished} refuses a name
 * another workspace member also carries.
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
			const kind = violationKind(depTarget(dep), publishedNames);
			if (kind !== undefined) {
				violations.push({path: m.path, field: dep.field, name: dep.name, value: dep.value, kind});
			}
		}
	}
	if (violations.length > 0) {
		return {pass: false, reason: "linked-private-deps", scanned, violations};
	}
	return {pass: true, scanned};
};

/** One violation as its own report line, carrying the why and the fix. */
export const violationLine = (v: IsolationViolation): string => {
	switch (v.kind) {
		case "workspace-link":
			return (
				`  ${v.path}: ${v.field} \`${v.name}\` links \`${v.value}\` — a workspace: link to a package publish.yml does not publish never resolves from a clean registry. ` +
				"Fix: inline it, or publish that package so the link names a published sibling."
			);
		case "workspace-path-link":
			return (
				`  ${v.path}: ${v.field} \`${v.name}\` links \`${v.value}\` — a path-form workspace: link packs as whatever package sits in that directory, which the guard cannot prove is published. ` +
				"Fix: link the published sibling by name (`workspace:*`), or inline it."
			);
		case "local-path-link":
			return (
				`  ${v.path}: ${v.field} \`${v.name}\` links \`${v.value}\` — pnpm publish ships a link:/file:/portal: specifier verbatim, so the tarball points at a path no consumer has. ` +
				"Fix: link the published sibling by name (`workspace:*`), or inline it."
			);
		case "private-kampus-dep":
			return (
				`  ${v.path}: ${v.field} \`${v.name}\` (\`${v.value}\`) is a private/unpublished @kampus package — an external install cannot resolve it. ` +
				"Fix: inline it, or publish that package and depend on its registry version."
			);
	}
};

/** The human report for a verdict — it names what was scanned, not only what failed. */
export const renderReport = (verb: string, verdict: PublishIsolationVerdict): string => {
	if (verdict.pass) {
		const n = verdict.scanned.length;
		return `${verb}: ${n} published package${n === 1 ? "" : "s"} (${verdict.scanned.join(", ")}) link${n === 1 ? "s" : ""} no private/unpublished @kampus deps`;
	}
	if (verdict.reason === "zero-scope") {
		return (
			`${verb}: derived ZERO published packages — fail-closed. ` +
			'Does publish.yml still declare `<name>-v<version>` resolve arms, each setting `PKG_DIR="<dir>"`?'
		);
	}
	const n = verdict.violations.length;
	return (
		`${verb}: ${n} publish-isolation violation${n === 1 ? "" : "s"} ` +
		`across ${verdict.scanned.length} published package${verdict.scanned.length === 1 ? "" : "s"} (${verdict.scanned.join(", ")}):\n${verdict.violations.map(violationLine).join("\n")}`
	);
};

/** One resolve arm of `publish.yml`: the tag prefix it matches and the `PKG_DIR` it publishes. */
export interface PublishArm {
	readonly prefix: string;
	/** `null` when no `PKG_DIR="<dir>"` follows the anchor before the next one. */
	readonly dir: string | null;
}

const ARM_ANCHOR = /\^([A-Za-z0-9][\w.-]*?)-v\(/g;
const ARM_DIR = /\bPKG_DIR="([^"]+)"/;

/**
 * The resolve arms `publish.yml` declares, in file order. Each `^<prefix>-v(` anchor opens an arm
 * (`^fabrika-cli-v([0-9].*)$` → `fabrika-cli`), and the first `PKG_DIR="<dir>"` before the next
 * anchor is the directory it publishes.
 *
 * The anchor form is what makes this discriminating: a `fabrika-cli-v<version>` mention in a prose
 * comment carries no leading `^` and no `(`, so it does not match and cannot inflate the scope.
 */
export const parsePublishArms = (workflowYaml: string): ReadonlyArray<PublishArm> => {
	const anchors = [...workflowYaml.matchAll(ARM_ANCHOR)];
	return anchors.map((m, i) => {
		const from = m.index + m[0].length;
		const to = anchors[i + 1]?.index ?? workflowYaml.length;
		return {prefix: m[1] ?? "", dir: ARM_DIR.exec(workflowYaml.slice(from, to))?.[1] ?? null};
	});
};

/**
 * A resolve arm the workspace cannot answer with exactly one published member. Every reason fails
 * closed: a guessed member is how the allow-list comes to trust a package `publish.yml` never ships.
 * - `no-directory`: no arm for the prefix sets a `PKG_DIR`.
 * - `several-directories`: the prefix's arms set different directories.
 * - `no-member`: no workspace member sits at the directory.
 * - `name-mismatch`: the member there is not named `<prefix>` once unscoped — the tag grammar and
 *   the package name have drifted.
 * - `name-shared`: another member carries the same package name. pnpm resolves a `workspace:` link
 *   by name and takes the highest matching version, so the link can reach the other member.
 */
export type ScopeDrift =
	| {readonly reason: "no-directory"; readonly prefix: string}
	| {
			readonly reason: "several-directories";
			readonly prefix: string;
			readonly dirs: ReadonlyArray<string>;
	  }
	| {readonly reason: "no-member"; readonly prefix: string; readonly dir: string}
	| {
			readonly reason: "name-mismatch";
			readonly prefix: string;
			readonly dir: string;
			readonly name: string;
	  }
	| {
			readonly reason: "name-shared";
			readonly prefix: string;
			readonly dir: string;
			readonly name: string;
			readonly others: ReadonlyArray<string>;
	  };

export interface PublishedResolution {
	/** The member at each prefix's `PKG_DIR`, one per prefix. */
	readonly published: ReadonlyArray<PublishedManifest>;
	/** Arms no single member answers — the verb reds on any. */
	readonly drift: ReadonlyArray<ScopeDrift>;
}

const MANIFEST_SUFFIX = "/package.json";

/** `packages/sdk-core/package.json` → `packages/sdk-core`. */
const manifestDir = (m: PublishedManifest): string =>
	m.path.endsWith(MANIFEST_SUFFIX) ? m.path.slice(0, -MANIFEST_SUFFIX.length) : m.path;

/**
 * Map the resolve arms onto workspace members by the directory each arm publishes. A prefix whose
 * member is missing, misnamed or shares its name is surfaced as drift rather than silently
 * narrowing, or widening, the scope.
 */
export const resolvePublished = (
	arms: ReadonlyArray<PublishArm>,
	members: ReadonlyArray<PublishedManifest>,
): PublishedResolution => {
	const dirsByPrefix = new Map<string, Set<string>>();
	for (const arm of arms) {
		const dirs = dirsByPrefix.get(arm.prefix) ?? new Set<string>();
		if (arm.dir !== null) dirs.add(arm.dir);
		dirsByPrefix.set(arm.prefix, dirs);
	}
	const published: Array<PublishedManifest> = [];
	const drift: Array<ScopeDrift> = [];
	for (const [prefix, dirSet] of dirsByPrefix) {
		const dirs = [...dirSet].sort();
		const [dir] = dirs;
		if (dir === undefined) {
			drift.push({reason: "no-directory", prefix});
			continue;
		}
		if (dirs.length > 1) {
			drift.push({reason: "several-directories", prefix, dirs});
			continue;
		}
		const member = members.find((m) => manifestDir(m) === dir);
		if (member === undefined) {
			drift.push({reason: "no-member", prefix, dir});
			continue;
		}
		if (unscopedName(member.name) !== prefix) {
			drift.push({reason: "name-mismatch", prefix, dir, name: member.name});
			continue;
		}
		const others = members.filter((m) => m !== member && m.name === member.name).map(manifestDir);
		if (others.length > 0) {
			drift.push({reason: "name-shared", prefix, dir, name: member.name, others});
			continue;
		}
		published.push(member);
	}
	return {published, drift};
};

/** One drift as its own report line, carrying the fix. */
export const driftLine = (d: ScopeDrift): string => {
	switch (d.reason) {
		case "no-directory":
			return `  \`${d.prefix}\`: the arm sets no \`PKG_DIR="<dir>"\`, so the guard cannot tell which member it publishes.`;
		case "several-directories":
			return `  \`${d.prefix}\`: its arms set different directories (${d.dirs.join(", ")}). Keep one arm per prefix.`;
		case "no-member":
			return `  \`${d.prefix}\`: PKG_DIR \`${d.dir}\` maps to no workspace member. Is the directory right, and does it carry a package.json?`;
		case "name-mismatch":
			return `  \`${d.prefix}\`: the member at \`${d.dir}\` is \`${d.name}\`, whose unscoped name is not the tag prefix. Re-sync the arm with the package name.`;
		case "name-shared":
			return `  \`${d.prefix}\`: \`${d.name}\` at \`${d.dir}\` shares its name with ${d.others.map((o) => `\`${o}\``).join(", ")}. pnpm resolves a workspace: link by name, so the link could reach the unpublished one. Rename the other member.`;
	}
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
