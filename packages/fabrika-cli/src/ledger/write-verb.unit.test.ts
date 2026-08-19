import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS} from "../build/fixtures.test-support.ts";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	EPIC_MOVED,
	NOT_STAGED,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	REGION_UNRESOLVABLE,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {CLAIMED, DIR, env, epic, TOKEN} from "./fixtures.test-support.ts";
import {planPath, renderRunRecord, runJsonPath, topologyPath} from "./run.ts";
import {runWrite} from "./write-verb.ts";

const EPIC_READ = /^gh api repos\/o\/r\/issues\/4300$/;
const PATCH = /^gh api --method PATCH repos\/o\/r\/issues\/4300/;

const BODY = "An epic brief about the moderation queue.\n";
const DIGEST = bodyDigest(BODY);
const PLAN = "## Plan (plan-epic)\n\n### Summary\n\nA plan.\n";
const TOPOLOGY = "## Dependencies\n\n- phase 1: #4301\n";
const SPLICED = `${BODY.trimEnd()}\n\n${PLAN.trimEnd()}\n\n${TOPOLOGY.trimEnd()}\n`;

const runJson = (mode: "fresh" | "re-plan") =>
	renderRunRecord({
		epic: 4300,
		run: "4300-c1a4d6f8",
		mode,
		cycleDoc: "present",
		bodyDigest: DIGEST,
	});

const STAGED = {
	[runJsonPath(DIR)]: runJson("fresh"),
	[planPath(DIR)]: PLAN,
	[topologyPath(DIR)]: TOPOLOGY,
};

/**
 * The two body reads, in the order the write issues them — `once` lets the confirming read differ from
 * the pre-write one. Built per call, because a spent `once` pattern would leak across tests.
 */
const happy = (
	options: {before?: string; after?: string; patch?: ExecResult} = {},
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[once(EPIC_READ), epic({body: options.before ?? BODY})],
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	...CLAIMED,
	[PATCH, options.patch ?? okOut("{}")],
	[EPIC_READ, epic({body: options.after ?? SPLICED})],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]> = happy(),
	files: Readonly<Record<string, string | null>> = STAGED,
	digest: string = DIGEST,
) => {
	const shell = fakeShell(script);
	const fs = fakeFs({files});
	return Effect.runPromise(
		Effect.provide(
			runWrite({number: 4300, bodyDigest: digest, token: TOKEN, repo: null, cwd: "/repo", env}),
			Layer.mergeAll(shell.layer, fs.layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

describe("runWrite", () => {
	it("splices both documents in one PATCH and proves the whole body read back", async () => {
		const {outcome, calls} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "written",
			epic: 4300,
			mode: "fresh",
			bodyDigest: DIGEST,
			newDigest: bodyDigest(SPLICED),
			verified: true,
		});
		// One PATCH, and only one. v1 looped three times over a body write whose every branch broke.
		expect(calls.filter((line) => PATCH.test(line)).length).toBe(1);
	});

	it("names the document that was never staged", async () => {
		const {outcome} = await run(happy(), {
			[runJsonPath(DIR)]: runJson("fresh"),
			[planPath(DIR)]: PLAN,
		});
		expect(outcome.code).toBe(NOT_STAGED);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger write: topology.md was never staged in this run — stage it before writing.",
		);
	});

	it("names the plan when that is the missing one", async () => {
		const {outcome} = await run(happy(), {
			[runJsonPath(DIR)]: runJson("fresh"),
			[topologyPath(DIR)]: TOPOLOGY,
		});
		expect(outcome.stderr.at(-1)).toBe(
			"ledger write: plan.md was never staged in this run — stage it before writing.",
		);
	});

	it("refuses a body that moved since open, and writes nothing", async () => {
		const {outcome, calls} = await run(happy(), STAGED, "0123456789ab");
		expect(outcome.code).toBe(EPIC_MOVED);
		expect(calls.some((line) => PATCH.test(line))).toBe(false);
	});

	it("refuses a malformed --body-digest before any read", async () => {
		const {outcome, calls} = await run(happy(), STAGED, "NOPE");
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(calls).toEqual([]);
	});

	/**
	 * `mode` is carried from `ledger open`, never re-derived — which is what makes the disagreement
	 * observable instead of letting a first-time append silently overwrite a real plan.
	 */
	it("refuses a re-plan whose body carries no plan anchor", async () => {
		const {outcome, calls} = await run(happy(), {
			...STAGED,
			[runJsonPath(DIR)]: runJson("re-plan"),
		});
		expect(outcome.code).toBe(REGION_UNRESOLVABLE);
		expect(outcome.stderr.at(-1)).toContain("the anchor drifted or was deleted");
		expect(calls.some((line) => PATCH.test(line))).toBe(false);
	});

	it("refuses a fresh run whose body already carries a plan heading", async () => {
		const body = `${BODY}\n${PLAN}`;
		const {outcome} = await run(
			[
				[once(EPIC_READ), epic({body})],
				[/^git rev-parse --path-format=absolute/, GIT_DIRS],
				...CLAIMED,
				[PATCH, okOut("{}")],
				[EPIC_READ, epic({body})],
			],
			{...STAGED, [runJsonPath(DIR)]: runJson("fresh")},
			bodyDigest(body),
		);
		expect(outcome.code).toBe(REGION_UNRESOLVABLE);
	});

	it("seats an unconfirmable PATCH on 8", async () => {
		const {outcome} = await run(happy({patch: errOut("gh: Bad Gateway (HTTP 502)")}));
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});

	/** The comparison is over the WHOLE normalized body, not a re-extraction of the region (#4879). */
	it("refuses a body that landed and does not read back as composed", async () => {
		const {outcome} = await run([
			[once(EPIC_READ), epic()],
			[/^git rev-parse --path-format=absolute/, GIT_DIRS],
			...CLAIMED,
			[PATCH, okOut("{}")],
			[EPIC_READ, epic({body: `${SPLICED}\nsomeone else wrote this\n`})],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("refuses when the run directory holds no run.json", async () => {
		const {outcome} = await run(happy(), {[planPath(DIR)]: PLAN, [topologyPath(DIR)]: TOPOLOGY});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
