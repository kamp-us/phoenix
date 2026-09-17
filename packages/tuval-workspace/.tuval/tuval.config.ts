/**
 * The consumer path, as a file rather than as a claim: what a Tuval user writes in
 * `~/.tuval/tuval.config.ts` to get this package's isolation program on their desk. It is a fixture
 * here — `workspace.unit.test.ts` imports it and reads the row back — so the usage in the README is
 * checked by the test suite instead of being prose that drifts.
 *
 * Nothing in it boots a desk or spends a token, and nothing in it touches git: `claudeSession({…})`
 * builds a *row*, and a row is a record; the `runner` below is a fake, because a config that is
 * loaded by a test suite must not be able to provision anything.
 *
 * The default export is `satisfies TuvalConfigInput` — the encoded shape the loader decodes, which
 * `@kampus/tuval/sessions` publishes. A config written outside the repo is therefore checked
 * against the real config schema here rather than only when a desk boots it.
 */

import {ClientId, claudeSession, type TuvalConfigInput, WorkspaceId} from "@kampus/tuval/sessions";
import {type Runner, workspace} from "@kampus/tuval-workspace";

/** One workspace, one client — the two branded ids `claudeSession` will not build a row without. */
const scope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("tuval-desk"),
};

/**
 * The machine, refused. A real config omits this and gets `nodeRunner()`; this one is loaded by a
 * test process, so every method answers without doing anything and nothing here can provision.
 */
const inert: Runner = {
	exec: async () => ({ok: false, output: "fixture runner: nothing is run"}),
	portFree: async () => false,
	readFile: async () => null,
	writeFile: async () => ({
		ok: false,
		detail: "fixture runner: nothing is written",
	}),
	exists: async () => false,
};

export const desk = workspace({
	repo: "/tmp/tuval-workspace-fixture",
	base: "origin/main",
	port: {from: 5170, to: 5199},
	env: {template: ".env.example", portKey: "PORT"},
	setup: ["pnpm install --frozen-lockfile"],
	teardown: [],
	runner: inert,
	job: claudeSession({cwd: "/tmp/tuval-workspace-fixture", scope}),
});

/**
 * The second row, and the only reason it is here: a config with two of them is where `id` earns its
 * place. Named, so it is its own program, its own graph node and its own `:reviews open` — where an
 * unnamed second row would collide with `desk` on all three. It fills no `job`, which is the other
 * half of the surface: a workspace program that only provisions.
 */
export const reviews = workspace({
	id: "reviews",
	repo: "/tmp/tuval-workspace-fixture",
	root: "/tmp/tuval-workspace-fixture/.reviews",
	branchPrefix: "review/",
	env: false,
	runner: inert,
});

export default {
	version: 1,
	programs: [desk, reviews],
	graph: {
		nodes: [
			{id: "workspace", program: desk.id, on: []},
			{id: "reviews", program: reviews.id, on: []},
		],
	},
} satisfies TuvalConfigInput;
