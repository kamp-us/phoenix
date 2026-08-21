import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import * as buildDeviations from "../wire/build-deviations.ts";
import {
	BAD_SECTIONS,
	CLAIM_NOT_MINE,
	EMPTY_STDIN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {runDeviations} from "./deviations-verb.ts";
import {
	comments,
	GATEWAY,
	GH_TOKEN_ENV,
	LANE_TOKEN,
	LANE_UUID,
	marker,
	NOT_FOUND,
	served,
} from "./fixtures.test-support.ts";

const ISSUE = 6566;

const IS_ISSUE = new RegExp(`^GET https://api\\.github\\.com/repos/o/r/issues/${ISSUE}$`);
const COMMENTS = new RegExp(`GET .*/repos/o/r/issues/${ISSUE}/comments`);
const PERM = /GET .*\/repos\/o\/r\/collaborators\/agent\/permission/;
const USER = /GET .*\/api\.github\.com\/user$/;
const POST = new RegExp(`POST .*/repos/o/r/issues/${ISSUE}/comments`);
const PATCH = /PATCH .*\/repos\/o\/r\/issues\/comments\/(\d+)$/;
const DELETE_ONE = /DELETE .*\/repos\/o\/r\/issues\/comments\/(\d+)$/;
const getComment = (id: number) => new RegExp(`GET .*/repos/o/r/issues/comments/${id}$`);

const WRITE = served({permission: "write"});
const ME = served({login: "agent"});
const CLAIM = {id: 1, body: marker("s-9f2e", LANE_UUID)};

const NONE = "## Deviations\n\nNone.\n";
const FULL = [
	"## Deviations",
	"",
	"- **Scope narrowing** — **Said:** #6566 names the ledger row. **Did:** wrote the row only.",
	"  **Why:** the header is another child's. **Disposition:** stated here.",
	"",
].join("\n");

/** What the format composes for this issue — the bytes the verb must land, byte for byte. */
const composed = (section: string): string => {
	const read = buildDeviations.read(`${buildDeviations.KEY_PREFIX} #${ISSUE}\n\n${section}`);
	if (read._tag !== "Found") throw new Error(`fixture section is not readable: ${read._tag}`);
	return buildDeviations.emit(read.value);
};

const options = {
	issue: ISSUE,
	token: LANE_TOKEN,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e", ...GH_TOKEN_ENV} as Record<
		string,
		string | undefined
	>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: NONE}),
};

const seamsFor = (script: ReadonlyArray<Scripted>) => fakeSeams(script);

/**
 * The comment bytes the one write matching `pattern` carried.
 *
 * `bodies` is aligned with `requests`, and a run's last request is the read-back GET — which carries
 * no body — so the posted bytes are only reachable through the request line that sent them. What
 * that slot holds is the REST envelope, and the disclosure is its `body` field.
 */
const writtenBody = (seams: ReturnType<typeof seamsFor>, pattern: RegExp): string => {
	const at = seams.requests.findIndex((line) => pattern.test(line));
	if (at === -1) return "";
	const envelope: unknown = JSON.parse(seams.bodies[at] ?? "{}");
	return typeof envelope === "object" &&
		envelope !== null &&
		"body" in envelope &&
		typeof envelope.body === "string"
		? envelope.body
		: "";
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(runDeviations({...options, ...overrides}), seamsFor(script).layer),
	);

/** The script for an issue whose comments are `rows` — claim marker included. */
const board = (...rows: ReadonlyArray<{readonly id: number; readonly body: string}>) =>
	[
		[IS_ISSUE, served({number: ISSUE})],
		[COMMENTS, comments(CLAIM, ...rows)],
		[PERM, WRITE],
		[USER, ME],
	] as ReadonlyArray<Scripted>;

