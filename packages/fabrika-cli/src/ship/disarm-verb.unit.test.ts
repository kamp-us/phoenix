import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, WRITE_UNKNOWN} from "./codes.ts";
import {runDisarm} from "./disarm-verb.ts";
import {ENV, pull, timeline} from "./fixtures.test-support.ts";
import {ADDED, REMOVED} from "./queue.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const TIMELINE = /^gh api -i repos\/o\/r\/issues\/4321\/timeline/;
const RULES = /^gh api repos\/o\/r\/rules\/branches\/main$/;
const DISABLE = /^gh pr merge 4321 --repo o\/r --disable-auto$/;

const options = {pr: 4321, site: "preflight", repo: null, json: false, env: ENV};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runDisarm({...options, ...overrides}), fakeShell(script).layer));

const noQueue = okOut(JSON.stringify([]));
const _withQueue = okOut(JSON.stringify([{type: "merge_queue"}]));

describe("runDisarm", () => {
	it("keeps a never-armed intent and says so", async () => {
		const out = await run([
			[PULL, pull()],
			[TIMELINE, timeline()],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("disarm\tkept\tpreflight\tnot-armed\n");
	});

	it("clears an armed intent and PROVES it from the re-read", async () => {
		const out = await run([
			[once(PULL), pull({autoMerge: true})],
			[TIMELINE, timeline()],
			[DISABLE, okOut("")],
			[PULL, pull({autoMerge: false})],
		]);
		expect(out.stdout).toBe("disarm\tdisarmed\tpreflight\tcleared\n");
	});

	it("never disturbs a live queue entry", async () => {
		const shell = fakeShell([
			[PULL, pull({autoMerge: true})],
			[TIMELINE, timeline({event: ADDED, at: "2026-08-08T10:00:00Z"})],
		]);
		const out = await Effect.runPromise(Effect.provide(runDisarm(options), shell.layer));
		expect(out.stdout).toBe("disarm\tkept\tpreflight\tlive-queued\n");
		expect(shell.calls.some((line) => line.includes("--disable-auto"))).toBe(false);
	});

	it("keeps the intent off a queue-less base at post-enqueue — there `--auto` IS the mechanism", async () => {
		const out = await run(
			[
				[PULL, pull({autoMerge: true})],
				[TIMELINE, timeline({event: REMOVED, at: "2026-08-08T10:00:00Z"})],
				[RULES, noQueue],
			],
			{site: "post-enqueue"},
		);
		expect(out.stdout).toBe("disarm\tkept\tpost-enqueue\tpre-queue-regime\n");
	});

	it("reads an UNREADABLE regime as queue-governed, so a failed read cannot grant the keep", async () => {
		const out = await run(
			[
				[once(PULL), pull({autoMerge: true})],
				[TIMELINE, timeline()],
				[RULES, errOut("gh: Bad gateway (HTTP 502)")],
				[DISABLE, okOut("")],
				[PULL, pull({autoMerge: false})],
			],
			{site: "post-enqueue"},
		);
		expect(out.stdout).toBe("disarm\tdisarmed\tpost-enqueue\tcleared\n");
	});

	it("answers `kept merged` for a merged PR rather than refusing — there is no 7 seat here", async () => {
		const out = await run([[PULL, pull({merged: true, state: "closed"})]], {site: "ejected"});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("disarm\tkept\tejected\tmerged\n");
	});

	it("refuses on 8 when the re-read cannot confirm the intent is clear", async () => {
		const out = await run([
			[PULL, pull({autoMerge: true})],
			[TIMELINE, timeline()],
			[DISABLE, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('report "merge intent: NOT cleared"');
	});

	it("refuses an unreadable merge state on 11 before any write is attempted", async () => {
		const shell = fakeShell([[PULL, errOut("gh: Bad gateway (HTTP 502)")]]);
		const out = await Effect.runPromise(Effect.provide(runDisarm(options), shell.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((line) => line.includes("--disable-auto"))).toBe(false);
	});

	it("refuses an off-vocabulary --site on 10", async () => {
		const out = await run([[PULL, pull()]], {site: "later"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"ship disarm: --site later is not a lifecycle site (preflight, refuse, post-enqueue, ejected).",
		);
	});
});
