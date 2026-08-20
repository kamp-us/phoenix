import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeHttp, fakeShell, type HttpReply, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	INCOMPLETE_SCAN,
	LABEL_ABSENT,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {FLAG_REGISTRY} from "./dark-ship.ts";
import {ENV, files, issue, pull} from "./fixtures.test-support.ts";
import {runRelease} from "./release-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;
const DIFF = /^gh api -H Accept: application\/vnd\.github\.diff repos\/o\/r\/pulls\/4321$/;
const LABELS = /^gh api --paginate repos\/o\/r\/labels/;
const LABEL = /^gh api --method POST repos\/o\/r\/issues\/4287\/labels/;
const ISSUE = /^gh api repos\/o\/r\/issues\/4287$/;
/** The registry is read at the base ref over HTTP; every other read here still shells out. */
const REGISTRY = /contents\/apps\/web\/worker\/features\/flagship\/resources\.ts/;

const REGISTRY_TEXT = `export const flags = [
	FlagshipFlag("sozluk-vote-widget", {defaultVariation: "off"}),
];
`;

const REGISTRY_SERVED: HttpReply = {status: 200, body: REGISTRY_TEXT};

/** The registry a repo without a flag substrate has: proven absent, never unreadable. */
const REGISTRY_ABSENT: HttpReply = {status: 404, body: '{"message":"Not Found"}'};

const REGISTRY_UNREADABLE: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

const TAXONOMY = okOut("status:awaiting-release\nstatus:triaged\ntype:bug\n");

const PLAIN_DIFF = `diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx
+const a = 1;
`;

const DECLARING_DIFF = `diff --git a/${FLAG_REGISTRY} b/${FLAG_REGISTRY}
+	FlagshipFlag("sozluk-new-thing", {defaultVariation: "off"}),
`;

const options = {pr: 4321, repo: null, json: false, env: ENV};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	http: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runRelease({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fakeHttp(http).layer),
		),
	);

const runObserved = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	http: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(runRelease(options), Layer.merge(shell.layer, fakeHttp(http).layer)),
	).then((out) => ({out, calls: shell.calls}));
};

const twoFiles = files("apps/web/src/App.tsx", "README.md");

describe("runRelease", () => {
	it("answers n/a when no signal fires", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[FILES, twoFiles],
				[DIFF, okOut(PLAIN_DIFF)],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("release\tn/a\t-\n");
	});

	it("queues the linked issue and PROVES the label from a re-read", async () => {
		const out = await run(
			[
				[PULL, pull({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"})],
				[FILES, twoFiles],
				[DIFF, okOut(PLAIN_DIFF)],
				[LABELS, TAXONOMY],
				[LABEL, okOut("[]")],
				[ISSUE, issue(["status:awaiting-release"])],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.stdout).toBe("release\tqueued\tsozluk-vote-widget\n");
	});

	it("answers no-issue — never n/a — when a signal fires with nothing to label", async () => {
		const out = await run(
			[
				[PULL, pull({body: "no closing keyword here"})],
				[FILES, twoFiles],
				[DIFF, okOut(DECLARING_DIFF)],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("release\tno-issue\t-\n");
	});

	it("never reads an inherited Containment stamp — the #1257 phantom release", async () => {
		const out = await run(
			[
				[PULL, pull({body: "Fixes #4287\n\n**Containment:** flag (default-off)\n"})],
				[FILES, twoFiles],
				[DIFF, okOut(PLAIN_DIFF)],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.stdout).toBe("release\tn/a\t-\n");
	});

	it("treats an ABSENT registry as a repo without a flag substrate, not as UNKNOWN", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[FILES, twoFiles],
				[DIFF, okOut(PLAIN_DIFF)],
			],
			[[REGISTRY, REGISTRY_ABSENT]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("release\tn/a\t-\n");
	});

	it("refuses an UNREADABLE registry on 11 — dark-ship-ness is UNKNOWN, never n/a", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[FILES, twoFiles],
				[DIFF, okOut(PLAIN_DIFF)],
			],
			[[REGISTRY, REGISTRY_UNREADABLE]],
		);
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
		const out = await run(
			[
				[PULL, pull({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"})],
				[FILES, twoFiles],
				[DIFF, okOut(PLAIN_DIFF)],
				[LABELS, TAXONOMY],
				[LABEL, errOut("gh: Bad gateway (HTTP 502)")],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("may be missing from the release queue; escalate");
	});

	it("refuses on 9 when the write landed and the read-back does not show the label", async () => {
		const out = await run(
			[
				[PULL, pull({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"})],
				[FILES, twoFiles],
				[DIFF, okOut(PLAIN_DIFF)],
				[LABELS, TAXONOMY],
				[LABEL, okOut("[]")],
				[ISSUE, issue([])],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	it("refuses on 23 when status:awaiting-release is absent — never minting it (#4285)", async () => {
		const {out, calls} = await runObserved(
			[
				[PULL, pull({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"})],
				[FILES, twoFiles],
				[DIFF, okOut(PLAIN_DIFF)],
				[LABELS, okOut("status:triaged\ntype:bug\n")],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(LABEL_ABSENT);
		expect(out.stderr.at(-1)).toContain('label "status:awaiting-release" is absent');
		expect(out.stderr.at(-1)).toContain("#4285");
		expect(out.stderr.at(-1)).toContain("A real dark ship is not queued");
		expect(calls.some((line) => LABEL.test(line))).toBe(false);
	});

	it("refuses an unreadable taxonomy on 11 — an unreachable GitHub is not an absent label", async () => {
		const {out, calls} = await runObserved(
			[
				[PULL, pull({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"})],
				[FILES, twoFiles],
				[DIFF, okOut(PLAIN_DIFF)],
				[LABELS, errOut("gh: Bad gateway (HTTP 502)")],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot read o/r's label taxonomy");
		expect(calls.some((line) => LABEL.test(line))).toBe(false);
	});

	it("reads no taxonomy on the paths that post nothing — n/a and no-issue", async () => {
		const nonWriting = await runObserved(
			[
				[PULL, pull()],
				[FILES, twoFiles],
				[DIFF, okOut(PLAIN_DIFF)],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(nonWriting.out.code).toBe(0);
		expect(nonWriting.calls.some((line) => LABELS.test(line))).toBe(false);

		const noIssue = await runObserved(
			[
				[PULL, pull({body: "no closing keyword here"})],
				[FILES, twoFiles],
				[DIFF, okOut(DECLARING_DIFF)],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(noIssue.out.code).toBe(0);
		expect(noIssue.calls.some((line) => LABELS.test(line))).toBe(false);
	});
});
