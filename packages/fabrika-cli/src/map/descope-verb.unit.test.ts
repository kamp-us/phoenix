import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {renderOutOfScope, spliceSection} from "./body.ts";
import {ALREADY_DESCOPED, BAD_SECTIONS, DIGEST_STALE, TICKET_UNKNOWN} from "./codes.ts";
import {runDescope} from "./descope-verb.ts";
import {
	commentsJson,
	digestFor,
	issueJson,
	MAP,
	MAP_BODY,
	MAP_BODY_WITH_REJECTION,
	NONCE,
	parsed,
	REPO,
	TICKET,
} from "./fixtures.test-support.ts";
import {composeTicketMarker} from "./markers.ts";

const PERMISSION = /collaborators\/.*\/permission/;
const CHILDREN = /issues\/9140\/sub_issues/;
const TICKET_COMMENTS = /issues\/9142\/comments/;
const POST_TICKET = /--method POST repos\/o\/r\/issues\/9142\/comments/;
const EDGES = /issues\/9142\/dependencies\//;
const TICKET_ISSUE = /issues\/9142$/;
const MAP_ISSUE = /issues\/9140$/;
const PATCH_MAP = /--method PATCH repos\/o\/r\/issues\/9140/;
const PATCH_TICKET = /--method PATCH repos\/o\/r\/issues\/9142/;

const REASON = "reason.md";
const DIRECTION = "a per-topic weight multiplier";
const WHY = "it makes every moderation action's authority unreadable without a topic lookup";

const options = {
	map: MAP,
	digest: digestFor(MAP_BODY),
	direction: DIRECTION,
	reason: REASON,
	ticket: null as number | null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: REPO},
	now: () => new Date("2026-08-10T00:00:00Z"),
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	over: Partial<typeof options> = {},
	files: Readonly<Record<string, string | null>> = {[REASON]: `${WHY}\n`},
) =>
	Effect.runPromise(
		Effect.provide(
			runDescope({...options, ...over}),
			Layer.merge(fakeShell(script).layer, fakeFs({files}).layer),
		),
	);

const appended = spliceSection(
	parsed(MAP_BODY),
	"Out of scope",
	renderOutOfScope({direction: DIRECTION, reason: WHY, recordedAt: "2026-08-10"}),
);

const mapOk = (body = MAP_BODY) =>
	[MAP_ISSUE, okOut(issueJson({number: MAP, body, labels: ["wayfinding:map"]}))] as const;

describe("runDescope", () => {
	it("exits 4 on an empty reason — an entry with none is one the next session re-proposes", async () => {
		const out = await run([], {}, {[REASON]: "  \n"});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
	});

	it("exits 12 when the body moved since --digest", async () => {
		const out = await run([mapOk()], {digest: "000000000000"});
		expect(out.code).toBe(DIGEST_STALE);
		expect(out.stdout).toBe("");
	});

	it("exits 19 when this direction is already out of scope — the recorded reasoning stands", async () => {
		const out = await run([mapOk(MAP_BODY_WITH_REJECTION)], {
			digest: digestFor(MAP_BODY_WITH_REJECTION),
		});
		expect(out.code).toBe(ALREADY_DESCOPED);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("nothing was written");
	});

	it("exits 13 when --ticket is not a frontier ticket of this map", async () => {
		const out = await run(
			[
				[PERMISSION, okOut("write")],
				[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
				[
					TICKET_COMMENTS,
					okOut(
						commentsJson([
							{id: 1, body: composeTicketMarker({map: MAP, kind: "research", nonce: NONCE})},
						]),
					),
				],
				[EDGES, okOut("[]")],
				[TICKET_ISSUE, okOut(issueJson({number: TICKET}))],
				mapOk(),
			],
			{ticket: 9999},
		);
		expect(out.code).toBe(TICKET_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 0 and reports the section's new size, which only ever grows", async () => {
		const out = await run([
			[PATCH_MAP, okOut("{}")],
			[
				once(MAP_ISSUE),
				okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, okOut(issueJson({number: MAP, body: appended, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({map: MAP, direction: DIRECTION, entries: 1});
	});

	it("appends rather than rewriting — every prior entry survives byte-identically", async () => {
		const priorParsed = parsed(MAP_BODY_WITH_REJECTION);
		const twoEntries = spliceSection(
			priorParsed,
			"Out of scope",
			[
				...priorParsed.outOfScope.map(renderOutOfScope),
				renderOutOfScope({
					direction: "importing the old forum's reputation score",
					reason: "the old score counted post volume",
					recordedAt: "2026-08-10",
				}),
			].join("\n"),
		);
		const shell = fakeShell([
			[PATCH_MAP, okOut("{}")],
			[
				once(MAP_ISSUE),
				okOut(issueJson({number: MAP, body: MAP_BODY_WITH_REJECTION, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, okOut(issueJson({number: MAP, body: twoEntries, labels: ["wayfinding:map"]}))],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runDescope({
					...options,
					digest: digestFor(MAP_BODY_WITH_REJECTION),
					direction: "importing the old forum's reputation score",
				}),
				Layer.merge(
					shell.layer,
					fakeFs({files: {[REASON]: "the old score counted post volume\n"}}).layer,
				),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).entries).toBe(2);
		const patch = shell.calls.find((line) => line.includes("PATCH")) ?? "";
		expect(patch).toContain("a per-topic weight multiplier");
	});

	it("retires the named ticket off the frontier and closes it", async () => {
		const retired = spliceSection(parsed(appended), "Frontier", "");
		const shell = fakeShell([
			[POST_TICKET, okOut('{"id":3,"html_url":"u"}')],
			[PATCH_TICKET, okOut("{}")],
			[PATCH_MAP, okOut("{}")],
			[PERMISSION, okOut("write")],
			[CHILDREN, okOut(`[{"number":${TICKET}}]`)],
			[
				TICKET_COMMENTS,
				okOut(
					commentsJson([
						{id: 1, body: composeTicketMarker({map: MAP, kind: "research", nonce: NONCE})},
					]),
				),
			],
			[EDGES, okOut("[]")],
			[TICKET_ISSUE, okOut(issueJson({number: TICKET}))],
			[
				once(MAP_ISSUE),
				okOut(issueJson({number: MAP, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
			[MAP_ISSUE, okOut(issueJson({number: MAP, body: retired, labels: ["wayfinding:map"]}))],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runDescope({...options, ticket: TICKET}),
				Layer.merge(shell.layer, fakeFs({files: {[REASON]: `${WHY}\n`}}).layer),
			),
		);
		expect(out.code).toBe(0);
		expect(shell.calls.some((line) => line.includes("map-retired:"))).toBe(true);
		expect(shell.calls.some((line) => line.includes("state_reason=completed"))).toBe(true);
	});
});
