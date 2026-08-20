/**
 * `review-ui route` — the escape from the unfillable namespace, and the fences that keep it from
 * becoming a second verdict path (ADR 0316, #6376).
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {read as readVerdict} from "../wire/verdict-marker.ts";
import {
	EMPTY_STDIN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_TREE,
	ZERO_SCOPE,
} from "./codes.ts";
import {runRoute} from "./route-verb.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const MOVED = "9fe12ab04f5a6b7c8d9e0f1a2b3c4d5e6f708192";
const URL = "https://example.test/pull/6326#issuecomment-512399";
const CLAUSE = "no rendered delta; both files are prose only";

const PULL = /^gh api repos\/o\/r\/pulls\/6326$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/6326\/files/;
const USER = /^gh api user --jq \.login$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/6326\/comments/;
const CREATE = /^gh api --method POST repos\/o\/r\/issues\/6326\/comments /;
const PATCH = /^gh api --method PATCH repos\/o\/r\/issues\/comments\/\d+ /;
const READBACK = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;

const BODY =
	"`shell-keys.ts` rewrites one JSDoc paragraph and the lint config two note strings. No component,\nroute, token or style changed.\n";

const pull = (shape: {state?: string; head?: string; changed?: number} = {}): ExecResult =>
	okOut(
		JSON.stringify({
			number: 6326,
			state: shape.state ?? "open",
			head: {sha: shape.head ?? HEAD},
			base: {ref: "main"},
			body: "",
			changed_files: shape.changed ?? 2,
			comments: 0,
		}),
	);

const files = (...names: ReadonlyArray<string>): ExecResult =>
	okOut(JSON.stringify(names.map((filename) => ({filename}))));

const PROSE_UI = files("apps/web/src/flags/shell-keys.ts", "apps/web/src/styles/lint.config.json");

const options = {
	pr: 6326,
	sha: HEAD,
	clause: CLAUSE,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
};

/** The bytes the verb composes, so the read-back fixture is never a hand-typed second grammar. */
const composed = (sha = HEAD, clause = CLAUSE): string =>
	`routed-elsewhere: review-ui @ ${sha} — ${clause}\n\n${BODY.replace(/\n+$/, "")}\n`;

const happy = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull()],
	[FILES, PROSE_UI],
	[USER, okOut("reviewer")],
	[COMMENTS, okOut("[]")],
	[CREATE, okOut(JSON.stringify({id: 512399, html_url: URL}))],
	[READBACK, okOut(JSON.stringify({body: composed()}))],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) => {
	const shell = fakeShell(script);
	return Effect.runPromise(Effect.provide(runRoute({...options, ...overrides}), shell.layer)).then(
		(outcome) => ({outcome, calls: shell.calls}),
	);
};

describe("review-ui route", () => {
	it("posts the head-bound record and reads it back", async () => {
		const {outcome} = await run(happy());
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "routed",
			namespace: "review-ui",
			sha: HEAD,
			uiFiles: 2,
			upsert: "created",
		});
	});

	it("posts bytes the verdict reader refuses to read as a verdict", async () => {
		const {calls} = await run(happy());
		const posted = calls.find((call) => CREATE.test(call)) ?? "";
		expect(posted).toContain("routed-elsewhere: review-ui @");
		expect(readVerdict(composed())._tag).toBe("Absent");
	});

	it("upserts onto its own prior record rather than stacking a second claim", async () => {
		const {outcome} = await run([
			[PULL, pull()],
			[FILES, PROSE_UI],
			[USER, okOut("reviewer")],
			[
				COMMENTS,
				okOut(
					JSON.stringify([
						{
							id: 77,
							user: {login: "reviewer"},
							created_at: "2026-08-19T00:00:00Z",
							updated_at: "2026-08-19T00:00:00Z",
							body: composed(MOVED),
						},
					]),
				),
			],
			[PATCH, okOut(JSON.stringify({html_url: URL}))],
			[READBACK, okOut(JSON.stringify({body: composed()}))],
		]);
		expect(JSON.parse(outcome.stdout)).toMatchObject({upsert: "edited"});
	});

	// The whole point of the verb: this is the shape that was unshippable, because `review-ui` had no
	// legal emission for it and `ship gate` blocks on the absence.
	it("refuses on 7 when the diff raises no ui class — there is nothing to route", async () => {
		const {outcome} = await run([
			[PULL, pull({changed: 1})],
			[FILES, files("packages/fabrika-cli/src/wire/registry.ts")],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("raises no ui class");
	});

	it("refuses on 11 rather than deriving the class from a truncated file list", async () => {
		const {outcome} = await run([
			[PULL, pull({changed: 400})],
			[FILES, PROSE_UI],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("truncated read");
	});

	it("refuses on 12 when the live head moved past --sha", async () => {
		const {outcome} = await run([[PULL, pull({head: MOVED})]]);
		expect(outcome.code).toBe(STALE_TREE);
	});

	it("refuses a blank clause on 10 — a route with no reason records nothing checkable", async () => {
		const {outcome} = await run(happy(), {clause: "   "});
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});

	it("refuses a --sha that is not a head on 10", async () => {
		const {outcome} = await run(happy(), {sha: "not-a-sha"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});

	it("refuses an empty body on 3 — an unexplained route is an assertion nobody can check", async () => {
		const {outcome} = await run(happy(), {
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "  \n"}),
		});
		expect(outcome.code).toBe(EMPTY_STDIN);
	});

	it("refuses on 9 when the read-back is not the record that was sent", async () => {
		const {outcome} = await run([
			[PULL, pull()],
			[FILES, PROSE_UI],
			[USER, okOut("reviewer")],
			[COMMENTS, okOut("[]")],
			[CREATE, okOut(JSON.stringify({id: 512399, html_url: URL}))],
			[READBACK, okOut(JSON.stringify({body: composed(MOVED)}))],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});