describe("runDeviations", () => {
	it("creates the marker when the child carries none", async () => {
		const seams = seamsFor([
			...board(),
			[POST, served({id: 900, html_url: "https://github.com/o/r/issues/6566#c900"}, 201)],
			[getComment(900), served({body: composed(NONE)})],
		]);
		const out = await Effect.runPromise(Effect.provide(runDeviations(options), seams.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "posted",
			issue: ISSUE,
			commentId: 900,
			upsert: "created",
			retracted: 0,
			url: "https://github.com/o/r/issues/6566#c900",
		});
		expect(writtenBody(seams, POST)).toBe(composed(NONE));
	});

	/**
	 * The whole bug (#6691): the repair round's disclosure must REPLACE the first, because
	 * `wire read --format build-deviations` refuses two conforming headings as undecidable — so a
	 * second comment strands the epic's tail review on an UNKNOWN.
	 */
	it("edits the standing marker on a second disclosure, and posts no second comment", async () => {
		const first = seamsFor([
			...board(),
			[POST, served({id: 900, html_url: "https://github.com/o/r/issues/6566#c900"}, 201)],
			[getComment(900), served({body: composed(NONE)})],
		]);
		const opened = await Effect.runPromise(Effect.provide(runDeviations(options), first.layer));
		expect(opened.code).toBe(0);
		const landed = writtenBody(first, POST);

		// The second round reads the board the first round left, not a hand-written stand-in.
		const second = seamsFor([
			...board({id: 900, body: landed}),
			[PATCH, served({id: 900, html_url: "https://github.com/o/r/issues/6566#c900"})],
			[getComment(900), served({body: composed(FULL)})],
			[POST, served({message: "a second comment must never be created"}, 500)],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runDeviations({...options, stdin: Effect.succeed({_tag: "Text", text: FULL})}),
				second.layer,
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			commentId: 900,
			upsert: "edited",
			retracted: 0,
		});
		expect(second.requests.some((line) => POST.test(line))).toBe(false);
		// The second emit's bytes are what the verb read back — the criterion's other half.
		expect(writtenBody(second, PATCH)).toBe(composed(FULL));
	});

	it("retracts a stacked marker a pre-fix lane left, so one comment survives", async () => {
		const seams = seamsFor([
			...board({id: 900, body: composed(NONE)}, {id: 901, body: composed(NONE)}),
			[PATCH, served({id: 901, html_url: "https://github.com/o/r/issues/6566#c901"})],
			[getComment(901), served({body: composed(FULL)})],
			[DELETE_ONE, served({}, 204)],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runDeviations({...options, stdin: Effect.succeed({_tag: "Text", text: FULL})}),
				seams.layer,
			),
		);
		expect(out.code).toBe(0);
		// The NEWEST standing marker is the one edited; the older is deleted.
		expect(JSON.parse(out.stdout)).toMatchObject({commentId: 901, retracted: 1});
		expect(seams.requests.some((line) => /DELETE .*\/issues\/comments\/900$/.test(line))).toBe(
			true,
		);
	});

	it("is UNKNOWN when a superseded marker survives its retraction", async () => {
		const out = await run(
			[
				...board({id: 900, body: composed(NONE)}, {id: 901, body: composed(NONE)}),
				[PATCH, served({id: 901, html_url: "https://github.com/o/r/issues/6566#c901"})],
				[getComment(901), served({body: composed(FULL)})],
				[DELETE_ONE, GATEWAY],
			],
			{stdin: Effect.succeed({_tag: "Text", text: FULL})},
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("900");
	});

	it("never edits another issue's marker, nor a comment this account did not write", async () => {
		const seams = seamsFor([
			...board(
				{id: 800, body: `${buildDeviations.KEY_PREFIX} #6567\n\n${NONE}`},
				{id: 801, body: "quoting build-deviations: #6566 in prose"},
			),
			[POST, served({id: 900, html_url: "https://github.com/o/r/issues/6566#c900"}, 201)],
			[getComment(900), served({body: composed(NONE)})],
		]);
		const out = await Effect.runPromise(Effect.provide(runDeviations(options), seams.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({upsert: "created", retracted: 0});
	});

	it("composes the marker line from the positional, not from stdin", async () => {
		const seams = seamsFor([
			...board(),
			[POST, served({id: 900, html_url: "https://github.com/o/r/issues/6566#c900"}, 201)],
			[getComment(900), served({body: composed(NONE)})],
		]);
		await Effect.runPromise(
			Effect.provide(
				runDeviations({
					...options,
					stdin: Effect.succeed({
						_tag: "Text",
						text: `${buildDeviations.KEY_PREFIX} #1234\n\n${NONE}`,
					}),
				}),
				seams.layer,
			),
		);
		const posted = writtenBody(seams, POST);
		expect(posted.startsWith(`${buildDeviations.KEY_PREFIX} #${ISSUE}`)).toBe(true);
		expect(posted).not.toContain("#1234");
	});

	it("refuses a section that is absent, before anything is written", async () => {
		const seams = seamsFor(board());
		const out = await Effect.runPromise(
			Effect.provide(
				runDeviations({...options, stdin: Effect.succeed({_tag: "Text", text: "no heading here"})}),
				seams.layer,
			),
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(seams.requests).toHaveLength(0);
	});

	it("refuses an entry missing a field, naming the field", async () => {
		const out = await run(board(), {
			stdin: Effect.succeed({_tag: "Text", text: "## Deviations\n\n- **Said:** only this.\n"}),
		});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.join("\n")).toContain("**Did:**");
	});

	it("refuses empty stdin rather than reading it as nothing to disclose", async () => {
		const out = await run(board(), {stdin: Effect.succeed({_tag: "Text", text: "  \n"})});
		expect(out.code).toBe(EMPTY_STDIN);
	});

	it("refuses a pull request — a PR discloses in its body", async () => {
		const out = await run([
			[IS_ISSUE, served({number: ISSUE, pull_request: {url: "…"}})],
			[COMMENTS, comments(CLAIM)],
			[PERM, WRITE],
		]);
		expect(out.code).toBe(OFF_VOCABULARY);
	});

	it("refuses an issue proven absent", async () => {
		const out = await run([[IS_ISSUE, NOT_FOUND]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});

	it("is UNKNOWN when the comment list cannot be read, and writes nothing", async () => {
		const seams = seamsFor([
			[IS_ISSUE, served({number: ISSUE})],
			[COMMENTS, comments(CLAIM)],
			[PERM, WRITE],
			[USER, GATEWAY],
		]);
		const out = await Effect.runPromise(Effect.provide(runDeviations(options), seams.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(seams.requests.some((line) => POST.test(line))).toBe(false);
	});

	it("refuses when this lane does not hold the claim", async () => {
		const out = await run([
			[IS_ISSUE, served({number: ISSUE})],
			[COMMENTS, comments({id: 1, body: marker("other", LANE_UUID)})],
			[PERM, WRITE],
		]);
		expect(out.code).toBe(CLAIM_NOT_MINE);
	});

	it("refuses when the landed comment does not read back as this disclosure", async () => {
		const out = await run([
			...board(),
			[POST, served({id: 900, html_url: "https://github.com/o/r/issues/6566#c900"}, 201)],
			[getComment(900), served({body: "the marker never landed"})],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});
});
