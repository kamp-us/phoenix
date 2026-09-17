/**
 * For a stack that comes up as a compose project, where two agents on one project name fight over
 * the same containers, volumes and published ports. Isolation declared: a worktree, a free port
 * written into `.env` as `APP_PORT` (which is what `docker-compose.yml` publishes on), and a
 * compose project named for the workspace — brought up in setup, and `down -v` in teardown.
 */

import {ClientId, claudeSession, type TuvalConfigInput, WorkspaceId} from "@kampus/tuval/sessions";
import {workspace} from "@kampus/tuval-workspace";

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

export const workspaces = workspace({
	...options,
	job: claudeSession({cwd: REPO, scope}),
});

export default {
	version: 1,
	programs: [workspaces],
	graph: {nodes: [{id: "workspace", program: workspaces.id, on: []}]},
} satisfies TuvalConfigInput;
