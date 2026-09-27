/**
 * For a stack that comes up as a compose project, where two agents on one project name fight over
 * the same containers, volumes and published ports. Isolation declared: a worktree, a free port
 * written into `.env` as `APP_PORT` (which is what `docker-compose.yml` publishes on), and a
 * compose project named for the worktree — brought up in setup, and `down -v` in teardown.
 */

import {ClientId, claudeSession, WorkspaceId} from "@kampus/tuval-claude";
import type {TuvalConfigInput} from "@kampus/tuval-sdk/config";
import {worktree} from "@kampus/tuval-worktree";

const REPO = "/code/my-stack";

const scope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("tuval-desk"),
};

export const options = {
	repo: REPO,
	base: "origin/main",
	port: {from: 5170, to: 5199},
	// `docker compose` reads `.env` out of the project directory, so writing the port there is what
	// makes `ports: ["${APP_PORT}:3000"]` in the compose file land on a port nothing else holds.
	env: {template: ".env.example", portKey: "APP_PORT"},
	setup: ["docker compose -p $NAME up -d --wait"],
	teardown: ["docker compose -p $NAME down -v"],
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
