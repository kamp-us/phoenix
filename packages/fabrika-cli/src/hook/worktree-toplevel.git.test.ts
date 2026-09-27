/**
 * Where `hook worktree-create` lays a tree for each place a session can be launched in one clone,
 * driven through the verb against real git.
 *
 * The committed golden payload carries a repository root in its `cwd`, so it passes whether the verb
 * trusts `cwd`, resolves its toplevel, or resolves the primary tree. The subdirectory and the
 * linked-tree cases are the discriminating ones: trusting `cwd` fails the first, and trusting
 * `--show-toplevel` fails the second.
 */
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {UNPLANNABLE_WORKTREE} from "./codes.ts";
import {gitSync} from "./throwaway-clone.test-support.ts";
import {runWorktreeCreate} from "./worktree-create-verb.ts";

const NAME = "agent-subdir";

/** `realpath` because git resolves symlinks in the paths it prints, and macOS's tmpdir is one. */
const root = realpathSync(mkdtempSync(join(tmpdir(), "fabrika-worktree-toplevel-")));
const repo = join(root, "repo");
const linked = join(repo, ".claude", "worktrees", "epic-9843");
const planned = `${repo}/.claude/worktrees/${NAME}`;

beforeAll(() => {
	gitSync(undefined, "init", "--quiet", "-b", "main", repo);
	gitSync(repo, "commit", "--quiet", "--allow-empty", "-m", "seed");
	gitSync(repo, "worktree", "add", "--quiet", "--detach", linked);
});
afterAll(() => rmSync(root, {recursive: true, force: true}));

const plan = (cwd: string) =>
	Effect.runPromise(
		Effect.provide(
			runWorktreeCreate({
				stdin: Effect.succeed<StdinRead>({
					_tag: "Text",
					text: JSON.stringify({
						session_id: "80f40b22-8788-40d0-ac1c-08ab808d6086",
						transcript_path: "/home/u/.claude/projects/repo/80f40b22.jsonl",
						cwd,
						hook_event_name: "WorktreeCreate",
						name: NAME,
					}),
				}),
				dryRun: true,
				env: {PATH: process.env.PATH, HOME: process.env.HOME},
				cli: null,
			}),
			NodeServices.layer,
		),
	);

describe("hook worktree-create plans every cwd of one clone under its primary working tree", () => {
	it(
		"plans the tree under the primary checkout when the session was launched at its root",
		async () => {
			const out = await plan(repo);

			expect(out.code).toBe(0);
			expect(out.stdout.trim()).toBe(planned);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"plans the tree under the primary checkout when the session was launched in a subdirectory",
		async () => {
			const subdir = join(repo, "packages", "fabrika-cli");
			mkdirSync(subdir, {recursive: true});

			const out = await plan(subdir);

			expect(out.code).toBe(0);
			expect(out.stdout.trim()).toBe(planned);
			expect(out.stdout).not.toContain(`${subdir}/.claude/`);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"plans the tree under the primary checkout, not beneath the linked tree the session is in",
		async () => {
			expect(gitSync(linked, "rev-parse", "--show-toplevel").trim()).toBe(linked);

			const out = await plan(linked);

			expect(out.code).toBe(0);
			expect(out.stdout.trim()).toBe(planned);
			expect(out.stdout).not.toContain(`${linked}/.claude/`);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"refuses a linked tree of a bare clone, which has no primary tree to hold the base",
		async () => {
			const bare = join(root, "bare.git");
			const tree = join(root, "bare-tree");
			gitSync(undefined, "clone", "--quiet", "--bare", repo, bare);
			gitSync(bare, "worktree", "add", "--quiet", "--detach", tree);

			const out = await plan(tree);

			expect(out.code).toBe(UNPLANNABLE_WORKTREE);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toBe(
				`fabrika hook worktree-create: \`cwd\` belongs to a clone whose primary working tree cannot be established: ${tree}`,
			);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"refuses a cwd in no repository, naming it, rather than falling back to it",
		async () => {
			const outside = join(root, "not-a-repo");
			mkdirSync(outside, {recursive: true});

			const out = await plan(outside);

			expect(out.code).toBe(UNPLANNABLE_WORKTREE);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toBe(
				`fabrika hook worktree-create: \`cwd\` resolves to no repository toplevel: ${outside}`,
			);
		},
		SUBPROCESS_TEST_TIMEOUT_MS,
	);
});
