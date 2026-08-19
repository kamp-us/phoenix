import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {gateOf, readBlockedness} from "./blockedness.ts";
import {issue} from "./fixtures.test-support.ts";

const EDGES =
	/^gh api --paginate repos\/o\/r\/issues\/4312\/dependencies\/blocked_by\?per_page=100$/;
const BLOCKER = (n: number) => new RegExp(`^gh api repos/o/r/issues/${n}$`);

const NOT_FOUND = errOut("gh: Not Found (HTTP 404)");
const GATEWAY = errOut("gh: Bad gateway (HTTP 502)");

const edges = (...numbers: ReadonlyArray<number>): ExecResult =>
	okOut(JSON.stringify(numbers.map((number) => ({number, state: "open"}))));

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
	Effect.runPromise(Effect.provide(readBlockedness("o/r", 4312), fakeShell(script).layer));

describe("readBlockedness", () => {
	it("proves not-blocked over an empty edge list, and says how many it scanned", async () => {
		expect(await run([[EDGES, edges()]])).toEqual({_tag: "Read", scanned: 0, open: [], unread: []});
	});

	it("counts an open blocker, and leaves a closed one out", async () => {
		const out = await run([
			[EDGES, edges(210, 211)],
			[BLOCKER(210), issue({number: 210, state: "closed"})],
			[BLOCKER(211), issue({number: 211, state: "open"})],
		]);
		expect(out).toEqual({_tag: "Read", scanned: 2, open: [211], unread: []});
	});

	it("counts a blocker the token cannot see as open — an unseen edge is not a discharged one", async () => {
		const out = await run([
			[EDGES, edges(210)],
			[BLOCKER(210), NOT_FOUND],
		]);
		expect(out).toEqual({_tag: "Read", scanned: 1, open: [210], unread: []});
	});

	it("reports an unreadable blocker as its own row, never as closed", async () => {
		const out = await run([
			[EDGES, edges(210, 211)],
			[BLOCKER(210), GATEWAY],
			[BLOCKER(211), issue({number: 211, state: "open"})],
		]);
		expect(out).toEqual({
			_tag: "Read",
			scanned: 2,
			open: [211],
			unread: [{number: 210, reason: "gh: Bad gateway (HTTP 502)"}],
		});
	});

	it("is Unknown when the edge list could not be read — never an empty list", async () => {
		expect(await run([[EDGES, GATEWAY]])).toEqual({
			_tag: "Unknown",
			reason: "gh: Bad gateway (HTTP 502)",
		});
	});

	it("is Unknown on a 404, which the caller has already ruled out by proving the issue open", async () => {
		const out = await run([[EDGES, NOT_FOUND]]);
		expect(out._tag).toBe("Unknown");
		expect(out).toMatchObject({
			reason: "the blocked_by list for #4312 answered 404 for an issue already proven open",
		});
	});
});

describe("gateOf", () => {
	it("is Clear over an empty edge list, and carries the count the claim was proven over", () => {
		expect(gateOf({_tag: "Read", scanned: 0, open: [], unread: []})).toEqual({
			_tag: "Clear",
			scanned: 0,
		});
	});

	it("is Blocked on a proven open edge, naming EVERY one rather than the first", () => {
		const out = gateOf({_tag: "Read", scanned: 3, open: [210, 212], unread: []});
		expect(out).toEqual({_tag: "Blocked", scanned: 3, open: [210, 212]});
	});

	it("stays Blocked when a blocker could not be read beside a proven open one", () => {
		const out = gateOf({
			_tag: "Read",
			scanned: 2,
			open: [211],
			unread: [{number: 210, reason: "gh: Bad gateway (HTTP 502)"}],
		});
		expect(out).toEqual({_tag: "Blocked", scanned: 2, open: [211]});
	});

	it("is Unknown when nothing is proven open and a blocker could not be read — never Clear", () => {
		const out = gateOf({
			_tag: "Read",
			scanned: 2,
			open: [],
			unread: [
				{number: 210, reason: "gh: Bad gateway (HTTP 502)"},
				{number: 211, reason: "gh: Bad gateway (HTTP 502)"},
			],
		});
		expect(out).toEqual({
			_tag: "Unknown",
			reason: "blocker #210: gh: Bad gateway (HTTP 502); blocker #211: gh: Bad gateway (HTTP 502)",
		});
	});

	it("carries an unreadable edge list straight through as Unknown", () => {
		expect(gateOf({_tag: "Unknown", reason: "gh: Bad gateway (HTTP 502)"})).toEqual({
			_tag: "Unknown",
			reason: "gh: Bad gateway (HTTP 502)",
		});
	});
});
