/**
 * `recipe unpark` run from a real linked worktree, with the two checkouts declaring opposite
 * `parkCause.driverRouted`.
 *
 * The straddle lived in the adapter, not the verb: the lanes root was derived off the owning
 * repository while the rule governing the clear was read at `process.cwd()`. A unit test over the
 * verb cannot see that, because the verb is handed a `parkCause` already read. So this tier runs the
 * real process with a real `.git` pointer under it and reads the exit code, which is the only thing
 * that can say which file governed the clear.
 *
 * The park it stands on is `head-behind-base` — routed `driver`, covered by no recipe row — and the
 * run names no `--rationale`, so both polarities refuse ahead of every board read and the run stays
 * offline: `23` where the clearing arm is open, `12` where it is not.
 */
import {execFile} from "node:child_process";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {PARK_NOVEL, RATIONALE_ABSENT} from "./codes.ts";
import {LANE, laneTemplate, parkedBlockedOn} from "./fixtures.test-support.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const exec = promisify(execFile);

const CLEARS = '{"parkCause": {"driverRouted": "clear"}}';
const REFUSES = '{"parkCause": {"driverRouted": "refuse"}}';

/**
 * A primary checkout holding the parked lane, and a linked worktree pointing at it through the same
 * `.git` file plus `commondir` pair git writes — the layout `deriveRepoRoot` reads.
 */
const checkouts = (primary: string, worktree: string): {primary: string; worktree: string} => {
	const base = mkdtempSync(join(tmpdir(), "recipe-park-cause-root-"));
	const owner = join(base, "primary");
	const linked = join(base, "wt");
	const bookkeeping = join(owner, ".git", "worktrees", "wt");
	const lane = join(owner, ".fabrika", "lanes", LANE);
	mkdirSync(bookkeeping, {recursive: true});
	mkdirSync(lane, {recursive: true});
	mkdirSync(linked, {recursive: true});
	writeFileSync(join(bookkeeping, "commondir"), "../..\n");
	writeFileSync(join(linked, ".git"), `gitdir: ${bookkeeping}\n`);
	writeFileSync(join(owner, ".fabrika.jsonc"), primary);
	writeFileSync(join(linked, ".fabrika.jsonc"), worktree);
	writeFileSync(join(lane, "workflow.json"), laneTemplate());
	writeFileSync(join(lane, "events.jsonl"), parkedBlockedOn("head-behind-base"));
	return {primary: owner, worktree: linked};
};

/** A rationale-less clear of the primary's lane, typed from the worktree. */
const unparkFrom = async (primary: string, worktree: string): Promise<number> => {
	const trees = checkouts(primary, worktree);
	try {
		await exec(
			process.execPath,
			[
				"--experimental-strip-types",
				BIN,
				"recipe",
				"unpark",
				LANE,
				"--root",
				join(trees.primary, ".fabrika", "lanes"),
			],
			{cwd: trees.worktree, env: process.env},
		);
		return 0;
	} catch (err) {
		return (err as {code?: number}).code ?? -1;
	}
};

describe("a driver-routed clear typed from a linked worktree", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("takes the driver arm the OWNING checkout opened, though the worktree declares refuse", async () => {
		expect(await unparkFrom(CLEARS, REFUSES)).toBe(RATIONALE_ABSENT);
	});

	it("refuses where the owning checkout declares refuse, though the worktree declares clear", async () => {
		expect(await unparkFrom(REFUSES, CLEARS)).toBe(PARK_NOVEL);
	});
});
