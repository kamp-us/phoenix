/**
 * `trivial-diff` core — the pure, IO-free predicate that classifies a unified diff
 * as `trivial` or `non-trivial` for the right-sized fan-out (ADR
 * [0120](../../../../../.decisions/0120-stage-right-sizing-trivial-diff-lighter-gate.md) §1).
 *
 * This file holds the parsing + the classification over plain strings, with no disk
 * and no network (the core-in-its-own-file idiom; #855). `command.ts` is the thin CLI
 * bin that does the IO — it fetches the live `CONTROL_PLANE_RE` from `origin/main`
 * (REST raw, `?ref=main`) and reads the diff, then calls `classify` here.
 *
 * The contract is **fail-closed / default-deny** (ADR 0120 §3): a diff is `trivial`
 * ONLY on a positive, all-bounds-clear result. A failed bound, a parse error, an
 * unreadable / unparseable live boundary, or any ambiguity all resolve to
 * `non-trivial` — there is no third "unknown" state a caller could mistake for
 * trivial. The worst case of a classifier miss is paying the full (correct) fan-out
 * cost, never under-gating a non-trivial change.
 *
 * The bounds are a hard AND, mechanical (computed from the diff + the live boundary,
 * never a taste call), in the spirit of ADR 0070's four bounds:
 *   1. Small + single-concern — a single changed file that is doc/comment-only OR
 *      under the line bound `N`.
 *   2. No new surface / code-path change — no dependency/manifest/migration/schema/
 *      config path, and no new module edge (`export` / `import` / `require(`).
 *   3. Not control-plane — no changed path matches the live `CONTROL_PLANE_RE`.
 */

/** One file's slice of a unified diff: its path + line counts + the added-line bodies. */
export interface ChangedFile {
	/** Repo-relative path with no leading `a/` or `b/`. The post-image path for a rename. */
	readonly path: string;
	/** Count of added (`+`) content lines (the `+++` header is not counted). */
	readonly additions: number;
	/** Count of removed (`-`) content lines (the `---` header is not counted). */
	readonly deletions: number;
	/** The bodies of the added (`+`) content lines, sans the leading `+`. */
	readonly addedLines: ReadonlyArray<string>;
}

/** The terminal verdict — two states only, never an "unknown" a caller could read as trivial. */
export type Verdict = "trivial" | "non-trivial";

/** The classification: the verdict + a human-readable reason naming the deciding bound. */
export interface Classification {
	readonly verdict: Verdict;
	readonly reason: string;
}

/** Inputs the pure predicate needs from the (live) world, resolved by the bin. */
export interface ClassifyOptions {
	/**
	 * The live `CONTROL_PLANE_RE` string, re-resolved from `origin/main` at run time
	 * by the bin (ADR 0120 §1 bound 3 / §3). `null` means the boundary could not be
	 * read or parsed — the predicate then fails closed (every diff non-trivial), the
	 * same posture the gates take with `CONTROL_PLANE_RE='.'`.
	 */
	readonly controlPlaneRe: string | null;
	/** The single-file line bound `N` (added + removed) below which a non-doc file is trivial. */
	readonly lineBudget: number;
}

const trivial = (reason: string): Classification => ({verdict: "trivial", reason});
const nonTrivial = (reason: string): Classification => ({verdict: "non-trivial", reason});

/** Doc/comment-only file extensions + dirs — a single such file is trivial regardless of size. */
const DOC_EXTENSIONS = [".md", ".mdx", ".markdown", ".txt", ".rst"] as const;
const DOC_DIR_PREFIXES = [".decisions/", ".patterns/", ".glossary/", "docs/"] as const;

/**
 * A surface-bearing path: a dependency manifest, a lockfile, a migration, a schema,
 * or build/stack config. Any change here is a new-surface change (ADR 0120 §1 bound 2)
 * and is never trivial, independent of line count. Matched by basename or path shape so
 * it is robust to where in the tree the file lives.
 */
const isSurfacePath = (path: string): boolean => {
	const base = path.slice(path.lastIndexOf("/") + 1);
	if (
		base === "package.json" ||
		base === "package-lock.json" ||
		base === "pnpm-lock.yaml" ||
		base === "pnpm-workspace.yaml" ||
		base === "yarn.lock" ||
		base === "bun.lockb" ||
		base === "alchemy.run.ts" ||
		/^tsconfig.*\.json$/.test(base) ||
		/^biome\.jsonc?$/.test(base) ||
		/^wrangler\./.test(base) ||
		base === ".env" ||
		base.startsWith(".env.")
	) {
		return true;
	}
	if (path.endsWith(".sql")) return true;
	return /(^|\/)(migrations|drizzle)\//.test(path);
};

/** True for a doc/comment-only file: a doc extension or a path under a docs dir. */
const isDocPath = (path: string): boolean => {
	if (DOC_EXTENSIONS.some((ext) => path.endsWith(ext))) return true;
	return DOC_DIR_PREFIXES.some((dir) => path === dir || path.startsWith(dir));
};

