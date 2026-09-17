/**
 * The consumer path, as a file rather than as a claim: what a Tuval user writes in
 * `~/.tuval/tuval.config.ts` to get this package's scheduler on their desk. It is a fixture here —
 * `cron.unit.test.ts` imports it and reads the row back — so the three-line usage in the README is
 * checked by the test suite instead of being prose that drifts.
 *
 * Nothing in it boots a desk or spends a token: `claudeSession({…})` builds a *row*, and a row is
 * a record. The `claude` CLI is reached when a process spawns, which is the kernel's job and
 * happens on a real desk, never here.
 *
 * The default export is `satisfies TuvalConfigInput` — the encoded shape the loader decodes, which
 * `@kampus/tuval/sessions` publishes (#9250). A config written outside the repo is therefore
 * checked against the real config schema here rather than only when a desk boots it.
 */

import {ClientId, claudeSession, type TuvalConfigInput, WorkspaceId} from "@kampus/tuval/sessions";
import {cron} from "@kampus/tuval-cron";

/** One workspace, one client — the two branded ids `claudeSession` will not build a row without. */
const scope = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("tuval-desk"),
};

export const standup = cron({
	everyMs: 10 * 60 * 1000,
	prompt:
		"Using the gh CLI, summarize what changed on this repo in the last 24 hours. Five lines max.",
	job: claudeSession({cwd: "/tmp/tuval-cron-fixture", scope}),
});

/**
 * The second cron, and the only reason it is here: a config with two of them is where `id` earns
 * its place. Named, so it is its own program, its own graph node and its own `:evening-summary run`
 * — where an unnamed second row would collide with `standup` on all three.
 */
export const eveningSummary = cron({
	id: "evening-summary",
	schedule: "0 18 * * *",
	prompt: "What is still open on this repo? Three lines max.",
	job: claudeSession({cwd: "/tmp/tuval-cron-fixture", scope}),
});

export default {
	version: 1,
	programs: [standup, eveningSummary],
	graph: {
		nodes: [
			{id: "cron", program: standup.id, on: []},
			{id: "evening-summary", program: eveningSummary.id, on: []},
		],
	},
} satisfies TuvalConfigInput;
