/**
 * The range-scoped write path (#5935), exercised through both verbs that own it — end to end on a
 * range, from the flag seam to the read-back, against the same reader `lane prove`'s epic-child arm
 * folds. The fail-closed direction gets its own cases: a namespace the range did not derive and a
 * range touching no governance root both refuse, so growing the range mode narrowed neither guard.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeHttp, fakeShell, okOut, unconfigured} from "../fakes.test-support.ts";
import {NOT_HARNESS_TOUCHING} from "../governance/codes.ts";
import {
	type PostOptions as GovernancePostOptions,
	runPost as runGovernancePost,
} from "../governance/post-verb.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {read as readRangeMarker} from "../wire/range-verdict-marker.ts";
import {OFF_VOCABULARY, ZERO_SCOPE} from "./codes.ts";
import {BASE, CONTENT, comments, HEAD, RAW, RAW_AT} from "./fixtures.test-support.ts";
import {type PostOptions as ReviewPostOptions, runPost as runReviewPost} from "./post-verb.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/5830$/;
const USER = /^gh api user --jq \.login$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/5830\/comments/;
const CREATE = /^gh api --method POST repos\/o\/r\/issues\/5830\/comments /;
const PATCH = /^gh api --method PATCH repos\/o\/r\/issues\/comments\/\d+ /;
const READBACK = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;

const BODY = "| criterion | verdict |\n|---|---|\n| the first thing | PASS |\n";
const URL = "https://example.test/issues/5830#issuecomment-6100000001";
const RANGE = `${BASE}..${HEAD}`;
const MARKER = `review-doc: PASS range:${RANGE} content:${CONTENT} — guide matches shipped behavior`;

/** One `--raw -z` record under a governance root, and the digest that record serializes to. */
const GOV_RAW = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0claude-plugins/fabrika/skills/operate/SKILL.md\0`;
const GOV_CONTENT = "bb15e4131548";
const GOV_MARKER = `governance: PASS range:${RANGE} content:${GOV_CONTENT} — no contradiction, no weakening`;

const issue = (shape: {state?: string; pull?: boolean} = {}): ExecResult =>
	okOut(
		JSON.stringify({
			number: 5830,
			title: "epic child",
			body: "",
			state: shape.state ?? "open",
			labels: [],
			html_url: "https://example.test/issues/5830",
			user: {login: "usirin"},
			...(shape.pull ? {pull_request: {url: "https://example.test/pulls/5830"}} : {}),
		}),
	);

const created = okOut(JSON.stringify({id: 6100000001, html_url: URL}));
const commentBody = (body: string): ExecResult => okOut(JSON.stringify({body}));

const reviewOptions: ReviewPostOptions = {
	pr: 5830,
	namespace: "review-doc",
	polarity: "PASS",
	sha: null,
	clause: "guide matches shipped behavior",
	carrier: "marker",
	base: BASE,
	tip: HEAD,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
	now: Effect.succeed(0),
};

const governanceOptions: GovernancePostOptions = {
	pr: 5830,
	polarity: "PASS",
	sha: null,
	clause: "no contradiction, no weakening",
	base: BASE,
	tip: HEAD,
	repo: null,
	json: false,
	cwd: "/repo",
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
};

const reviewHappy = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[ISSUE, issue()],
	[RAW_AT(BASE, HEAD), okOut(RAW)],
	[USER, okOut("kampus-bot")],
	[COMMENTS, comments()],
	[CREATE, created],
	[READBACK, commentBody(`${MARKER}\n\n${BODY}`)],
];

const governanceHappy = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[ISSUE, issue()],
	[RAW_AT(BASE, HEAD), okOut(GOV_RAW)],
	[USER, okOut("kampus-bot")],
	[COMMENTS, comments()],
	[CREATE, created],
	[READBACK, commentBody(`${GOV_MARKER}\n\n${BODY}`)],
];

const runReview = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof reviewOptions> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runReviewPost({...reviewOptions, ...overrides}),
			Layer.mergeAll(fakeShell(script).layer, unconfigured, fakeHttp([]).layer),
		),
	);

const runGovernance = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof governanceOptions> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runGovernancePost({...governanceOptions, ...overrides}),
			Layer.mergeAll(fakeShell(script).layer, unconfigured, fakeHttp([]).layer),
		),
	);

describe("review post --base/--tip", () => {
	it("posts the range-scoped verdict on the child issue and names the range it binds", async () => {
		const out = await runReview(reviewHappy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`posted\treview-doc\tPASS\t${RANGE}\t${CONTENT}\tcreated\t${URL}\n`);
	});

	it("composes the exact marker the epic-child prove arm reads back", async () => {
		const shell = fakeShell(reviewHappy());
		await Effect.runPromise(
			Effect.provide(runReviewPost(reviewOptions), Layer.merge(shell.layer, unconfigured)),
		);
		const write = shell.calls.find((call) => CREATE.test(call)) ?? "";
		const body = write.slice(write.indexOf("body=") + "body=".length);
		expect(body.split("\n")[0]).toBe(MARKER);
		const parsed = readRangeMarker(body);
		expect(parsed._tag).toBe("Found");
		if (parsed._tag === "Found") {
			expect(parsed.value.namespace).toBe("review-doc");
			expect(parsed.value.polarity).toBe("PASS");
			expect(parsed.value.range).toEqual({base: BASE, tip: HEAD});
			expect(parsed.value.content).toBe(CONTENT);
		}
	});

	it("edits this namespace's existing comment over the SAME range instead of stacking", async () => {
		const out = await runReview([
			[ISSUE, issue()],
			[RAW_AT(BASE, HEAD), okOut(RAW)],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments({id: 42, body: `${MARKER}\n\nan earlier table\n`})],
			[PATCH, okOut(JSON.stringify({html_url: URL}))],
			[READBACK, commentBody(`${MARKER}\n\n${BODY}`)],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("\tedited\t");
	});

	it("refuses a namespace the range's own changes did not derive — the guard is not narrowed", async () => {
		const out = await runReview(
			[
				[ISSUE, issue()],
				[RAW_AT(BASE, HEAD), okOut(RAW)],
			],
			{namespace: "review-skill"},
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.join("\n")).toContain("is not derived by");
	});

	it("refuses --sha beside a range: content is the only binding", async () => {
		const out = await runReview([], {sha: HEAD});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.join("\n")).toContain("--sha does not combine with --base/--tip");
	});

	it("refuses a lone --base and a lone --tip: a range has two ends", async () => {
		for (const overrides of [{tip: null}, {base: null}]) {
			const out = await runReview([], overrides);
			expect(out.code).toBe(OFF_VOCABULARY);
			expect(out.stderr.join("\n")).toContain("--base and --tip come together");
		}
	});

	it("refuses the advisory carrier on a range: an advisory is head-scoped by design", async () => {
		const out = await runReview([], {carrier: "advisory"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.join("\n")).toContain("no advisory carrier");
	});

	it("still requires --sha when no range is given", async () => {
		const out = await runReview([], {base: null, tip: null});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.join("\n")).toContain("--sha is required");
	});

	it("refuses a closed issue and a pull request as the range target", async () => {
		const closed = await runReview([[ISSUE, issue({state: "closed"})]]);
		expect(closed.code).toBe(ZERO_SCOPE);
		expect(closed.stderr.join("\n")).toContain("gates nothing");
		const pull = await runReview([[ISSUE, issue({pull: true})]]);
		expect(pull.code).toBe(ZERO_SCOPE);
		expect(pull.stderr.join("\n")).toContain("is a pull request");
	});
});

describe("governance post --base/--tip", () => {
	it("posts the range-scoped governance verdict a harness-touching child proves on", async () => {
		const out = await runGovernance(governanceHappy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			`posted\tgovernance\tPASS\t${RANGE}\t${GOV_CONTENT}\tcreated\t${URL}\n`,
		);
	});

	it("composes the governance marker through the range wire format", async () => {
		const shell = fakeShell(governanceHappy());
		await Effect.runPromise(
			Effect.provide(
				runGovernancePost(governanceOptions),
				Layer.mergeAll(shell.layer, unconfigured, fakeHttp([]).layer),
			),
		);
		const write = shell.calls.find((call) => CREATE.test(call)) ?? "";
		const body = write.slice(write.indexOf("body=") + "body=".length);
		const parsed = readRangeMarker(body);
		expect(parsed._tag).toBe("Found");
		if (parsed._tag === "Found") {
			expect(parsed.value.namespace).toBe("governance");
			expect(parsed.value.range).toEqual({base: BASE, tip: HEAD});
			expect(parsed.value.content).toBe(GOV_CONTENT);
		}
	});

	it("refuses a range touching no governance root — the fail-closed floor is not narrowed", async () => {
		const out = await runGovernance([
			[ISSUE, issue()],
			[RAW_AT(BASE, HEAD), okOut(RAW)],
		]);
		expect(out.code).toBe(NOT_HARNESS_TOUCHING);
		expect(out.stderr.join("\n")).toContain("touches no governance root");
	});

	it("refuses --sha beside a range and a lone range end, same as the review seam", async () => {
		const withSha = await runGovernance([], {sha: HEAD});
		expect(withSha.code).toBe(OFF_VOCABULARY);
		const lone = await runGovernance([], {tip: null});
		expect(lone.code).toBe(OFF_VOCABULARY);
	});
});
