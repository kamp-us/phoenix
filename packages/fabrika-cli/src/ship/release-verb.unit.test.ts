import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {FLAG_REGISTRY} from "./dark-ship.ts";
import {ENV, files, issue, pull} from "./fixtures.test-support.ts";
import {runRelease} from "./release-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;
const DIFF = /^gh api -H Accept: application\/vnd\.github\.diff repos\/o\/r\/pulls\/4321$/;
const REGISTRY = /contents\/apps\/web\/worker\/features\/flagship\/resources\.ts/;
const LABEL = /^gh api --method POST repos\/o\/r\/issues\/4287\/labels/;
const ISSUE = /^gh api repos\/o\/r\/issues\/4287$/;

const REGISTRY_TEXT = `export const flags = [
	FlagshipFlag("sozluk-vote-widget", {defaultVariation: "off"}),
];
`;

const PLAIN_DIFF = `diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx
+const a = 1;
`;

const DECLARING_DIFF = `diff --git a/${FLAG_REGISTRY} b/${FLAG_REGISTRY}
+	FlagshipFlag("sozluk-new-thing", {defaultVariation: "off"}),
`;

const options = {pr: 4321, repo: null, json: false, env: ENV};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runRelease({...options, ...overrides}), fakeShell(script).layer),
	);

const twoFiles = files("apps/web/src/App.tsx", "README.md");

describe("runRelease", () => {
	it("answers n/a when no signal fires", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, twoFiles],
			[DIFF, okOut(PLAIN_DIFF)],
			[REGISTRY, okOut(REGISTRY_TEXT)],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("release\tn/a\t-\n");
	});

	it("queues the linked issue and PROVES the label from a re-read", async () => {
		const out = await run([
			[PULL, pull({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"})],
			[FILES, twoFiles],
			[DIFF, okOut(PLAIN_DIFF)],
			[REGISTRY, okOut(REGISTRY_TEXT)],
			[LABEL, okOut("[]")],
			[ISSUE, issue(["status:awaiting-release"])],
		]);
		expect(out.stdout).toBe("release\tqueued\tsozluk-vote-widget\n");
	});

	it("answers no-issue — never n/a — when a signal fires with nothing to label", async () => {
		const out = await run([
			[PULL, pull({body: "no closing keyword here"})],
			[FILES, twoFiles],
			[DIFF, okOut(DECLARING_DIFF)],
			[REGISTRY, okOut(REGISTRY_TEXT)],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("release\tno-issue\t-\n");
	});

	it("never reads an inherited Containment stamp — the #1257 phantom release", async () => {
		const out = await run([
			[PULL, pull({body: "Fixes #4287\n\n**Containment:** flag (default-off)\n"})],
			[FILES, twoFiles],
			[DIFF, okOut(PLAIN_DIFF)],
			[REGISTRY, okOut(REGISTRY_TEXT)],
		]);
		expect(out.stdout).toBe("release\tn/a\t-\n");
	});

	it("treats an ABSENT registry as a repo without a flag substrate, not as UNKNOWN", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, twoFiles],
			[DIFF, okOut(PLAIN_DIFF)],
			[REGISTRY, errOut("gh: Not Found (HTTP 404)")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("release\tn/a\t-\n");
	});

	it("refuses an UNREADABLE registry on 11 — dark-ship-ness is UNKNOWN, never n/a", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, twoFiles],
			[DIFF, okOut(PLAIN_DIFF)],
			[REGISTRY, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('whether this is a dark ship is UNKNOWN, never "n/a"');
	});

	it("refuses a truncated diff on 13 rather than scanning it for flag signals", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 9})],
			[FILES, files("README.md")],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses on 8 when the label write fails — escalate, never `queued`", async () => {
		const out = await run([
			[PULL, pull({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"})],
			[FILES, twoFiles],
			[DIFF, okOut(PLAIN_DIFF)],
			[REGISTRY, okOut(REGISTRY_TEXT)],
			[LABEL, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("may be missing from the release queue; escalate");
	});

	it("refuses on 9 when the write landed and the read-back does not show the label", async () => {
		const out = await run([
			[PULL, pull({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"})],
			[FILES, twoFiles],
			[DIFF, okOut(PLAIN_DIFF)],
			[REGISTRY, okOut(REGISTRY_TEXT)],
			[LABEL, okOut("[]")],
			[ISSUE, issue([])],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});
});
