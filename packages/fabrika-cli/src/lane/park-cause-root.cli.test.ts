/**
 * `lane transition` run from a real linked worktree, with the two checkouts declaring opposite
 * `parkCause.uncaused`.
 *
 * The unit tier proves the composition — `configRootOrRefuse` then `readKey` — but not that the
 * adapter wires it, and the adapter is where the straddle lived: the lanes root derived off the
 * owning repository while the rule was read at `process.cwd()`. So this tier runs the real process
 * with a real `.git` pointer under it and reads the exit code, which is the only thing that can tell
 * which file governed the park.
 *
 * The refusal it turns on sits ahead of every board read (`transition-verb.ts`), so the run stays
 * offline at both polarities.
 */
import {execFile} from "node:child_process";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {PARK_UNCAUSED} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const exec = promisify(execFile);

const STRICT = '{"parkCause": {"uncaused": "refuse"}}';
const PERMISSIVE = '{"parkCause": {"uncaused": "record"}}';

/**
 * A primary checkout holding the lane, and a linked worktree pointing at it through the same
 * `.git` file plus `commondir` pair git writes — the layout `deriveRepoRoot` reads.
 */
const checkouts = (primary: string, worktree: string): {primary: string; worktree: string} => {
	const base = mkdtempSync(join(tmpdir(), "park-cause-root-"));
	const owner = join(base, "primary");
	const linked = join(base, "wt");
	const bookkeeping = join(owner, ".git", "worktrees", "wt");
	mkdirSync(bookkeeping, {recursive: true});
	mkdirSync(join(owner, ".fabrika", "lanes", "42"), {recursive: true});
	mkdirSync(linked, {recursive: true});
	writeFileSync(join(bookkeeping, "commondir"), "../..\n");
	writeFileSync(join(linked, ".git"), `gitdir: ${bookkeeping}\n`);
	writeFileSync(join(owner, ".fabrika.jsonc"), primary);
	writeFileSync(join(linked, ".fabrika.jsonc"), worktree);
	writeFileSync(join(owner, ".fabrika", "lanes", "42", "workflow.json"), coderTemplateText());
	return {primary: owner, worktree: linked};
};

/** A cause-less `BLOCKED` on the primary's ledger, typed from the worktree. */
const parkFrom = async (primary: string, worktree: string): Promise<number> => {
	const trees = checkouts(primary, worktree);
	try {
		await exec(
			process.execPath,
			[
				"--experimental-strip-types",
				BIN,
				"lane",
				"transition",
				"42",
				"BLOCKED",
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

describe("a park typed from a linked worktree", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("is refused where the OWNING checkout declares refuse, though the worktree declares record", async () => {
		expect(await parkFrom(STRICT, PERMISSIVE)).toBe(PARK_UNCAUSED);
	});

	it("is not refused where the owning checkout declares record, though the worktree declares refuse", async () => {
		expect(await parkFrom(PERMISSIVE, STRICT)).not.toBe(PARK_UNCAUSED);
	});
});
