/**
 * `@kampus/worker-relevance` core — the pure, IO-free verdict for whether a PR's
 * diff can affect the `apps/web` worker, so the `changes` job can SKIP the slow
 * real-D1 `integration`/`e2e` tiers for a diff confined to packages the worker
 * never imports (issue #1014).
 *
 * Why this exists: the `backend`/`e2e` path filters in ci.yml list `pnpm-lock.yaml`
 * as a trigger, because a lockfile delta *can* bump a worker-imported dep's
 * resolution and that genuinely needs integration. `dorny/paths-filter` can't
 * attribute a lockfile diff to a specific package, so it conservatively runs
 * integration on EVERY lockfile change — and a packages-only PR (every #994
 * pipeline-cli reorg child) edits the lockfile, so it pays the worker-integration
 * tier (and the #1010/#813 stage-leak flake) despite touching nothing the worker
 * runs. This core distinguishes a lockfile delta confined to non-worker importers
 * from one that touches a worker dep, and decides whether to skip.
 *
 * FAIL-SAFE TO RUNNING (the load-bearing invariant): a wrong skip is a missed
 * worker regression, so the verdict is `irrelevant` (safe to skip) ONLY when the
 * WHOLE diff is provably confined to worker-irrelevant surfaces. Anything else —
 * any non-package path, any worker-relevant package, any lockfile change outside a
 * non-worker importer block, any ambiguity or parse failure — is `relevant`
 * (RUN). When unsure, run.
 *
 * GROUNDED worker-import closure (issue #1014, verified against source, not the
 * issue's example list): `apps/web`'s only `@kampus/*` workspace deps are
 * `db-schema` and `fate-effect` (apps/web/package.json), and each of those is a
 * leaf (no `@kampus/*` deps of its own). So the worker's transitive in-repo
 * closure is exactly {db-schema, fate-effect}. `d1-rest` is NOT in it (the issue
 * guessed it was) — it's consumed only by fts-backfill/preview-seed/moderator-grant.
 * preview-seed + moderator-grant are added to the integration-relevant set anyway:
 * they own their OWN real-D1 integration tiers run by the `integration` job
 * (ADR 0082, #672/#930), so a change to either must still trip integration.
 */

/**
 * Packages whose change MUST run the worker `integration`/`e2e` tiers. The worker's
 * grounded import closure ∪ the packages that own their own real-D1 integration
 * tiers in the `integration` job. A `packages/<name>/**` change is integration-
 * relevant iff `name` is in this set. Everything else under `packages/**` is
 * dev-tooling the worker never imports → not integration-relevant on its own.
 */
export const INTEGRATION_RELEVANT_PACKAGES: ReadonlySet<string> = new Set([
	// worker's grounded @kampus/* import closure (apps/web/package.json; both leaves)
	"db-schema",
	"fate-effect",
	// own real-D1 integration tiers run by the `integration` job (ADR 0082, #672/#930)
	"preview-seed",
	"moderator-grant",
]);

/** The lockfile whose attribution is the hard, fail-safe-to-running case. */
export const LOCKFILE = "pnpm-lock.yaml";

export type Verdict = "relevant" | "irrelevant";

export interface ClassifyResult {
	/**
	 * `relevant` ⇒ the diff can affect the worker ⇒ RUN integration/e2e.
	 * `irrelevant` ⇒ provably confined to worker-irrelevant surfaces ⇒ safe to SKIP.
	 */
	readonly verdict: Verdict;
	/** First changed path (or lockfile hunk) that forced `relevant`, else null. */
	readonly trigger: string | null;
	/** One-line, log-ready reason (ADR 0092 §1 "emit what you scanned"). */
	readonly reason: string;
}

export interface ClassifyInput {
	/** PR's changed file paths (base...head, repo-root-relative), lockfile included. */
	readonly changedFiles: ReadonlyArray<string>;
	/**
	 * Whether `pnpm-lock.yaml` is among the changed files. When true, `lockfileDiff`
	 * MUST be the unified diff of the lockfile so its hunks can be attributed; a
	 * true flag with no/empty diff fails safe to `relevant`.
	 */
	readonly lockfileChanged: boolean;
	/** Unified diff of `pnpm-lock.yaml` (`git diff base...head -- pnpm-lock.yaml`). */
	readonly lockfileDiff: string;
}

const PACKAGE_PATH = /^packages\/([^/]+)\//;

/**
 * Is a single non-lockfile changed path worker-irrelevant? True ONLY for a file
 * under a `packages/<name>/` dir whose `<name>` is NOT in the integration-relevant
 * set. Every other path — `apps/**`, `infra/**`, root configs, workflows, a
 * `packages/<relevant>/**` file, or a bare `packages/foo` with no trailing slash —
 * is worker-relevant (fail safe to running).
 */
const isIrrelevantPath = (path: string): boolean => {
	const m = PACKAGE_PATH.exec(path);
	if (m === null) return false;
	const pkg = m[1];
	return pkg !== undefined && !INTEGRATION_RELEVANT_PACKAGES.has(pkg);
};

/**
 * Attribute every changed line of the lockfile diff to a section and decide whether
 * the worker's dependency resolution could have changed.
 *
 * The pnpm v9 lockfile is one `importers:` section of per-package blocks keyed by
 * path (`apps/web:`, `packages/<name>:`, …) over the shared `catalogs:`/`packages:`/
 * `snapshots:`/`patchedDependencies:`/`settings:` sections. A change is provably
 * worker-irrelevant ONLY when every changed line falls inside the importer block of
 * a worker-IRRELEVANT package. Any changed line in a shared section (it can re-pin
 * an already-resolved version that a worker dep also links — fail safe), in the
 * `apps/web` importer block, or in a worker-RELEVANT package's importer block ⇒
 * worker-relevant. The catalog-discipline (CLAUDE.md: every dep via `catalog:`)
 * makes the common tooling-package add land entirely in its own importer block with
 * NO shared-section delta (verified on PR #1012's lockfile diff), so the skip fires
 * exactly for that shape and fails safe for anything richer.
 *
 * Returns the offending header/section string when relevant, else null (irrelevant).
 */
