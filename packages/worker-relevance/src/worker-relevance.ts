/**
 * `@kampus/worker-relevance` core — the pure, IO-free verdict for whether a PR's
 * diff can affect the `apps/web` worker, so CI can skip the real-D1
 * `integration`/`e2e` tiers for a diff confined to packages the worker never
 * imports (issue #1014, ADR 0114).
 *
 * FAIL-SAFE TO RUNNING (the load-bearing invariant): a wrong skip is a missed
 * worker regression, so the verdict is `irrelevant` ONLY when the WHOLE diff is
 * provably confined to worker-irrelevant surfaces. Any ambiguity or parse failure
 * is `relevant`. When unsure, run.
 */

/**
 * The WORKER-import closure — one of the two closures the verdict unions (ADR
 * 0114); the other is computed per run and arrives as
 * `ClassifyInput.testImportedPackages`. Grounded against apps/web/package.json:
 * its only `@kampus/*` deps are `db-schema` and `fate-effect`, both leaves.
 */
export const INTEGRATION_RELEVANT_PACKAGES: ReadonlySet<string> = new Set([
	"db-schema",
	"fate-effect",
	// own real-D1 integration tier run by the `integration` job (ADR 0082, #672)
	"preview-seed",
]);

export const LOCKFILE = "pnpm-lock.yaml";

export type Verdict = "relevant" | "irrelevant";

export interface ClassifyResult {
	/** `relevant` ⇒ RUN integration/e2e; `irrelevant` ⇒ safe to SKIP. */
	readonly verdict: Verdict;
	readonly trigger: string | null;
	readonly reason: string;
}

export interface ClassifyInput {
	/** Changed paths, base...head, repo-root-relative, lockfile included. */
	readonly changedFiles: ReadonlyArray<string>;
	/**
	 * When true, `lockfileDiff` MUST carry the lockfile's unified diff so its hunks
	 * can be attributed; a true flag with no/empty diff fails safe to `relevant`.
	 */
	readonly lockfileChanged: boolean;
	/** `git diff base...head -- pnpm-lock.yaml`. */
	readonly lockfileDiff: string;
	/**
	 * The TEST-import closure (ADR 0114), computed per run from the real imports
	 * under the test trees. Optional: absent ⇒ empty ⇒ pre-0114 behavior. Never
	 * narrowed here — an empty/failed scan fails safe to `relevant` in the bin.
	 */
	readonly testImportedPackages?: ReadonlySet<string>;
}

const PACKAGE_PATH = /^packages\/([^/]+)\//;

const relevantPackages = (input: ClassifyInput): ReadonlySet<string> => {
	const test = input.testImportedPackages;
	if (test === undefined || test.size === 0) return INTEGRATION_RELEVANT_PACKAGES;
	return new Set([...INTEGRATION_RELEVANT_PACKAGES, ...test]);
};

/**
 * True ONLY for a file under a `packages/<name>/` dir outside `relevant`. Every
 * other path — `apps/**`, `infra/**`, root configs, workflows, even a bare
 * `packages/foo` with no trailing slash — is worker-relevant (fail safe).
 */
const isIrrelevantPath = (path: string, relevant: ReadonlySet<string>): boolean => {
	const m = PACKAGE_PATH.exec(path);
	if (m === null) return false;
	const pkg = m[1];
	return pkg !== undefined && !relevant.has(pkg);
};

/**
 * Attribute every changed line of the lockfile diff to a section and decide whether
 * the worker's dependency resolution could have changed. Returns the offending
 * section string when relevant, else null.
 *
 * The pnpm v9 lockfile is one `importers:` section of per-package blocks keyed by
 * path over the shared `catalogs:`/`packages:`/`snapshots:`/… sections. A change is
 * provably worker-irrelevant ONLY when every changed line falls inside the importer
 * block of a worker-IRRELEVANT package: a shared-section line can re-pin a version
 * a worker dep also links, so it fails safe.
 */
