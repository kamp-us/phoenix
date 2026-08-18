/**
 * The canned GitHub payloads the `review` verb tests script their spawner with.
 *
 * They live in one module because every verb in the group reads the same PR shape, and a per-test
 * literal is how two tests come to disagree about what the platform returns.
 */
import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";

export const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
export const OLD_HEAD = "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192";
/** The commit this branch left the base branch at — every bound range's other end. */
export const BASE = "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736";
/**
 * Where `origin/main` is *now*: a commit ahead of {@link BASE}, never equal to it.
 *
 * The two are kept distinct on purpose. A fixture where the branch tip and the merge base are the
 * same commit cannot tell a verb that reports the tip from one that reports the branch point — which
 * is the whole of #5770. Every test that binds a head therefore runs against a moved main.
 */
export const BASE_TIP = "5a4b3c2d1e0f98877665544332211000ffeeddcc";

export interface PullShape {
	readonly state?: string;
	readonly head?: string;
	readonly baseRef?: string;
	readonly body?: string;
	readonly changedFiles?: number;
	readonly comments?: number;
}

export const pull = (shape: PullShape = {}): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4321,
			state: shape.state ?? "open",
			head: {sha: shape.head ?? HEAD},
			base: {ref: shape.baseRef ?? "main"},
			body: shape.body ?? "does a thing\n\nFixes #4287\n\n## Deviations\n\nNone.\n",
			changed_files: shape.changedFiles ?? 2,
			comments: shape.comments ?? 0,
		}),
	);

const DIFF_FLAGS = "--no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/";

const range = (base: string, head: string, extra = "", trailing = ""): RegExp =>
	new RegExp(`^git diff ${DIFF_FLAGS}${extra} ${base}\\.\\.\\.${head}${trailing}$`);

/** The bound diff read: `git diff <base>...<head>` under the config-proof flags. */
export const DIFF_AT = (base: string = BASE, head: string = HEAD): RegExp => range(base, head);

/** The bound path read: the same range, `--name-only -z`. */
export const PATHS_AT = (base: string = BASE, head: string = HEAD): RegExp =>
	range(base, head, " --name-only -z");

/** `git diff --name-only -z` output: NUL-separated paths. */
export const paths = (...names: ReadonlyArray<string>): ExecResult =>
	okOut(names.map((n) => `${n}\0`).join(""));

/** The bound `--raw` read the content binding digests (ADR 0276). */
export const RAW_AT = (base: string = BASE, head: string = HEAD): RegExp =>
	range(base, head, " --raw --abbrev=40 -z");

/** The same read limited to the paths a range verdict judged — the re-derivation read (#5825). */
export const RAW_ONTO = (base: string, state: string, ...judged: ReadonlyArray<string>): RegExp =>
	range(base, state, " --raw --abbrev=40 -z", ` -- ${judged.join(" ")}`);

/** One `--raw -z` stream over the same two paths {@link DIFF} carries. */
export const RAW = [
	`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0src/cart.ts\0`,
	`:100644 100644 ${"c".repeat(40)} ${"d".repeat(40)} M\0README.md\0`,
].join("");

/**
 * The digest {@link RAW} produces, asserted as a literal.
 *
 * Written out rather than recomputed from `contentDigest` in the tests that use it: a fixture that
 * calls the code under test agrees with it by construction, so it could never catch the
 * serialization changing under a verdict that already bound the old one.
 */
export const CONTENT = "7af166f42fdb";

/**
 * Every command `bindHead` issues, scripted green — remote lookup, the `pull/<pr>/head` fetch, the
 * object-database resolve of the head, the base branch's fetch-then-resolve, and the merge base of
 * that tip and the head.
 *
 * One helper because both read verbs bind identically: two hand-written copies are two chances for a
 * test to prove a binding the other verb does not make. `tip` defaults ahead of `base`, so every
 * caller of this helper is bound under a moved main (#5770).
 */
export const binding = (
	sha: string = HEAD,
	base: string = BASE,
	tip: string = BASE_TIP,
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[
		/^git remote -v$/,
		okOut("origin\tgit@github.com:o/r.git (fetch)\norigin\tgit@github.com:o/r.git (push)\n"),
	],
	[/^git fetch --quiet origin pull\/4321\/head$/, okOut("")],
	[new RegExp(`^git rev-parse --verify --quiet ${sha}\\^\\{commit\\}$`), okOut(`${sha}\n`)],
	[/^git remote$/, okOut("origin\n")],
	[/^git fetch --quiet origin main$/, okOut("")],
	[/^git rev-parse --verify --quiet origin\/main\^\{commit\}$/, okOut(`${tip}\n`)],
	[new RegExp(`^git merge-base ${tip} ${sha}$`), okOut(`${base}\n`)],
	// The content binding's own read, in the binding script because every verb that binds a head then
	// digests that same range (ADR 0276); a per-test copy is how two tests come to digest differently.
	[RAW_AT(base, sha), okOut(RAW)],
];

export const files = (...names: ReadonlyArray<string>): ExecResult =>
	okOut(JSON.stringify(names.map((filename) => ({filename}))));

export const checkRuns = (
	declared: number,
	runs: ReadonlyArray<{name: string; status: string; conclusion: string | null}>,
): ExecResult => okOut(JSON.stringify({total_count: declared, check_runs: runs}));

export const comments = (
	...rows: ReadonlyArray<{id: number; body: string; author?: string; createdAt?: string}>
): ExecResult =>
	okOut(
		JSON.stringify(
			rows.map((row) => ({
				id: row.id,
				user: {login: row.author ?? "kampus-bot"},
				created_at: row.createdAt ?? "2026-08-08T00:00:00Z",
				body: row.body,
			})),
		),
	);

/** A two-file unified diff whose header count matches `pull()`'s declared `changed_files`. */
export const DIFF = `diff --git a/src/cart.ts b/src/cart.ts
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -10,2 +10,3 @@
 const items = read();
+const extra = 1;
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # phoenix
+a line
`;

export const ISSUE_BODY = `Build the thing.

### Acceptance criteria

- [ ] the first retry delay equals \`base\`
- [x] the retry guide documents the delay table
`;

export const issue = (body: string = ISSUE_BODY, state = "open"): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4287,
			title: "t",
			body,
			state,
			labels: [],
			html_url: "https://example.test/issues/4287",
			milestone: null,
		}),
	);
