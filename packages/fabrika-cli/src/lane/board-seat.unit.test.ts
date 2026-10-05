/** The board seat — what admits a re-boot, and what the placed document declares afterwards. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {roundsOn} from "../build/rounds.ts";
import {
	configAtCommit,
	configOnPlatform,
	fakeFs,
	fakeSeams,
	type HttpReply,
	mergeBaseOnPlatform,
	type Scripted,
} from "../fakes.test-support.ts";
import type {CommentRecord} from "../io/issues.ts";
import {
	adoptionRecord,
	boardSeatReader,
	reviewTrace,
	seatAtReview,
	seatFromProof,
	solePull,
	spendBudget,
	strandedRecord,
} from "./board-seat.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {compileText} from "./machine.ts";

describe("solePull", () => {
	it("takes the one pull request the board hangs off the issue", () => {
		expect(solePull([9430])).toEqual({_tag: "One", pr: 9430});
	});

	it("refuses several, because which one the prior lane drove is not derivable", () => {
		const read = solePull([9430, 9431]);

		expect(read._tag).toBe("Unproven");
		expect(read._tag === "Unproven" && read.why).toContain("#9430, #9431");
	});

	it("refuses an empty set rather than seating a lane on nothing", () => {
		expect(solePull([])._tag).toBe("Unproven");
	});
});

describe("seatFromProof", () => {
	it("seats a proven head, carrying the fold's own note", () => {
		const seat = seatFromProof(9430, "77aa05b", {_tag: "Proven", note: "every namespace answered"});

		expect(seat).toEqual({
			_tag: "Seatable",
			pr: 9430,
			head: "77aa05b",
			note: "every namespace answered",
		});
	});

	it("refuses a standing FAIL as a budget question, not a verdict question", () => {
		const seat = seatFromProof(9430, "77aa05b", {_tag: "Contradicted", what: "#9430 holds a FAIL"});

		expect(seat._tag).toBe("Unproven");
		expect(seat._tag === "Unproven" && seat.why).toContain("how many the prior lane already spent");
	});

	it("refuses an unfinished review with the fold's own words", () => {
		const seat = seatFromProof(9430, "77aa05b", {_tag: "InFlight", what: "#9430 has no verdict"});

		expect(seat).toEqual({_tag: "Unproven", why: "#9430 has no verdict"});
	});
});

describe("spendBudget", () => {
	it("declares the repair budget spent in the document the boot places", () => {
		const spent = spendBudget(coderTemplateText());
		if (spent._tag !== "Spent") throw new Error(`refused: ${spent.reason}`);
		const compiled = compileText(spent.text);
		if (compiled._tag === "Malformed") throw new Error(compiled.defects.join("; "));

		expect(compiled.lane.tasks.issue?.initial.maxRetries).toBe(0);
	});

	it("leaves every other seeded field of the context alone", () => {
		const seeded = JSON.stringify({
			id: "coder",
			machine: {context: {issue: {retries: 0, maxRetries: 3, classes: ["ui"], maxLaps: 16}}},
		});
		const spent = spendBudget(seeded);
		if (spent._tag !== "Spent") throw new Error(`refused: ${spent.reason}`);

		expect(JSON.parse(spent.text)).toMatchObject({
			machine: {context: {issue: {classes: ["ui"], maxLaps: 16, maxRetries: 0}}},
		});
	});

	it("refuses a document with no task to declare it on", () => {
		expect(spendBudget(JSON.stringify({machine: {context: {}}}))._tag).toBe("Unseedable");
	});
});

describe("seatAtReview", () => {
	it("boots the task at review and leaves its declared budget alone", () => {
		const atReview = seatAtReview(coderTemplateText());
		if (atReview._tag !== "AtReview") throw new Error(`refused: ${atReview.reason}`);
		const compiled = compileText(atReview.text);
		if (compiled._tag === "Malformed") throw new Error(compiled.defects.join("; "));
		const template = compileText(coderTemplateText());
		if (template._tag === "Malformed") throw new Error(template.defects.join("; "));

		expect(compiled.lane.tasks.issue?.initial.type).toBe("review");
		expect(compiled.lane.tasks.issue?.initial.maxRetries).toBe(
			template.lane.tasks.issue?.initial.maxRetries,
		);
	});

	it("refuses a region with no review cell to boot in", () => {
		const document = JSON.stringify({
			machine: {
				initial: "pipeline",
				states: {
					pipeline: {
						type: "parallel",
						states: {issue: {initial: "queued", states: {queued: {}, build: {}}}},
					},
				},
			},
		});

		expect(seatAtReview(document)).toMatchObject({_tag: "Unseedable"});
	});

	it("refuses a document with no task region at all", () => {
		expect(seatAtReview(JSON.stringify({machine: {states: {}}}))._tag).toBe("Unseedable");
	});
});

describe("adoptionRecord", () => {
	const verified = (head: string) =>
		({_tag: "Seatable", pr: 9430, head, note: "every namespace answered"}) as const;
	const unreviewed = (head: string) => ({_tag: "Unreviewed", pr: 9430, head}) as const;

	it("names the pull request and the head the admission stood on", () => {
		const body = adoptionRecord(9435, verified("77aa05b8544ce06708376dcc8d57d15e2045324f"));

		expect(body).toContain("<!-- fabrika-lane-from-board issue=9435 pr=9430");
		expect(body).toContain("#9430");
		expect(body).toContain("77aa05b8544ce06708376dcc8d57d15e2045324f");
	});

	it("states the seated budget, which is the fact a gitignored ledger cannot show a reader", () => {
		expect(adoptionRecord(9435, verified("77aa05b"))).toContain("no repair budget");
	});

	it("names no filesystem path, because a board artifact carrying one is a leak", () => {
		expect(adoptionRecord(9435, verified("77aa05b"))).not.toContain("/");
		expect(adoptionRecord(9435, unreviewed("77aa05b"))).not.toContain("/");
	});

	it("says an unreviewed seat found no verdict and carries its declared budget, in its own words", () => {
		const body = adoptionRecord(9435, unreviewed("77aa05b8544ce06708376dcc8d57d15e2045324f"));

		expect(body).toContain("<!-- fabrika-lane-from-board issue=9435 pr=9430");
		expect(body).toContain("seat=unreviewed");
		expect(body).toContain("#9430");
		expect(body).toContain("77aa05b8544ce06708376dcc8d57d15e2045324f");
		expect(body).toContain("no verdict was found");
		expect(body).toContain("repair budget its template declares");
		expect(body).not.toContain("no repair budget");
		expect(body).not.toContain("human:budget-spent");
	});
});

const HEAD = "03135b9188d2be6c0a4b7bd0b7a3ff9c53f0f2b1";
const OLD = "8f1c2ad4e5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0";

const verdict = (polarity: "PASS" | "FAIL", sha: string = HEAD): string =>
	`review-code: ${polarity} @ ${sha} — the reviewer's clause`;
const route = (sha: string = HEAD): string =>
	`routed-elsewhere: review-ui @ ${sha} — nothing under apps/site/src renders differently`;
const advisory = (sha: string = HEAD): string =>
	`review-code: advisory — merge stays human-gated\n\nReviewed-head: @ ${sha}\n`;

const comment = (id: number, body: string): CommentRecord => ({
	id,
	author: "agent",
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-01T00:00:00Z",
	body,
});

describe("reviewTrace", () => {
	it("reads a pull request whose comments carry no carrier as unreviewed, at zero rounds", () => {
		const comments = [comment(1, "Thanks — taking a look later."), comment(2, "Fixes #9435")];

		expect(reviewTrace(comments)).toEqual({_tag: "Unreviewed"});
		expect(reviewTrace([])).toEqual({_tag: "Unreviewed"});
		expect(roundsOn(comments)).toBe(0);
	});

	it("reads each of the three carriers as a review, naming the comment and its kind", () => {
		expect(reviewTrace([comment(1, "hi"), comment(7, verdict("PASS"))])).toEqual({
			_tag: "Reviewed",
			comment: 7,
			kind: "verdict marker",
		});
		expect(reviewTrace([comment(8, route())])).toEqual({
			_tag: "Reviewed",
			comment: 8,
			kind: "routed-elsewhere record",
		});
		expect(reviewTrace([comment(9, advisory())])).toEqual({
			_tag: "Reviewed",
			comment: 9,
			kind: "control-plane advisory",
		});
	});

	it("reads a standing FAIL as a review — the one a repair round is counted from", () => {
		const comments = [comment(3, verdict("FAIL"))];

		expect(reviewTrace(comments)._tag).toBe("Reviewed");
		expect(roundsOn(comments)).toBe(1);
	});

	it("reads a stale verdict as a review, whatever head it graded", () => {
		expect(reviewTrace([comment(4, verdict("PASS", OLD))])._tag).toBe("Reviewed");
		expect(reviewTrace([comment(5, route(OLD))])._tag).toBe("Reviewed");
		expect(reviewTrace([comment(6, advisory(OLD))])._tag).toBe("Reviewed");
	});

	it("reads a carrier that drifted as a review, never as the full budget an unreviewed seat gets", () => {
		expect(reviewTrace([comment(10, "review-code: PASSED with no head")])._tag).toBe("Reviewed");
		expect(reviewTrace([comment(11, "routed-elsewhere: review-ui no head")])._tag).toBe("Reviewed");
	});
});

describe("boardSeatReader", () => {
	const PULL = /^GET .*\/repos\/o\/r\/pulls\/4318$/;
	const FILES = /^GET .*\/repos\/o\/r\/pulls\/4318\/files\?/;
	const PR_COMMENTS = /^GET .*\/repos\/o\/r\/issues\/4318\/comments\?/;
	const ISSUE_COMMENTS = /^GET .*\/repos\/o\/r\/issues\/5747\/comments\?/;
	const CODEOWNERS = /^GET \S+\/repos\/o\/r\/contents\/\.github\/CODEOWNERS\?ref=main$/;
	const served = (payload: unknown): HttpReply => ({status: 200, body: JSON.stringify(payload)});
	const GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

	const pull = (overrides: Record<string, unknown> = {}): HttpReply =>
		served({
			number: 4318,
			state: "open",
			head: {sha: HEAD},
			base: {ref: "main"},
			body: "Fixes #5747\n\n## Deviations\nNone.\n",
			changed_files: 1,
			comments: 1,
			merged: false,
			...overrides,
		});
	const comments = (...bodies: ReadonlyArray<string>): HttpReply =>
		served(
			bodies.map((body, index) => ({
				id: index + 1,
				body,
				user: {login: "agent"},
				created_at: "2026-10-01T00:00:00Z",
				updated_at: "2026-10-01T00:00:00Z",
			})),
		);
	/** The reads past the unreviewed one: no ruling on the issue, one code file, no class config. */
	const verifiedBar: ReadonlyArray<Scripted> = [
		[ISSUE_COMMENTS, served([])],
		[FILES, served([{filename: "packages/fabrika-cli/src/lane/prove.ts"}])],
		mergeBaseOnPlatform("b".repeat(40)),
		...configOnPlatform(null),
		...configAtCommit(null),
	];

	const seat = (script: ReadonlyArray<Scripted>, pulls: ReadonlyArray<number> = [4318]) =>
		Effect.runPromise(
			Effect.provide(
				boardSeatReader(null, {CLAUDE_PIPELINE_REPO: "o/r"})(5747, pulls),
				Layer.mergeAll(fakeFs({files: {}}).layer, fakeSeams(script).layer),
			),
		);

	it("seats an open pull request no review has touched, on its own head", async () => {
		const read = await seat([
			[PULL, pull()],
			[PR_COMMENTS, comments("Fixes #5747 — opened by hand")],
		]);

		expect(read).toEqual({_tag: "Unreviewed", pr: 4318, head: HEAD});
	});

	it("still seats a verified pull request at today's bar", async () => {
		const read = await seat([
			[PULL, pull()],
			[PR_COMMENTS, comments(verdict("PASS"))],
			...verifiedBar,
		]);

		expect(read._tag).toBe("Seatable");
	});

	it("holds a pull request carrying a stale verdict to the verified bar, and refuses it there", async () => {
		const read = await seat([
			[PULL, pull()],
			[PR_COMMENTS, comments(verdict("PASS", OLD))],
			...verifiedBar,
		]);

		expect(read._tag).toBe("Unproven");
		expect(read._tag === "Unproven" && read.why).toContain("comment 1 carries a verdict marker");
	});

	it("refuses a standing FAIL as a budget question, never as an unreviewed seat", async () => {
		const read = await seat([
			[PULL, pull()],
			[PR_COMMENTS, comments(verdict("FAIL"))],
			...verifiedBar,
		]);

		expect(read._tag).toBe("Unproven");
		expect(read._tag === "Unproven" && read.why).toContain("a repair round is owed");
	});

	it("refuses a pull request whose only trace is a routed-elsewhere record", async () => {
		const read = await seat([[PULL, pull()], [PR_COMMENTS, comments(route())], ...verifiedBar]);

		expect(read._tag).toBe("Unproven");
		expect(read._tag === "Unproven" && read.why).toContain("routed-elsewhere record");
	});

	it("refuses a pull request whose only trace is a control-plane advisory the diff does not admit", async () => {
		const read = await seat([
			[PULL, pull()],
			[PR_COMMENTS, comments(advisory())],
			[CODEOWNERS, {status: 200, body: "/claude-plugins/ @acme/control-plane\n"}],
			...verifiedBar,
		]);

		expect(read._tag).toBe("Unproven");
		expect(read._tag === "Unproven" && read.why).toContain("control-plane advisory");
	});

	it("reads an unreadable comment list as UNKNOWN, never as unreviewed", async () => {
		const read = await seat([
			[PULL, pull()],
			[PR_COMMENTS, GATEWAY],
		]);

		expect(read._tag).toBe("Unknown");
		expect(read._tag === "Unknown" && read.reason).toContain('never "unreviewed"');
	});

	it("reads an unreadable pull request as UNKNOWN", async () => {
		expect((await seat([[PULL, GATEWAY]]))._tag).toBe("Unknown");
	});

	it("refuses several pull requests before reading any of them", async () => {
		const read = await seat([], [4318, 4319]);

		expect(read._tag).toBe("Unproven");
		expect(read._tag === "Unproven" && read.why).toContain("#4318, #4319");
	});

	it("refuses a merged or closed pull request, however bare its comments", async () => {
		const merged = await seat([
			[PULL, pull({state: "closed", merged: true})],
			[PR_COMMENTS, comments()],
		]);
		const closed = await seat([
			[PULL, pull({state: "closed"})],
			[PR_COMMENTS, comments()],
		]);

		expect(merged._tag === "Unproven" && merged.why).toContain("merged");
		expect(closed._tag === "Unproven" && closed.why).toContain("closed");
	});
});

describe("strandedRecord", () => {
	it("says nothing where no record was written, so an ordinary refusal reads unchanged", () => {
		expect(strandedRecord(null)).toEqual([]);
	});

	it("names the record and that a re-run posts a second one, because nothing retracts it", () => {
		const [sentence] = strandedRecord("https://example.invalid/c/1");

		expect(sentence).toContain("https://example.invalid/c/1");
		expect(sentence).toContain("a lane that was not booted");
		expect(sentence).toContain("second record");
	});
});
