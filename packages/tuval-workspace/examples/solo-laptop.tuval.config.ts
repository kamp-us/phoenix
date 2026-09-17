/**
 * For one person on one laptop who runs two agents at once and is tired of "port 5173 is in use".
 * Isolation declared: a worktree, a free port, and an `.env` copied from `.env.example` with `PORT`
 * rewritten to it. Nothing else — no database, no containers, no setup step.
 */

import {ClientId, claudeSession, type TuvalConfigInput, WorkspaceId} from "@kampus/tuval/sessions";
import {workspace} from "@kampus/tuval-workspace";

const REPO = "/code/my-app";

const scope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("tuval-desk"),
};

export const options = {
	repo: REPO,
	base: "origin/main",
	root: ".workspaces",
	port: {from: 5170, to: 5199},
	env: {template: ".env.example", portKey: "PORT"},
} as const;

export const workspaces = workspace({
	...options,
	job: claudeSession({cwd: REPO, scope}),
});

export default {
	version: 1,
	programs: [workspaces],
	graph: {nodes: [{id: "workspace", program: workspaces.id, on: []}]},
} satisfies TuvalConfigInput;
