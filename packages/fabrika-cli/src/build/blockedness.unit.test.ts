import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {gateOf, readBlockedness} from "./blockedness.ts";
import {GATEWAY, issuePayload, NOT_FOUND, served} from "./fixtures.test-support.ts";

const EDGES = /GET .*\/repos\/o\/r\/issues\/4312\/dependencies\/blocked_by/;
const BLOCKER = (n: number) => new RegExp(`GET .*/repos/o/r/issues/${n}$`);

/** What `existenceOf` and the paged read both name a served 502. */
const UNREADABLE = "GitHub answered HTTP 502";

const edges = (...numbers: ReadonlyArray<number>): HttpReply =>
	served(numbers.map((number) => ({number, state: "open"})));

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(Effect.provide(readBlockedness("o/r", 4312), fakeSeams(script).layer));

describe("readBlockedness", () => {
	it("proves not-blocked over an empty edge list, and says how many it scanned", async () => {
		expect(await run([[EDGES, edges()]])).toEqual({_tag: "Read", scanned: 0, open: [], unread: []});
	});

	it("counts an open blocker, and leaves a closed one out", async () => {
		const out = await run([
			[EDGES, edges(210, 211)],
			[BLOCKER(210), served(issuePayload({number: 210, state: "closed"}))],
			[BLOCKER(211), served(issuePayload({number: 211, state: "open"}))],
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
			[BLOCKER(211), served(issuePayload({number: 211, state: "open"}))],
		]);
		expect(out).toEqual({
			_tag: "Read",
			scanned: 2,
			open: [211],
			unread: [{number: 210, reason: UNREADABLE}],
		});
	});

	it("is Unknown when the edge list could not be read — never an empty list", async () => {
		expect(await run([[EDGES, GATEWAY]])).toEqual({_tag: "Unknown", reason: UNREADABLE});
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
			unread: [{number: 210, reason: UNREADABLE}],
		});
		expect(out).toEqual({_tag: "Blocked", scanned: 2, open: [211]});
	});

	it("is Unknown when nothing is proven open and a blocker could not be read — never Clear", () => {
		const out = gateOf({
			_tag: "Read",
			scanned: 2,
			open: [],
			unread: [
				{number: 210, reason: UNREADABLE},
				{number: 211, reason: UNREADABLE},
			],
		});
		expect(out).toEqual({
			_tag: "Unknown",
			reason: `blocker #210: ${UNREADABLE}; blocker #211: ${UNREADABLE}`,
		});
	});

	it("carries an unreadable edge list straight through as Unknown", () => {
		expect(gateOf({_tag: "Unknown", reason: UNREADABLE})).toEqual({
			_tag: "Unknown",
			reason: UNREADABLE,
		});
	});
});
