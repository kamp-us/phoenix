/**
 * Where `hook worktree-create` lays a tree when the session was launched below the repository root,
 * driven through the verb against real git.
 *
 * The committed golden payload carries a repository root in its `cwd`, so it passes whether the verb
 * trusts `cwd` or resolves the toplevel from it. This file is the discriminating case: a `cwd` that is
 * a subdirectory, whose planned tree must sit under the toplevel.
 */
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterAll, describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {UNPLANNABLE_WORKTREE} from "./codes.ts";
import {gitSync} from "./throwaway-clone.test-support.ts";
import {runWorktreeCreate} from "./worktree-create-verb.ts";

const NAME = "agent-subdir";

/** `realpath` because `git rev-parse --show-toplevel` resolves symlinks, and macOS's tmpdir is one. */
const root = realpathSync(mkdtempSync(join(tmpdir(), "fabrika-worktree-toplevel-")));
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

describe("hook worktree-create resolves the repository toplevel from the envelope's cwd", () => {
	it(
		"plans the tree under the toplevel when the session was launched in a subdirectory",
		async () => {
			const repo = join(root, "repo");
			const subdir = join(repo, "packages", "fabrika-cli");
			gitSync(undefined, "init", "--quiet", "-b", "main", repo);
			mkdirSync(subdir, {recursive: true});

			const out = await plan(subdir);

			expect(out.code).toBe(0);
			expect(out.stdout.trim()).toBe(`${repo}/.claude/worktrees/${NAME}`);
			expect(out.stdout).not.toContain(`${subdir}/.claude/`);
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
