import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import * as graduateEmitted from "../wire/graduate-emitted.ts";
import {markerTime} from "../wire/grill-marker.ts";
import {
	ALREADY_GRADUATED,
	BAD_SECTIONS,
	CLASSIFIED,
	DECISIONS_STALE,
	NO_TARGET,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import type {DocumentRead} from "./compose-verb.ts";
import {INTAKE_LABEL, runEmit} from "./emit-verb.ts";
import {
	CLEARED_DECISIONS,
	CLEARED_SESSION,
	commentsPayload,
	issueJson,
	REPO,
	SESSION,
	specFor,
} from "./fixtures.test-support.ts";
import {renderFooter, withFooter} from "./spec.ts";
import {digestOfDecisions} from "./trail.ts";

const ISSUE = /^GET .*\/repos\/o\/r\/issues\/9412$/;
const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/9412\/comments\?/;
const PERMISSION = /collaborators\/.*\/permission/;
const LABELS = /^GET .*\/repos\/o\/r\/labels\?/;
const CREATE = /^POST .*\/repos\/o\/r\/issues$/;
const CREATED_ISSUE = /^GET .*\/repos\/o\/r\/issues\/9520$/;
const COMMENT = /^POST .*\/repos\/o\/r\/issues\/9412\/comments$/;

/** A served 200 — every read below asks for JSON and gets a whole single page. */
const served = (body: string): HttpReply => ({status: 200, body});

/** A served 201 — what a create answers. */
const created = (body: string): HttpReply => ({status: 201, body});

const NOW = new Date("2026-08-09T18:36:48.000Z");
const AT = markerTime("2026-08-09T18:36:48Z");
if (AT === null) throw new Error("the fixture stamp did not build");

const SPEC = specFor(CLEARED_DECISIONS);
const SPEC_DIGEST = digestOfDecisions(CLEARED_DECISIONS);
const LANDED = withFooter(
	SPEC,
	renderFooter({source: SESSION, specDigest: SPEC_DIGEST, timestamp: AT}),
);
const TITLE = "Cap moderation weight per topic";

const emit = (
	script: ReadonlyArray<Scripted>,
	spec: DocumentRead = {_tag: "Text", text: SPEC},
	title = TITLE,
) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(
			runEmit({
				source: SESSION,
				specPath: "spec.md",
				spec: Effect.succeed(spec),
				title,
				repo: null,
				env: {CLAUDE_PIPELINE_REPO: REPO},
				now: () => NOW,
			}),
			seams.layer,
		),
	).then((outcome) => ({outcome, seams}));
};

/** The JSON body of the first request matching `pattern`; `""` when none was issued. */
const bodyOf = (seams: ReturnType<typeof fakeSeams>, pattern: RegExp): string =>
	seams.bodies[seams.requests.findIndex((line) => pattern.test(line))] ?? "";

const labelSet = (...names: ReadonlyArray<string>): HttpReply =>
	served(JSON.stringify(names.map((name) => ({name}))));

const healthy = (): ReadonlyArray<Scripted> => [
	[ISSUE, served(issueJson({number: SESSION, labels: ["grilling:session"]}))],
	[COMMENTS, served(commentsPayload([...CLEARED_SESSION]))],
	[PERMISSION, served(JSON.stringify({permission: "write"}))],
	[LABELS, labelSet(INTAKE_LABEL, "type:feature", "p1")],
	[CREATE, created(JSON.stringify({number: 9520, html_url: "https://example.test/issues/9520"}))],
	[
		CREATED_ISSUE,
		served(issueJson({number: 9520, title: TITLE, body: LANDED, labels: [INTAKE_LABEL]})),
	],
	[
		COMMENT,
		created(JSON.stringify({id: 5234567892, html_url: "https://example.test/c/5234567892"})),
	],
];

describe("the whole transaction", () => {
	it("files one issue at status:needs-triage, reads it back, then posts the marker", async () => {
		const {outcome, seams} = await emit(healthy());
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			source: SESSION,
			issue: 9520,
			url: "https://example.test/issues/9520",
			specDigest: SPEC_DIGEST,
			labels: [INTAKE_LABEL],
			marker: 5234567892,
		});
		const filed = seams.requests.findIndex((line) => CREATE.test(line));
		const marker = seams.requests.findIndex((line) => COMMENT.test(line));
		expect(filed).toBeGreaterThanOrEqual(0);
		expect(marker).toBeGreaterThan(filed);
	});

	it("applies exactly one label and no classification of its own", async () => {
		const {seams} = await emit(healthy());
		expect(JSON.parse(bodyOf(seams, CREATE)).labels).toEqual([INTAKE_LABEL]);
	});

	it("posts a marker binding the spec digest and every covered ref", async () => {
		const {seams} = await emit(healthy());
		const posted = JSON.parse(bodyOf(seams, COMMENT)).body as string;
		expect(posted).toContain(`graduate-emitted: #${SESSION} → #9520 @ ${SPEC_DIGEST}`);
		expect(posted).toContain("covers R1.1;R1.2");
		expect(graduateEmitted.read(posted.slice(posted.indexOf("graduate-emitted:")))._tag).toBe(
			"Found",
		);
	});

	it("appends the footer BEFORE the leak scan, so its own bytes are scanned too", async () => {
		const {seams} = await emit(healthy());
		const create = bodyOf(seams, CREATE);
		expect(create).toContain(`spec ${SPEC_DIGEST}`);
		expect(create).toContain("Filed by an agent");
	});
});

