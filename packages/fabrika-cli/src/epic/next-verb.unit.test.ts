import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {NO_RUN, UNNAMEABLE_STATE} from "./codes.ts";
import {
	ANCESTOR,
	BASE,
	BRANCH,
	COMMENTS,
	ENV,
	EPIC,
	GIT_DIRS,
	HEAD,
	LEDGER,
	ledgerOf,
	MINE,
	ON_LANE,
	PERM,
	PLAN,
	planFile,
	REV_PARSE,
	RUN,
	WRITE,
} from "./fixtures.test-support.ts";
import {runNext} from "./next-verb.ts";
import {runStatus} from "./status-verb.ts";

const RESOLVE = /^git rev-parse --verify --quiet [0-9a-f]+\^\{commit\}$/;

const WORLD: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, GIT_DIRS],
	[BRANCH, ON_LANE],
	[COMMENTS, MINE],
	[PERM, WRITE],
	[HEAD, okOut(`${BASE}\n`)],
	[RESOLVE, okOut(`${BASE}\n`)],
	[ANCESTOR, okOut("")],
];

const OPENED = {files: {[LEDGER]: ledgerOf({event: "run-opened"}), [PLAN]: planFile()}};

const layers = (script: ReadonlyArray<readonly [RegExp, ExecResult]>, files: FakeFsOptions) =>
	Layer.merge(fakeShell(script).layer, fakeFs(files).layer);

describe("runNext", () => {
	it("relays exactly one action off the ledger and the graph", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(runNext({number: EPIC, env: ENV}), layers(WORLD, OPENED)),
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			action: "dispatch-slice",
			slice: "C1",
			run: RUN,
		});
	});

	it("reads no GitHub beyond the lane guard's own claim proof", async () => {
		const shell = fakeShell(WORLD);
		await Effect.runPromise(
			Effect.provide(
				runNext({number: EPIC, env: ENV}),
				Layer.merge(shell.layer, fakeFs(OPENED).layer),
			),
		);
		const gh = shell.calls.filter((call) => call.startsWith("gh "));
		expect(gh.every((call) => call.includes("/comments") || call.includes("/permission"))).toBe(
			true,
		);
	});

	it("refuses a run with no ledger on 20, naming its repair", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(runNext({number: EPIC, env: ENV}), layers(WORLD, {files: {}})),
		);
		expect(outcome.code).toBe(NO_RUN);
		expect(outcome.stderr.at(-1)).toBe(
			`epic next: no run ledger for #${EPIC} in this lane — run "fabrika epic open ${EPIC}" first.`,
		);
	});

	it("refuses an off-enum event in the ledger on 21, quoting it and its seq", async () => {
		const broken = {
			files: {
				[LEDGER]: `{"seq":14,"at":"","event":"slice-skipped","slice":"C2","detail":null,"sha":null}\n`,
				[PLAN]: planFile(),
			},
		};
		const outcome = await Effect.runPromise(
			Effect.provide(runNext({number: EPIC, env: ENV}), layers(WORLD, broken)),
		);
		expect(outcome.code).toBe(UNNAMEABLE_STATE);
		expect(outcome.stderr.at(-1)).toContain('unnameable state (event "slice-skipped" at seq 14)');
		expect(outcome.stdout).toBe("");
	});
});

describe("runStatus", () => {
	it("folds the whole run, keeping each slice's two counters apart", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(runStatus({number: EPIC, env: ENV}), layers(WORLD, OPENED)),
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			run: RUN,
			epic: EPIC,
			branch: "build/4300-totals-rework-c1a4d6f8",
			slices: [
				{
					id: "C1",
					state: "pending",
					commit: null,
					verdict: "none",
					failAttempts: 0,
					deadAttempts: 0,
				},
				{
					id: "C2",
					state: "pending",
					commit: null,
					verdict: "none",
					failAttempts: 0,
					deadAttempts: 0,
				},
			],
			counters: {landed: 0, passed: 0, escalated: 0},
		});
	});

	it("refuses the same three ways `next` does — 20 and 21, never a partial fold", async () => {
		const missing = await Effect.runPromise(
			Effect.provide(runStatus({number: EPIC, env: ENV}), layers(WORLD, {files: {}})),
		);
		expect(missing.code).toBe(NO_RUN);
		const broken = await Effect.runPromise(
			Effect.provide(
				runStatus({number: EPIC, env: ENV}),
				layers(WORLD, {files: {[LEDGER]: "nope\n", [PLAN]: planFile()}}),
			),
		);
		expect(broken.code).toBe(UNNAMEABLE_STATE);
		expect(broken.stdout).toBe("");
	});
});
