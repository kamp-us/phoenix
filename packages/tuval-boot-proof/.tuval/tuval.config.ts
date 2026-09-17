/**
 * The epic's own proof (#9374, #9407), written as the thing it proves: a Tuval **global** config
 * that names all four `@kampus/tuval-*` programs by package name, and nothing else.
 *
 * It is the global layer on purpose. Boot reads two — the global one `--config` points at, and the
 * project's `<project>/.tuval/tuval.config.ts` — and merges the second over the first by row id. So
 * booting from `apps/tuval` with this file as the global layer registers the desk shell from
 * `apps/tuval/.tuval/tuval.config.ts`, untouched, and these four rows beside it. That is the whole
 * shape of the claim: four programs a user reaches by naming a package, with nothing in the app
 * knowing they exist and no `features.*` flag in the way. `README.md` has the command.
 *
 * Every import below is a bare package name. None of them is a path, which is the difference this
 * epic bought: before the move these four reached Tuval through a relative file specifier into a
 * sibling checkout — a path that resolved on exactly one laptop.
 *
 * **Nothing here spends a token or touches a repository.** The rows are planned, so four processes
 * come up with the desk, but each one is a thing that waits: the cron for 03:00, the shell for a
 * prompt, the notifier for a message, the workspace for an `open`. `workspace` provisions on the
 * command and never at init (`packages/tuval-workspace/src/workspace.ts`, the `open` cell), which is
 * why it can be planned here at all.
 */

import {fileURLToPath} from "node:url";
import type {TuvalConfigInput} from "@kampus/tuval/sessions";
import {cron} from "@kampus/tuval-cron";
import {notify} from "@kampus/tuval-notify";
import {shell} from "@kampus/tuval-shell";
import {workspace} from "@kampus/tuval-workspace";

/** This checkout, read off this file's own location so the config carries no machine's path. */
const repo = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The shell row, and the one id in this file that is not a matter of taste. `shell({…})` defaults
 * its id to `"shell"`, and `apps/tuval/.tuval/tuval.config.ts` registers the **desk** shell under
 * that same id — so an unnamed row here is merged away by the project layer and the user gets no
 * error, only a program that is not there. Name it, and both exist.
 */
export const commands = shell({id: "commands", cwd: repo, timeoutMs: 2 * 60 * 1000});

/** Nightly, at 03:00 local: fetch every remote, and say on the tile how it went. */
export const nightlyFetch = cron({
	id: "nightly-fetch",
	schedule: "0 3 * * *",
	prompt: `git -C ${repo} fetch --all`,
	job: shell({cwd: repo, timeoutMs: 2 * 60 * 1000}),
});

/** The way off the desk. `stdout` because a proof that needs a phone is not a proof. */
export const desk = notify({id: "desk", target: {kind: "stdout"}});

/** A worktree per review, provisioned on `:reviews open` and never before it. */
export const reviews = workspace({
	id: "reviews",
	repo,
	root: `${repo}.reviews`,
	base: "origin/main",
	branchPrefix: "review/",
	env: false,
});

export default {
	version: 1,
	programs: [commands, nightlyFetch, desk, reviews],
	graph: {
		nodes: [
			{id: "commands", program: commands.id, on: []},
			{id: "nightly-fetch", program: nightlyFetch.id, on: []},
			{id: "desk", program: desk.id, on: []},
			{id: "reviews", program: reviews.id, on: []},
		],
	},
} satisfies TuvalConfigInput;