describe("the digest is re-derived, never trusted from --spec", () => {
	it("refuses a ref the spec carries that is no longer on the trail", async () => {
		const {outcome} = await emit(healthy(), {
			_tag: "Text",
			text: specFor([
				...CLEARED_DECISIONS,
				{ref: "R9.9", provenance: "ruled", text: "something nobody ruled"},
			]),
		});
		expect(outcome.code).toBe(DECISIONS_STALE);
		expect(outcome.stderr.join("\n")).toContain("R9.9");
		expect(outcome.stdout).toBe("");
	});

	it("refuses a ref whose provenance in the spec is stronger than the trail's", async () => {
		const forged = specFor(
			CLEARED_DECISIONS.map((row) => ({...row, provenance: "ruled" as const})),
		);
		const {outcome} = await emit(healthy(), {_tag: "Text", text: forged});
		expect(outcome.code).toBe(DECISIONS_STALE);
		expect(outcome.stderr.join("\n")).toContain("provenance");
	});

	it("admits a deliberately split spec — a subset of the trail is the remainder's neighbour", async () => {
		const subset = [CLEARED_DECISIONS[1]].filter((row) => row !== undefined);
		const digest = digestOfDecisions(subset);
		const landed = withFooter(
			specFor(subset),
			renderFooter({source: SESSION, specDigest: digest, timestamp: AT}),
		);
		const {outcome} = await emit(
			[
				...healthy().filter(([pattern]) => pattern !== CREATED_ISSUE),
				[
					CREATED_ISSUE,
					served(issueJson({number: 9520, title: TITLE, body: landed, labels: [INTAKE_LABEL]})),
				],
			],
			{_tag: "Text", text: specFor(subset)},
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).specDigest).toBe(digest);
		expect(digest).not.toBe(SPEC_DIGEST);
	});

	it("refuses a second filing of the SAME spec digest", async () => {
		const marker = graduateEmitted.emit({
			source: SESSION,
			emitted: 9520,
			digest: graduateEmitted.specDigest(SPEC_DIGEST) ?? AT_FAIL(),
			covers: ["R1.1", "R1.2"],
			at: AT,
		});
		const {outcome} = await emit([
			[ISSUE, served(issueJson({number: SESSION, labels: ["grilling:session"]}))],
			[once(COMMENTS), served(commentsPayload([...CLEARED_SESSION]))],
			[
				COMMENTS,
				served(
					commentsPayload([...CLEARED_SESSION, {id: 7, author: "acme-founder", body: marker}]),
				),
			],
			[PERMISSION, served(JSON.stringify({permission: "write"}))],
		]);
		expect(outcome.code).toBe(ALREADY_GRADUATED);
		expect(outcome.stderr.join("\n")).toContain("#9520");
		expect(outcome.stderr.join("\n")).toContain("A DIFFERENT subset");
	});
});

describe("the refusals that write nothing", () => {
	it("refuses a spec missing a section", async () => {
		const {outcome, seams} = await emit(healthy(), {_tag: "Text", text: "## Problem\nx\n"});
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(seams.log).toEqual([]);
	});

	it("refuses a hand-edited decisions line rather than skipping it", async () => {
		const {outcome} = await emit(healthy(), {
			_tag: "Text",
			text: SPEC.replace("— **ruled** · R1.2", "(he agreed)"),
		});
		expect(outcome.code).toBe(DECISIONS_STALE);
		expect(outcome.stderr.join("\n")).toContain("machine-rendered");
	});

	it("refuses a repo with no status:needs-triage label", async () => {
		const {outcome} = await emit([
			...healthy().filter(([pattern]) => pattern !== LABELS),
			[LABELS, labelSet("type:feature", "p1")],
		]);
		expect(outcome.code).toBe(NO_TARGET);
		expect(outcome.stderr.join("\n")).toContain("no triage run can find");
	});

	it("refuses a --title that classifies the work — that is triage's seat", async () => {
		const {outcome} = await emit(healthy(), {_tag: "Text", text: SPEC}, "feature: cap the weight");
		expect(outcome.code).toBe(CLASSIFIED);
		expect(outcome.stderr.join("\n")).toContain("ADR 0246");
	});
});

describe("a write whose outcome is unproven", () => {
	it("seats a failed create on 8, naming the repo to check", async () => {
		const {outcome} = await emit([
			...healthy().filter(([pattern]) => pattern !== CREATE),
			[CREATE, {status: 502, body: "{}"}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});

	it("seats a failed marker write on 8, naming the ORPHANED spec a re-run would duplicate", async () => {
		const {outcome} = await emit([
			...healthy().filter(([pattern]) => pattern !== COMMENT),
			[COMMENT, {status: 502, body: "{}"}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("the spec EXISTS but #9412 does not record it");
	});

	it("seats a read-back that does not match on 9, before any marker is written", async () => {
		const {outcome, seams} = await emit([
			...healthy().filter(([pattern]) => pattern !== CREATED_ISSUE),
			[
				CREATED_ISSUE,
				served(issueJson({number: 9520, title: TITLE, body: LANDED, labels: [INTAKE_LABEL, "p1"]})),
			],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(seams.requests.some((line) => COMMENT.test(line))).toBe(false);
	});
});

function AT_FAIL(): never {
	throw new Error("the fixture digest did not build");
}
