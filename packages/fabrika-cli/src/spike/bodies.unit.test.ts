import {describe, expect, it} from "vitest";
import type {CommentRecord} from "../io/issues.ts";
import {
	captureComment,
	captureMarker,
	forfeitMarker,
	forfeitNote,
	issueBody,
	newestCapture,
	runTable,
	SPIKE_LABEL,
	spikeTitle,
	TITLE_LIMIT,
	WORKSPACE_MASK,
} from "./bodies.ts";
import {
	evidenceRecord,
	LEAKY_WORKSPACE,
	NONCE,
	ONE_RUN_DIGEST,
	QUESTION,
	WORKSPACE,
} from "./fixtures.test-support.ts";

const comment = (id: number, body: string, createdAt = "2026-08-10T00:00:00Z"): CommentRecord => ({
	id,
	author: "agent",
	createdAt,
	updatedAt: createdAt,
	body,
});

describe("the composed title", () => {
	it("names the question", () => {
		expect(spikeTitle(QUESTION)).toBe(`spike: ${QUESTION}`);
	});

	it("truncates on a character boundary with a trailing ellipsis", () => {
		const title = spikeTitle("é".repeat(400));
		expect([...title]).toHaveLength(TITLE_LIMIT);
		expect(title.endsWith("…")).toBe(true);
	});
});

describe("the issue body carries the nonce and never the workspace path", () => {
	const body = issueBody({question: QUESTION, kind: "logic", nonce: NONCE, ticket: 9140});

	it("holds the four sections", () => {
		expect(body).toContain("## Question");
		expect(body).toContain("## Shape");
		expect(body).toContain("## Run");
		expect(body).toContain("## Came from");
		expect(body).toContain("#9140");
	});

	it("names the nonce and no path (#3086)", () => {
		expect(body).toContain(NONCE);
		expect(body).not.toContain("fabrika-spike");
	});

	it("says standalone when no ticket is given", () => {
		expect(issueBody({question: QUESTION, kind: "ui", nonce: NONCE, ticket: null})).toContain(
			"standalone",
		);
	});

	it("carries no marker — the label and the number are the identity", () => {
		expect(body).not.toContain("<!-- fabrika:spike");
		expect(SPIKE_LABEL).toBe("prototyping:spike");
	});
});

describe("the capture predicate is mechanical", () => {
	const mark = captureMarker(NONCE, ONE_RUN_DIGEST);

	it("recognises this run's marker", () => {
		expect(newestCapture([comment(1, `${mark}\n\n## Decision\n`)], NONCE)?.evidenceDigest).toBe(
			ONE_RUN_DIGEST,
		);
	});

	it("ignores another run's marker", () => {
		expect(
			newestCapture([comment(1, captureMarker("0badf00d", ONE_RUN_DIGEST))], NONCE),
		).toBeNull();
	});

	it("never counts a forfeit marker — otherwise 15 would be bypassable by forfeiting twice", () => {
		expect(newestCapture([comment(1, forfeitMarker(NONCE, 3))], NONCE)).toBeNull();
	});

	it("ignores a marker that is not the comment's first line", () => {
		expect(newestCapture([comment(1, `a note\n${mark}`)], NONCE)).toBeNull();
	});

	it("takes the newest when more than one matches", () => {
		const older = comment(1, captureMarker(NONCE, "a".repeat(64)), "2026-08-10T00:00:00Z");
		const newer = comment(2, mark, "2026-08-10T01:00:00Z");
		expect(newestCapture([newer, older], NONCE)?.commentId).toBe(2);
	});
});

describe("the run table is transcribed, not summarised", () => {
	it("holds one row per recorded run with its command and status", () => {
		const table = runTable([evidenceRecord(1), evidenceRecord(2, {commandExit: 1})], WORKSPACE);
		expect(table).toContain("| 1 | printf no\\n | 0 | false |");
		expect(table).toContain("| 2 | printf no\\n | 1 | false |");
	});

	it("names a timed-out run rather than printing a null exit", () => {
		const table = runTable([evidenceRecord(1, {commandExit: null, timedOut: true})], WORKSPACE);
		expect(table).toContain("timed out");
		expect(table).not.toContain("null");
	});

	it("masks the workspace root out of a transcribed argv rather than carrying it", () => {
		const table = runTable(
			[evidenceRecord(1, {command: ["bash", `${LEAKY_WORKSPACE}/probe.sh`]})],
			LEAKY_WORKSPACE,
		);
		expect(table).toContain(`bash ${WORKSPACE_MASK}/probe.sh`);
		expect(table).not.toContain(LEAKY_WORKSPACE);
	});

	it("masks any other machine-local path in an argv by its class", () => {
		const table = runTable(
			[evidenceRecord(1, {command: ["cat", "/Users/someone/notes.txt"]})],
			LEAKY_WORKSPACE,
		);
		expect(table).toContain("/Users/<redacted>");
		expect(table).not.toContain("someone");
	});
});

describe("the two comments carry their marker on the first line and nothing else", () => {
	it("composes the capture comment", () => {
		const body = captureComment({
			nonce: NONCE,
			evidenceDigest: ONE_RUN_DIGEST,
			decision: "A single-use token needs no new table.",
			records: [evidenceRecord(1)],
			workspace: WORKSPACE,
		});
		expect(body.split("\n")[0]).toBe(captureMarker(NONCE, ONE_RUN_DIGEST));
		expect(body).toContain("## Decision");
		expect(body).toContain("## Runs");
	});

	it("composes the forfeit note from the manifest's question", () => {
		const body = forfeitNote({
			nonce: NONCE,
			question: QUESTION,
			records: [evidenceRecord(1)],
			workspace: WORKSPACE,
		});
		expect(body.split("\n")[0]).toBe(forfeitMarker(NONCE, 1));
		expect(body).toContain("## Abandoned");
		expect(body).toContain(QUESTION);
		expect(body).toContain("No decision was reached");
	});
});