const lockfileTriggersWorker = (diff: string, relevant: ReadonlySet<string>): string | null => {
	if (diff.trim() === "") {
		// lockfileChanged=true but we couldn't read the diff — cannot prove confinement.
		return "pnpm-lock.yaml (changed but diff unavailable — fail safe to running)";
	}

	const lines = diff.split("\n");
	// A hunk almost never starts ON a section/importer header: its leading context
	// lines are mid-block dep entries, and the only nearby section name is the one
	// `git diff` prints AFTER the `@@ … @@` (the hunk-header hint, e.g.
	// `@@ -686,6 +686,34 @@ importers:`). So that hint seeds `inImporters` — without
	// it the COMMON catalog-confined add (the #1012 shape) could never be skippable.
	// The irrelevant flag resets per hunk: a hunk opening mid-block can't prove its
	// package, so it starts relevant until an importer header re-proves it.
	let inImporters = false;
	let currentImporterIrrelevant = false;
	let currentSectionLabel = "<lockfile preamble / shared section>";

	for (const raw of lines) {
		if (raw.startsWith("@@")) {
			const hint = raw.replace(/^@@[^@]*@@\s?/, "").trim();
			inImporters = hint === "importers:";
			currentImporterIrrelevant = false;
			currentSectionLabel = inImporters ? "importers:" : hint || "<shared section>";
			continue;
		}
		if (
			raw.startsWith("+++") ||
			raw.startsWith("---") ||
			raw.startsWith("diff ") ||
			raw.startsWith("index ")
		) {
			continue;
		}

		const marker = raw[0];
		const isChange = marker === "+" || marker === "-";
		const content = isChange || marker === " " ? raw.slice(1) : raw;

		// Block tracking keys off the YAML indentation a diff line preserves once the
		// marker is stripped: col-0 `key:` opens a top-level section, a 2-space-indent
		// `  <path>:` inside importers opens one per-package block.
		if (/^[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(content)) {
			inImporters = content === "importers:";
			currentImporterIrrelevant = false;
			currentSectionLabel = content.trim();
		} else if (inImporters) {
			const header = /^ {2}([^\s:][^:]*):\s*$/.exec(content);
			if (header !== null && header[1] !== undefined) {
				const importerPath = header[1];
				const pkg = /^packages\/([^/]+)$/.exec(importerPath);
				currentImporterIrrelevant = pkg !== null && pkg[1] !== undefined && !relevant.has(pkg[1]);
				currentSectionLabel = `importers › ${importerPath}`;
			}
		}

		if (!isChange) continue;

		// A changed line that is NOT inside a worker-irrelevant importer block could
		// have altered the worker's resolution ⇒ relevant (fail safe).
		if (!(inImporters && currentImporterIrrelevant)) {
			return `pnpm-lock.yaml change in ${currentSectionLabel}`;
		}
	}

	return null;
};

/**
 * The whole-diff verdict, fail-safe: the first worker-relevant signal returns
 * `relevant`. An empty diff is `irrelevant` — safe because ci.yml only consults
 * this once its path filter already saw a lockfile/package change, so this is the
 * confined-skip path, never a blanket skip.
 */
export const classify = (input: ClassifyInput): ClassifyResult => {
	const relevant = relevantPackages(input);
	for (const path of input.changedFiles) {
		if (path === LOCKFILE) continue; // handled below via the diff
		if (!isIrrelevantPath(path, relevant)) {
			return {
				verdict: "relevant",
				trigger: path,
				reason: `relevant — worker-affecting path changed: ${path} (run integration/e2e; fail-safe)`,
			};
		}
	}

	if (input.lockfileChanged) {
		const trigger = lockfileTriggersWorker(input.lockfileDiff, relevant);
		if (trigger !== null) {
			return {
				verdict: "relevant",
				trigger,
				reason: `relevant — ${trigger} (a lockfile delta outside a worker-irrelevant importer block may bump a worker dep; run integration/e2e; fail-safe)`,
			};
		}
	}

	return {
		verdict: "irrelevant",
		trigger: null,
		reason:
			"irrelevant — diff confined to worker-irrelevant packages (and any lockfile delta confined to their importer blocks); safe to skip integration/e2e (issue #1014)",
	};
};

export const parseChangedFiles = (raw: string): ReadonlyArray<string> =>
	raw
		.split(/\0|\n/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

/**
 * Every `@kampus/<name>` module specifier in TS/JS source text; the capture is the
 * `packages/<name>` dir-name. A regex, not a TS parse, to keep the package's
 * zero-runtime-dependency shape — and deliberately OVER-inclusive (it matches a
 * specifier inside a comment or string too), which is the fail-safe direction (ADR
 * 0114): a spurious match only widens the closure, never narrows it.
 */
const KAMPUS_SPECIFIER = /['"]@kampus\/([a-z0-9][a-z0-9._-]*)(?:\/[^'"]*)?['"]/g;

export const extractKampusPackages = (source: string): ReadonlySet<string> => {
	const names = new Set<string>();
	for (const m of source.matchAll(KAMPUS_SPECIFIER)) {
		if (m[1] !== undefined) names.add(m[1]);
	}
	return names;
};

export const parseTestImportedPackages = (raw: string): ReadonlySet<string> =>
	new Set(
		raw
			.split(/\0|\n|,/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0),
	);

/**
 * Map the ci.yml classify step's `env:` to a `ClassifyInput`. The lockfile-changed
 * flag is derived from the file list so there's one source of truth.
 */
export const inputFromEnv = (e: Record<string, string | undefined>): ClassifyInput => {
	const changedFiles = parseChangedFiles(e.CHANGED_FILES ?? "");
	return {
		changedFiles,
		lockfileChanged: changedFiles.includes(LOCKFILE),
		lockfileDiff: e.LOCKFILE_DIFF ?? "",
		testImportedPackages: parseTestImportedPackages(e.TEST_IMPORTED_PACKAGES ?? ""),
	};
};
