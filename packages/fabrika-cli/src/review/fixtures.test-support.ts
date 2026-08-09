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

export interface PullShape {
	readonly state?: string;
	readonly head?: string;
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
			body: shape.body ?? "does a thing\n\nFixes #4287\n\n## Deviations\n\nNone.\n",
			changed_files: shape.changedFiles ?? 2,
			comments: shape.comments ?? 0,
		}),
	);

export const files = (...names: ReadonlyArray<string>): ExecResult =>
	okOut(JSON.stringify(names.map((filename) => ({filename}))));

export const checkRuns = (
	declared: number,
	runs: ReadonlyArray<{name: string; status: string; conclusion: string | null}>,
): ExecResult => okOut(JSON.stringify({total_count: declared, check_runs: runs}));

export const comments = (
	...rows: ReadonlyArray<{id: number; body: string; author?: string}>
): ExecResult =>
	okOut(
		JSON.stringify(
			rows.map((row) => ({
				id: row.id,
				user: {login: row.author ?? "kampus-bot"},
				created_at: "2026-08-08T00:00:00Z",
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
