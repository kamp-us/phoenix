/**
 * `@kampus/package-test-scope` core — the pure, IO-free decision for which workspace
 * packages CI's `packages unit tests` job runs (issue #10023).
 *
 * FAIL-SAFE TO THE FULL RUN: a wrong narrowing skips a suite that would have gone red,
 * so the scope narrows ONLY when every changed path is inside a workspace package and
 * the event carries a diff base. Anything else runs every package, and the full run on
 * every `push` to `main` is the backstop for a cross-package read this table misses.
 */

/** One workspace package, as its manifest declares it. */
export interface Member {
	/** The manifest `name`, e.g. `@kampus/fabrika-cli`. */
	readonly name: string;
	/** Repo-relative directory with no trailing slash, e.g. `packages/fabrika-cli`. */
	readonly dir: string;
	/** Every dependency name the manifest lists, of any kind. */
	readonly dependencies: ReadonlyArray<string>;
	/** Whether the manifest declares a `test` script. */
	readonly hasTest: boolean;
}

export interface ScopeInput {
	/** `GITHUB_EVENT_NAME`. */
	readonly event: string;
	/** The resolved diff base SHA; empty when none resolved. */
	readonly base: string;
	/** Changed repo-relative paths since `base`; `null` when the diff could not be read. */
	readonly changedFiles: ReadonlyArray<string> | null;
	readonly members: ReadonlyArray<Member>;
}

export type Scope =
	| {readonly kind: "full"; readonly reason: string}
	| {
			readonly kind: "scoped";
			readonly packages: readonly [string, ...ReadonlyArray<string>];
			readonly reason: string;
	  }
	| {readonly kind: "none"; readonly reason: string};

/** The two events that carry a diff base the `changes` job pins (#3722, #3797). */
export const SCOPED_EVENTS: ReadonlySet<string> = new Set(["pull_request", "merge_group"]);

/** The package outside `packages/` whose suite the job has always run (#1437). */
export const INFRA_PACKAGE = "@kampus/infra";

/**
 * Package tests that read another workspace package's files through `fs` or a relative
 * path, which no manifest edge records. A changed path under `prefix` selects every
 * reader, without the reader's own dependents.
 */
export const CROSS_PACKAGE_READS: ReadonlyArray<{
	readonly prefix: string;
	readonly readers: ReadonlyArray<string>;
}> = [
	{
		prefix: "apps/web/",
		readers: [
			// apps/web/worker/db/drizzle/migrations
			"@kampus/admin-grant",
			"@kampus/founder-seed",
			"@kampus/migrations-guard",
			"@kampus/preview-seed",
			// apps/web/src stylesheets and components
			"@kampus/design",
			// apps/web/tests/{integration,e2e}, scanned by the bin its test spawns
			"@kampus/worker-relevance",
		],
	},
	{
		prefix: "apps/tuval/",
		// apps/tuval/src stylesheets
		readers: ["@kampus/design"],
	},
];

/** True for a package the `packages unit tests` job runs: a tested member of `packages/`, or infra. */
export const inTestScope = (member: Member): boolean =>
	member.hasTest && (member.dir.startsWith("packages/") || member.name === INFRA_PACKAGE);

/** Whether `scope` runs the named package's suite. The full run runs every package. */
export const selects = (scope: Scope, name: string): boolean =>
	scope.kind === "full" || (scope.kind === "scoped" && scope.packages.includes(name));

const MAX_LISTED = 5;

const listed = (items: ReadonlyArray<string>): string => {
	const shown = items.slice(0, MAX_LISTED).join(", ");
	return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
};

const ownerOf = (path: string, members: ReadonlyArray<Member>): Member | undefined =>
	members.find((member) => path.startsWith(`${member.dir}/`));

const dependentsClosure = (
	seeds: ReadonlySet<string>,
	members: ReadonlyArray<Member>,
): ReadonlySet<string> => {
	const dependents = new Map<string, string[]>();
	for (const member of members) {
		for (const dependency of member.dependencies) {
			const list = dependents.get(dependency) ?? [];
			list.push(member.name);
			dependents.set(dependency, list);
		}
	}
	const reached = new Set(seeds);
	const queue = [...seeds];
	for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
		for (const dependent of dependents.get(name) ?? []) {
			if (reached.has(dependent)) continue;
			reached.add(dependent);
			queue.push(dependent);
		}
	}
	return reached;
};

export const decideScope = (input: ScopeInput): Scope => {
	if (!SCOPED_EVENTS.has(input.event)) {
		return {kind: "full", reason: `a ${input.event || "unnamed"} event runs every package`};
	}
	if (input.base === "") {
		return {kind: "full", reason: "no diff base resolved, so the diff is unknown"};
	}
	if (input.changedFiles === null) {
		return {kind: "full", reason: `the diff against ${input.base} could not be read`};
	}
	const names = new Set(input.members.map((member) => member.name));
	const unknownReaders = CROSS_PACKAGE_READS.flatMap((read) => read.readers).filter(
		(reader) => !names.has(reader),
	);
	if (unknownReaders.length > 0) {
		return {
			kind: "full",
			reason: `the cross-package read table names ${listed(unknownReaders)}, which is not a workspace package`,
		};
	}

	const outside: string[] = [];
	const manifests: string[] = [];
	const owners = new Set<string>();
	const readers = new Set<string>();
	for (const path of input.changedFiles) {
		const owner = ownerOf(path, input.members);
		if (owner === undefined) outside.push(path);
		else if (path === `${owner.dir}/package.json`) manifests.push(path);
		else owners.add(owner.name);
		for (const read of CROSS_PACKAGE_READS) {
			if (path.startsWith(read.prefix)) for (const reader of read.readers) readers.add(reader);
		}
	}
	if (outside.length > 0) {
		return {
			kind: "full",
			reason: `${listed(outside)} is outside every workspace package, and package tests read files there`,
		};
	}
	if (manifests.length > 0) {
		return {
			kind: "full",
			reason: `${listed(manifests)} changed, and manifests shape the dependency graph and are read across packages`,
		};
	}

	const tested = new Set(input.members.filter(inTestScope).map((member) => member.name));
	// A reader's own dependents are not selected: the changed file reaches them through no import.
	const selected = [...new Set([...dependentsClosure(owners, input.members), ...readers])]
		.filter((name) => tested.has(name))
		.sort();
	const touched = [...owners].sort();
	const [first, ...rest] = selected;
	if (first === undefined) {
		return {
			kind: "none",
			reason:
				touched.length === 0
					? `the diff against ${input.base} changed no file`
					: `the diff changed only ${listed(touched)}, and neither they nor their dependents are tested packages under packages/ or ${INFRA_PACKAGE}`,
		};
	}
	return {
		kind: "scoped",
		packages: [first, ...rest],
		reason: `the diff changed ${listed(touched)}; running them and their tested dependents and readers`,
	};
};
