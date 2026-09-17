/**
 * For running two fabrika builders on one machine, where a lane is an issue number and each builder
 * needs its own checkout or they rebase on top of each other. Isolation declared: a worktree per
 * lane named for the issue, branch `build/<issue>` cut from `origin/main`, a free port, an `.env`
 * from the template, and a frozen install before the builder starts.
 */

import {ClientId, claudeSession, type TuvalConfigInput, WorkspaceId} from "@kampus/tuval/sessions";
import {workspace} from "@kampus/tuval-workspace";

const REPO = "/code/phoenix";

const scope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("tuval-desk"),
};

export const options = {
	id: "lane",
	repo: REPO,
	base: "origin/main",
	root: ".lanes",
	// `:lane open 9287` puts the worktree on `build/9287`, which is the branch name the pipeline's
	// own tooling already expects — so the lane is addressable by its issue number end to end.
	branchPrefix: "build/",
	port: {from: 5170, to: 5199},
	env: {template: ".env.example", portKey: "PORT"},
	setup: ["pnpm install --frozen-lockfile"],
	brief: "You are a fabrika builder. Work the issue this lane is named for.",
} as const;

export const lanes = workspace({
	...options,
	job: claudeSession({cwd: REPO, scope}),
});

export default {
	version: 1,
	programs: [lanes],
	graph: {nodes: [{id: "lane", program: lanes.id, on: []}]},
} satisfies TuvalConfigInput;