const lockfileTriggersWorker = (diff: string): string | null => {
	if (diff.trim() === "") {
		// lockfileChanged=true but we couldn't read the diff — cannot prove confinement.
		return "pnpm-lock.yaml (changed but diff unavailable — fail safe to running)";
	}

	const lines = diff.split("\n");
	// Track which importer block / top-level section the current diff line sits in.
	// Outside `importers:` (catalogs/packages/snapshots/…) every changed line is
	// shared ⇒ relevant. Inside `importers:`, a line is safe only when its enclosing
	// per-package block is a worker-IRRELEVANT package.
	//
	// A hunk almost never starts ON a section/importer header: its leading context
	// lines are mid-block dep entries, and the only nearby section name is the one
	// `git diff` prints AFTER the `@@ … @@` (the `--show-function`/hunk-header hint,
	// e.g. `@@ -686,6 +686,34 @@ importers:`). So a hunk header carrying `importers:`
	// re-seeds `inImporters`; a hunk header carrying any other section name (or a
	// bare `@@`) drops out of importers — without this the first added importer block
	// after a section-spanning context reads as shared and (correctly) fails safe,
	// but the COMMON catalog-confined add (the #1012 shape) would never be skippable.
	// The importer-IRRELEVANT flag is reset per hunk: a hunk that opens mid-block
	// can't prove its package, so it starts relevant until an importer header re-proves it.
	let inImporters = false;
	let currentImporterIrrelevant = false;
	let currentSectionLabel = "<lockfile preamble / shared section>";

	for (const raw of lines) {
		if (raw.startsWith("@@")) {
			// `@@ -a,b +c,d @@ <section-hint>` — the trailing hint is the nearest
			// enclosing section git found. Use it to seed `inImporters`; we can't know
			// the specific importer block yet (a header line inside the hunk proves it),
			// so start the block as NOT-proven-irrelevant ⇒ a changed line before any
			// in-hunk importer header fails safe to relevant.
			const hint = raw.replace(/^@@[^@]*@@\s?/, "").trim();
			inImporters = hint === "importers:";
			currentImporterIrrelevant = false;
			currentSectionLabel = inImporters ? "importers:" : hint || "<shared section>";
			continue;
		}
		// Other diff metadata lines carry no attributable content position; skip them.
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
		// Line content with the diff marker stripped (context lines have a leading
		// space; changed lines a +/-).
		const content = isChange || marker === " " ? raw.slice(1) : raw;

		// Section/importer-block tracking keys off the YAML indentation a diff line
		// preserves after the marker is stripped: a col-0 `key:` header opens a
		// top-level section (`importers:` opens importers; any other leaves it for a
		// shared section); a 2-space-indent `  <path>:` header inside importers opens
		// one per-package block.
		if (/^[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(content)) {
			inImporters = content === "importers:";
			currentImporterIrrelevant = false;
			currentSectionLabel = content.trim();
		} else if (inImporters) {
			const header = /^ {2}([^\s:][^:]*):\s*$/.exec(content);
			if (header !== null && header[1] !== undefined) {
				const importerPath = header[1];
				const pkg = /^packages\/([^/]+)$/.exec(importerPath);
				currentImporterIrrelevant =
					pkg !== null && pkg[1] !== undefined && !INTEGRATION_RELEVANT_PACKAGES.has(pkg[1]);
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
 * The whole-diff verdict. `irrelevant` (safe to skip integration/e2e) ONLY when
 * EVERY changed non-lockfile path is worker-irrelevant AND the lockfile delta (if
 * any) is confined to worker-irrelevant importer blocks. Fail-safe: the first
 * worker-relevant signal returns `relevant`. An empty diff is `irrelevant` — but
 * ci.yml only consults this when the path filter already saw a lockfile/package
 * change, so this is the confined-skip path, never a blanket skip.
 */
export const classify = (input: ClassifyInput): ClassifyResult => {
	for (const path of input.changedFiles) {
		if (path === LOCKFILE) continue; // handled below via the diff
		if (!isIrrelevantPath(path)) {
			return {
				verdict: "relevant",
				trigger: path,
				reason: `relevant — worker-affecting path changed: ${path} (run integration/e2e; fail-safe)`,
			};
		}
	}

	if (input.lockfileChanged) {
		const trigger = lockfileTriggersWorker(input.lockfileDiff);
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

/** Split a NUL- or newline-separated changed-file list (from `git diff --name-only`). */
export const parseChangedFiles = (raw: string): ReadonlyArray<string> =>
	raw
		.split(/\0|\n/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

/**
 * Map the classify step's `env:` to a `ClassifyInput`. `CHANGED_FILES` is the
 * newline/NUL-joined `git diff --name-only` list; `LOCKFILE_DIFF` is the lockfile's
 * unified diff (empty when the lockfile didn't change). The lockfile-changed flag is
 * derived from the file list so there's one source of truth.
 */
export const inputFromEnv = (e: Record<string, string | undefined>): ClassifyInput => {
	const changedFiles = parseChangedFiles(e.CHANGED_FILES ?? "");
	return {
		changedFiles,
		lockfileChanged: changedFiles.includes(LOCKFILE),
		lockfileDiff: e.LOCKFILE_DIFF ?? "",
	};
};
