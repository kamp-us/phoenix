import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
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

/**
 * The pull record and the unified diff are the same URL under different `Accept` headers, so the
 * record is scripted `once` and the diff answers every later read of that endpoint.
 */
const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
const DIFF = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
const FILES = /^GET \S+\/repos\/o\/r\/pulls\/4321\/files\?/;
const LABELS = /^GET \S+\/repos\/o\/r\/labels\?/;
const LABEL = /^POST \S+\/repos\/o\/r\/issues\/4287\/labels$/;
const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/4287$/;
/** The registry is read at the base ref through the raw media type. */
const REGISTRY = /contents\/apps\/web\/worker\/features\/flagship\/resources\.ts/;

/** A canned `ExecResult` fixture as the body of a 200 — the same payload, off the served seam. */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

/** The verb's first read of the pull request — the record, before the diff of the same URL. */
const pullRecord = (shape: Parameters<typeof pull>[0] = {}): Scripted => [
	once(PULL),
	served(pull(shape)),
];

/** The diff, served as bytes under the diff media type. */
const diff = (text: string): Scripted => [DIFF, {status: 200, body: text}];

const REGISTRY_TEXT = `export const flags = [
	FlagshipFlag("sozluk-vote-widget", {defaultVariation: "off"}),
];
`;

const REGISTRY_SERVED: HttpReply = {status: 200, body: REGISTRY_TEXT};

/** The registry a repo without a flag substrate has: proven absent, never unreadable. */
const REGISTRY_ABSENT: HttpReply = {status: 404, body: '{"message":"Not Found"}'};

const REGISTRY_UNREADABLE: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

/** The repository's label vocabulary, as the labels endpoint answers it. */
const taxonomy = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

const TAXONOMY = taxonomy("status:awaiting-release", "status:triaged", "type:bug");

const PLAIN_DIFF = `diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx
+const a = 1;
`;

const DECLARING_DIFF = `diff --git a/${FLAG_REGISTRY} b/${FLAG_REGISTRY}
+	FlagshipFlag("sozluk-new-thing", {defaultVariation: "off"}),
`;

const options = {pr: 4321, repo: null, json: false, env: ENV};

const run = (
	script: ReadonlyArray<Scripted>,
	http: ReadonlyArray<Scripted> = [],
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runRelease({...options, ...overrides}), fakeSeams([...script, ...http]).layer),
	);

const runObserved = (script: ReadonlyArray<Scripted>, http: ReadonlyArray<Scripted> = []) => {
	const seams = fakeSeams([...script, ...http]);
	return Effect.runPromise(Effect.provide(runRelease(options), seams.layer)).then((out) => ({
		out,
		calls: seams.requests,
	}));
};

const twoFiles = served(files("apps/web/src/App.tsx", "README.md"));

describe("runRelease", () => {
	it("answers n/a when no signal fires", async () => {
		const out = await run(
			[pullRecord(), [FILES, twoFiles], diff(PLAIN_DIFF)],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("release\tn/a\t-\n");
	});

	it("queues the linked issue and PROVES the label from a re-read", async () => {
		const out = await run(
			[
				pullRecord({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"}),
				[FILES, twoFiles],
				diff(PLAIN_DIFF),
				[LABELS, TAXONOMY],
				[LABEL, {status: 200, body: "[]"}],
				[ISSUE, served(issue(["status:awaiting-release"]))],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.stdout).toBe("release\tqueued\tsozluk-vote-widget\n");
	});

	it("answers no-issue — never n/a — when a signal fires with nothing to label", async () => {
		const out = await run(
			[pullRecord({body: "no closing keyword here"}), [FILES, twoFiles], diff(DECLARING_DIFF)],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("release\tno-issue\t-\n");
	});

	it("never reads an inherited Containment stamp — the #1257 phantom release", async () => {
		const out = await run(
			[
				pullRecord({body: "Fixes #4287\n\n**Containment:** flag (default-off)\n"}),
				[FILES, twoFiles],
				diff(PLAIN_DIFF),
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.stdout).toBe("release\tn/a\t-\n");
	});

	it("treats an ABSENT registry as a repo without a flag substrate, not as UNKNOWN", async () => {
		const out = await run(
			[pullRecord(), [FILES, twoFiles], diff(PLAIN_DIFF)],
			[[REGISTRY, REGISTRY_ABSENT]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("release\tn/a\t-\n");
	});

	it("refuses an UNREADABLE registry on 11 — dark-ship-ness is UNKNOWN, never n/a", async () => {
		const out = await run(
			[pullRecord(), [FILES, twoFiles], diff(PLAIN_DIFF)],
			[[REGISTRY, REGISTRY_UNREADABLE]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('whether this is a dark ship is UNKNOWN, never "n/a"');
	});

	it("refuses a truncated diff on 13 rather than scanning it for flag signals", async () => {
		const out = await run([pullRecord({changedFiles: 9}), [FILES, served(files("README.md"))]]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses on 8 when the label write fails — escalate, never `queued`", async () => {
		const out = await run(
			[
				pullRecord({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"}),
				[FILES, twoFiles],
				diff(PLAIN_DIFF),
				[LABELS, TAXONOMY],
				[LABEL, {status: 502, body: '{"message":"Bad gateway"}'}],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("may be missing from the release queue; escalate");
	});

	it("refuses on 9 when the write landed and the read-back does not show the label", async () => {
		const out = await run(
			[
				pullRecord({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"}),
				[FILES, twoFiles],
				diff(PLAIN_DIFF),
				[LABELS, TAXONOMY],
				[LABEL, {status: 200, body: "[]"}],
				[ISSUE, served(issue([]))],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	it("refuses on 23 when status:awaiting-release is absent — never minting it (#4285)", async () => {
		const {out, calls} = await runObserved(
			[
				pullRecord({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"}),
				[FILES, twoFiles],
				diff(PLAIN_DIFF),
				[LABELS, taxonomy("status:triaged", "type:bug")],
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
				pullRecord({body: "Fixes #4287\n\nFlag: sozluk-vote-widget\n"}),
				[FILES, twoFiles],
				diff(PLAIN_DIFF),
				[LABELS, {status: 502, body: '{"message":"Bad gateway"}'}],
			],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot read o/r's label taxonomy");
		expect(calls.some((line) => LABEL.test(line))).toBe(false);
	});

	it("reads no taxonomy on the paths that post nothing — n/a and no-issue", async () => {
		const nonWriting = await runObserved(
			[pullRecord(), [FILES, twoFiles], diff(PLAIN_DIFF)],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(nonWriting.out.code).toBe(0);
		expect(nonWriting.calls.some((line) => LABELS.test(line))).toBe(false);

		const noIssue = await runObserved(
			[pullRecord({body: "no closing keyword here"}), [FILES, twoFiles], diff(DECLARING_DIFF)],
			[[REGISTRY, REGISTRY_SERVED]],
		);
		expect(noIssue.out.code).toBe(0);
		expect(noIssue.calls.some((line) => LABELS.test(line))).toBe(false);
	});
});
