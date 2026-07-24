// Worktree-aware biome runner for the root `lint:worktree` / `format:worktree` scripts.
//
// Why this exists: `biome.jsonc` excludes `!**/.claude/worktrees` so the PRIMARY
// checkout never descends into nested agent worktrees (#119). But an agent worktree
// IS `.claude/worktrees/<id>/`, so a bare `biome check .` run from inside one
// resolves its scan root to a path *under* that exclude and checks 0 files —
// silently for `lint`, and loud-but-misleading (`Checked 0 files`, exit 1) for
// `format` (#3777). The escape is to hand biome EXPLICIT changed-file paths, which
// it matches relative to the biome root and so never trips the exclude — while the
// primary-checkout protection (#119) stays intact because we only ever take this
// path from inside a worktree.
//
// The load-bearing invariant (#3777): a check that examined zero files must never
// present as success when the changed set could not be determined. We derive the
// set from a diff against `origin/main`; if that baseline can't be resolved we FAIL
// LOUD rather than skip green (the prior `|| true` swallowed exactly this). A
// genuinely-empty changed set with a resolvable baseline is the one legitimate
// zero-file pass.
//
// Runs from a pnpm script, so `node_modules/.bin` is already on PATH — Node
// builtins + the local `biome` binary only.

import {spawnSync} from "node:child_process";

const mode = process.argv[2]; // "check" | "write"
if (mode !== "check" && mode !== "write") {
	console.error(`biome-worktree: expected mode "check" or "write", got ${JSON.stringify(mode)}`);
	process.exit(2);
}

const BIOME_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css|graphql)$/;

function git(args) {
	return spawnSync("git", args, {encoding: "utf8"});
}

// The changed set is a diff against origin/main, so an unresolvable baseline means
// we cannot know what changed — that is the fail-loud case, never a clean skip.
const baseline = git(["rev-parse", "--verify", "--quiet", "origin/main"]);
if (baseline.status !== 0) {
	console.error(
		"biome-worktree: cannot resolve `origin/main` — the changed-file baseline is unavailable, " +
			"so this worktree's changes could NOT be checked. Refusing to exit success on an " +
			"undetermined change set (#3777).",
	);
	console.error(
		"  Fix: fetch the base ref into this worktree, e.g. `git fetch origin main:refs/remotes/origin/main`, then re-run.",
	);
	process.exit(1);
}

const tracked = git(["diff", "--name-only", "--diff-filter=ACMR", "origin/main"]);
const untracked = git(["ls-files", "--others", "--exclude-standard"]);
// A failing git invocation here is the same "cannot determine the set" hazard as an
// unresolvable baseline — fail loud rather than proceed on a partial/empty list.
if (tracked.status !== 0 || untracked.status !== 0) {
	console.error(
		"biome-worktree: `git diff`/`git ls-files` failed — could not compute the changed set. " +
			"Refusing to exit success on an undetermined change set (#3777).",
	);
	console.error((tracked.stderr || "") + (untracked.stderr || ""));
	process.exit(1);
}

const files = [...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")]
	.map((f) => f.trim())
	.filter((f) => f && !f.startsWith("node_modules/") && BIOME_EXT.test(f))
	.filter((f, i, a) => a.indexOf(f) === i);

if (files.length === 0) {
	// Baseline resolved and the diff succeeded: a truly empty biome-handled change
	// set is the one legitimate zero-file pass.
	console.log(
		`biome-worktree (${mode}): no biome-handled changed files vs origin/main — nothing to do.`,
	);
	process.exit(0);
}

const args = ["check", "--files-ignore-unknown=true"];
if (mode === "write") args.push("--write");
args.push(...files);

const biome = spawnSync("biome", args, {stdio: "inherit"});
if (biome.error) {
	console.error(`biome-worktree: failed to spawn biome — ${biome.error.message}`);
	process.exit(1);
}
process.exit(biome.status ?? 1);
