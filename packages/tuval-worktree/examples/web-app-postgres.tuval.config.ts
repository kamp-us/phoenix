/**
 * For a web app with a local Postgres, where two agents sharing one database means one agent's
 * migration is the other's broken fixture. Isolation declared: a worktree, a free port, an `.env`
 * whose `PORT` *and* `DATABASE_URL` are rewritten per worktree, a scratch database created in
 * setup and dropped in teardown, and `pnpm install` + `pnpm db:migrate` before the agent starts.
 */

import {ClientId, claudeSession, WorkspaceId} from "@kampus/tuval-claude";
import type {TuvalConfigInput} from "@kampus/tuval-sdk/kernel/config";
import {worktree} from "@kampus/tuval-worktree";

const REPO = "/code/my-app";

const scope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("tuval-desk"),
};

export const options = {
	repo: REPO,
	base: "origin/main",
	port: {from: 5170, to: 5199},
	env: {
		template: ".env.example",
		portKey: "PORT",
		// `$NAME` is the worktree's name, resolved by this package before the file is written — so
		// `feature-x` gets `app_feature_x`'s neighbour `app_feature-x`, which is its own database.
		vars: {DATABASE_URL: "postgres://localhost:5432/app_$NAME"},
	},
	setup: ["createdb app_$NAME", "pnpm install", "pnpm db:migrate"],
	teardown: ["dropdb --if-exists app_$NAME"],
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
