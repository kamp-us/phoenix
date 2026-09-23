/**
 * For a flake-based repository, where the environment is already declared and an `.env` file would
 * be a second, worse copy of it. Isolation declared: a worktree, a free port, no env step at all
 * (`env: false`), and a dev shell warmed in setup so the agent's first command is not a ten-minute
 * download — plus a brief telling the session to run everything through `nix develop -c`.
 */

import {ClientId, claudeSession, WorkspaceId} from "@kampus/tuval-claude";
import {worktree} from "@kampus/tuval-worktree";
import type {TuvalConfigInput} from "@kampus-apps/tuval/sessions";

const REPO = "/code/my-flake";

const scope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("tuval-desk"),
};

export const options = {
	repo: REPO,
	base: "origin/main",
	port: {from: 5170, to: 5199},
	// The flake is the environment. There is no `.env.example` to copy and no port key to rewrite, so
	// the env step is declared away rather than pointed at a file that does not exist.
	env: false,
	setup: ["nix develop -c true"],
	brief:
		"Run every command through `nix develop -c <command>` — the dev shell is this repository's environment and nothing is on PATH without it. Your dev server's port is the one named above; pass it explicitly rather than taking a default.",
} as const;

export const worktrees = worktree({
	...options,
	job: claudeSession({cwd: REPO, scope}),
});

export default {
	version: 1,
	programs: [worktrees],
	graph: {nodes: [{id: "worktree", program: worktrees.id, on: []}]},
} satisfies TuvalConfigInput;
