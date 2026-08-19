/**
 * The canned payloads the `governance` verb tests script their spawner with.
 *
 * The PR shape, the binding script and the head/base constants are **re-exported from the `review`
 * group's fixtures** rather than copied: every verb here binds through the same `bindHead`, and two
 * hand-written copies are two chances for a test to prove a binding the other group does not make.
 * What is added below is only what this group reads that `review` does not — the `--name-status`
 * stream and the tree listing.
 */
import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {BASE, HEAD} from "../review/fixtures.test-support.ts";

export {
	BASE,
	BASE_TIP,
	binding,
	comments,
	HEAD,
	OLD_HEAD,
	PATHS_AT,
	paths,
	pull,
} from "../review/fixtures.test-support.ts";

const DIFF_FLAGS = "--no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/";

/** The bound status read: `git diff <flags> --name-status -z <base>...<head>`. */
export const STATUS_AT = (base: string = BASE, head: string = HEAD): RegExp =>
	new RegExp(`^git diff ${DIFF_FLAGS} --name-status -z ${base}\\.\\.\\.${head}$`);

/** `--name-status -z` output: a status field then a path field, both NUL-terminated. */
export const statuses = (...rows: ReadonlyArray<readonly [string, string]>): ExecResult =>
	okOut(rows.map(([status, path]) => `${status}\0${path}\0`).join(""));

/** The recursive tree read this group resolves a skill root and root presence from. */
export const TREE_AT = (sha: string = HEAD): RegExp =>
	new RegExp(`^git ls-tree -r --name-only -z ${sha}$`);

export const treeOf = (...paths: ReadonlyArray<string>): ExecResult =>
	okOut(paths.map((path) => `${path}\0`).join(""));

/** One file's bytes at a commit. */
export const SHOW_AT = (sha: string, path: string): RegExp =>
	new RegExp(`^git show ${sha}:${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** A tree that carries all four governance roots plus one install of this skill. */
export const FULL_TREE: ReadonlyArray<string> = [
	".decisions/0240-only-landed-adrs-may-be-cited.md",
	".claude/settings.json",
	".github/workflows/ci.yml",
	"claude-plugins/fabrika/skills/governance/SKILL.md",
	"claude-plugins/fabrika/skills/governance/contract.md",
	"src/cart.ts",
];

/** The resolved skill root `FULL_TREE` yields. */
export const SKILL_ROOT = "claude-plugins/fabrika/skills/governance/";

/** An epic child's two ends, and the commit `git merge-base` names for them (#6064). */
export const RANGE_BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f80910111213";
export const RANGE_TIP = "2b3c4d5e6f708192a3b4c5d6e7f8091011121314";
export const RANGE_MERGE_BASE = "3c4d5e6f708192a3b4c5d6e7f809101112131415";

/** The range's merge-base resolve: `git merge-base <base> <tip>`. */
export const MERGE_BASE_OF = (base: string = RANGE_BASE, tip: string = RANGE_TIP): RegExp =>
	new RegExp(`^git merge-base ${base} ${tip}$`);
