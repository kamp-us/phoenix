/**
 * A reload moves running processes onto the new code and keeps their state (#9820). Proved in a real
 * `node` child (`./hot-swap.probe.ts`): Vitest imports modules through its own runner, so an edit to
 * a file the config imports by path only reaches a reload in a plain `node` process.
 */

import {spawnSync} from "node:child_process";
import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {afterEach, describe, expect, it} from "vitest";
import {describeSwaps, type ReloadReport} from "./reload.ts";

const probe = fileURLToPath(new URL("./hot-swap.probe.ts", import.meta.url));

/** One real `node` child booting a desk off TypeScript source; vitest's 5 s default does not cover it. */
const SPAWN_MS = 30_000;

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const freshDir = (prefix: string): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
};

const runProbe = () => {
	const result = spawnSync(
		process.execPath,
		[probe, freshDir("tuval-hot-swap-"), freshDir("tuval-hot-swap-home-")],
		{encoding: "utf8"},
	);
	expect(result.status, result.stderr).toBe(0);
	const last = result.stdout.trim().split("\n").at(-1) ?? "";
	return JSON.parse(last);
};

describe("a reload over running processes", () => {
	it(
		"switches an edited program's process to its new code, keeping its state and id",
		() => {
			const seen = runProbe();

			expect(seen.before.tally).toEqual({version: "1.0.0", count: 2, by: "v1"});
			// The edit makes a bump add ten and stamp v2: the state from before is still there, under
			// the same process id, and the next bump runs the edited `update`.
			expect(seen.edited).toEqual({switched: ["tally"], restoreRefused: [], pending: []});
			expect(seen.afterEdit).toEqual({
				tally: {version: "1.0.0", count: 2, by: "v1"},
				handle: "tally",
			});
			expect(seen.bumped).toEqual({version: "1.0.0", count: 12, by: "v2"});

			// A refused reload switches nothing: the process still runs the code it had.
			expect(seen.broken.refused).toContain("tally");
			expect(seen.afterBroken).toEqual({version: "1.0.0", count: 22, by: "v2"});

			// A version bump no migration reaches: the program's own refused-restore state, holding the
			// state it could not read, and named by the report the desk logs.
			expect(seen.bumpedVersion).toEqual({switched: [], restoreRefused: ["tally"], pending: []});
			expect(seen.afterVersion).toEqual({refused: {version: "1.0.0", count: 22, by: "v2"}});

			// A reload with no file edited switches nothing (#9822).
			expect(seen.echoBefore).toEqual({said: "HI!", restoredBy: "restore-v1"});
			expect(seen.unedited).toEqual({switched: [], restoreRefused: [], pending: []});

			// An edit confined to `restore`, the helper echo's `init` calls, switches echo and only
			// echo: the switch ran the edited `restore` over the state it kept.
			expect(seen.restoreEdited).toEqual({switched: ["echo"], restoreRefused: [], pending: []});
			expect(seen.afterRestoreEdit).toEqual({said: "HI!", restoredBy: "restore-v2"});

			// So does an edit confined to a file echo's program file imports.
			expect(seen.shoutEdited).toEqual({switched: ["echo"], restoreRefused: [], pending: []});
			expect(seen.afterShoutEdit).toEqual({said: "AGAIN?", restoredBy: "restore-v2"});

			// The program nobody edited was never closed: its `init` ran once, and its state stands.
			expect(seen.steady).toEqual({boots: 1, seen: 1});
		},
		SPAWN_MS,
	);
});

describe("describeSwaps", () => {
	const report = (moved: Partial<ReloadReport>): ReloadReport => ({
		sources: [],
		files: [],
		spellCount: 0,
		bindingCount: 0,
		bindingErrors: [],
		notified: 0,
		switched: [],
		restoreRefused: [],
		pending: [],
		...moved,
	});

	it("names the processes each outcome moved, and says nothing when none moved", () => {
		expect(describeSwaps(report({}))).toBe("");
		expect(
			describeSwaps(
				report({
					switched: [ProcessId.make("log"), ProcessId.make("counter")],
					restoreRefused: [ProcessId.make("tally")],
					pending: [ProcessId.make("shell")],
				}),
			),
		).toBe(
			", switched: log counter, restore refused: tally, switching once its own key is handled: shell",
		);
	});
});
