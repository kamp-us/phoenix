/**
 * For one person on one laptop who runs two agents at once and is tired of "port 5173 is in use".
 * Isolation declared: a worktree, a free port, and an `.env` copied from `.env.example` with `PORT`
 * rewritten to it. Nothing else — no database, no containers, no setup step.
 */

import {worktree} from "@kampus/tuval-worktree";
import {
	ClientId,
	claudeSession,
	type TuvalConfigInput,
	WorkspaceId,
} from "@kampus-apps/tuval/sessions";

const REPO = "/code/my-app";

const scope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("tuval-desk"),
};

export const options = {
	repo: REPO,
	base: "origin/main",
	root: ".worktrees",
	port: {from: 5170, to: 5199},
	env: {template: ".env.example", portKey: "PORT"},
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