/**
 * A new module edge in an added line: a new `export` (new public surface) or a new
 * `import` / `require(` (a new dependency edge). These are the mechanical, unambiguous
 * new-surface markers (ADR 0120 §1 bound 2); routes/bindings/config-keys/schemas are
 * caught by `isSurfacePath` or arrive as one of these edges. Anything else flows
 * through the single-file ≤ N bound — and the whole lever is measurement-gated (ADR
 * 0112) before adoption, so the conservative scope here is deliberate, never a gap.
 */
const NEW_SURFACE_LINE = /^\s*export\b|^\s*import\b|\bimport\s*\(|\brequire\s*\(/;
const hasNewSurfaceContent = (addedLines: ReadonlyArray<string>): boolean =>
	addedLines.some((line) => NEW_SURFACE_LINE.test(line));

/**
 * Parse a unified diff (`git diff` / GitHub patch text) into its per-file slices.
 *
 * Each file block opens with a `diff --git a/<old> b/<new>` header; the post-image
 * path is taken from that header (the `b/` side), falling back to the `a/` side for a
 * deletion (`b/dev/null`). Content lines (`+`/`-`, not the `+++`/`---` headers) are
 * counted and the added bodies collected. Returns `null` when the text contains no
 * `diff --git` header at all — an unparseable input the caller treats as fail-closed.
 */
export const parseUnifiedDiff = (diff: string): ReadonlyArray<ChangedFile> | null => {
	const lines = diff.split("\n");
	const files: ChangedFile[] = [];
	let cur: {path: string; additions: number; deletions: number; addedLines: string[]} | null = null;
	let sawHeader = false;

	const flush = () => {
		if (cur !== null) files.push(cur);
		cur = null;
	};

	for (const line of lines) {
		const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (header !== null) {
			flush();
			sawHeader = true;
			const oldPath = header[1] ?? "";
			const newPath = header[2] ?? "";
			const path = newPath === "dev/null" ? oldPath : newPath;
			cur = {path, additions: 0, deletions: 0, addedLines: []};
			continue;
		}
		if (cur === null) continue;
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) {
			cur.additions += 1;
			cur.addedLines.push(line.slice(1));
		} else if (line.startsWith("-")) {
			cur.deletions += 1;
		}
	}
	flush();
	return sawHeader ? files : null;
};

/**
 * Classify a unified diff as `trivial` or `non-trivial`. Fail-closed by construction:
 * every non-positive path returns `non-trivial`; `trivial` is reached only after the
 * full hard-AND of bounds clears. The order is deliberate — boundary first, so a
 * control-plane touch can never be masked by a later cheaper check.
 */
export const classify = (diff: string, opts: ClassifyOptions): Classification => {
	const files = parseUnifiedDiff(diff);
	if (files === null) {
		return nonTrivial("diff could not be parsed (no `diff --git` header) — default-deny.");
	}
	if (files.length === 0) {
		return nonTrivial("empty diff — no changed files; default-deny.");
	}

	// Bound 3 — not control-plane (the live boundary). An unreadable/empty boundary or
	// a regex that won't compile is fail-closed, mirroring the gates' CONTROL_PLANE_RE='.'.
	const re = opts.controlPlaneRe;
	if (re === null || re.trim() === "") {
		return nonTrivial("live CONTROL_PLANE_RE unreadable — fail-closed (ADR 0120 §3).");
	}
	let cp: RegExp;
	try {
		cp = new RegExp(re);
	} catch {
		return nonTrivial("live CONTROL_PLANE_RE failed to compile — fail-closed (ADR 0120 §3).");
	}
	const cpHit = files.find((f) => cp.test(f.path));
	if (cpHit !== undefined) {
		return nonTrivial(
			`control-plane path touched (${cpHit.path}) — never trivial (ADR 0120 §1.3).`,
		);
	}

	// Bound 1 (part) — single-concern: more than one changed file is never trivial.
	if (files.length > 1) {
		return nonTrivial(
			`multi-file diff (${files.length} files) — only a single-file change is trivial.`,
		);
	}

	const f = files[0];
	if (f === undefined) {
		return nonTrivial("no changed file resolved — default-deny.");
	}

	// Bound 2 — no new surface / code-path change.
	if (isSurfacePath(f.path)) {
		return nonTrivial(
			`surface-bearing path (${f.path}: dependency/manifest/migration/schema/config) — not trivial (ADR 0120 §1.2).`,
		);
	}
	if (hasNewSurfaceContent(f.addedLines)) {
		return nonTrivial(
			`new module edge added (export/import/require) in ${f.path} — not trivial (ADR 0120 §1.2).`,
		);
	}

	// Bound 1 — small + single-concern. A doc/comment-only file is trivial at any size;
	// a single code file is trivial only under the line bound N.
	if (isDocPath(f.path)) {
		return trivial(`single doc/comment-only file (${f.path}) under the live boundary.`);
	}
	const changed = f.additions + f.deletions;
	if (changed <= opts.lineBudget) {
		return trivial(
			`single small file (${f.path}: ${changed} changed lines ≤ N=${opts.lineBudget}).`,
		);
	}
	return nonTrivial(
		`single file but ${changed} changed lines > N=${opts.lineBudget} — not trivial (ADR 0120 §1.1).`,
	);
};
