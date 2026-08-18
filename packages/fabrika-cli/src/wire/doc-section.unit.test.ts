/**
 * The extractor's whole answer surface — a found body's exact bytes, the two proven refusals, and
 * the boundaries a future edit could quietly lose: a fence-shadowed heading counting as absent, a
 * deeper subheading staying inside the section while an equal-or-shallower one ends it, and the
 * end-of-document section closing without a terminator. The adapter tier below asserts the codes
 * those answers are seated on, distinct from an artifact that was never seen (`./codes.ts`).
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {ANSWER} from "../verb.ts";
import {ABSENT, ARTIFACT_UNKNOWN, EMPTY_ARTIFACT, MALFORMED} from "./codes.ts";
import {extractSection} from "./doc-section.ts";
import {runDocSection} from "./doc-section-verb.ts";

const DOC = [
	"# contract",
	"",
	"intro prose.",
	"",
	"## build claim",
	"",
	"`won` prints your token.",
	"",
	"### exit codes",
	"",
	"20 means out of focus.",
	"",
	"## build confirm",
	"",
	"re-confirm before every mutation.",
].join("\n");

describe("extractSection", () => {
	it("prints the section body, deeper subheadings included", () => {
		const result = extractSection(DOC, "build claim");
		expect(result).toEqual({
			_tag: "Found",
			body: "`won` prints your token.\n\n### exit codes\n\n20 means out of focus.",
			heading: {level: 2, line: 5},
		});
	});

	it("ends the section at an equal-depth heading, not at a deeper one", () => {
		const result = extractSection(DOC, "build claim");
		if (result._tag !== "Found") throw new Error(result._tag);
		expect(result.body).toContain("### exit codes");
		expect(result.body).not.toContain("build confirm");
	});

	it("ends a shallower-heading section the same way", () => {
		const doc = "## deep\n\ndeep body.\n\n# shallow\n\nnever this.";
		const result = extractSection(doc, "deep");
		if (result._tag !== "Found") throw new Error(result._tag);
		expect(result.body).toBe("deep body.");
	});

	it("closes the end-of-document section at EOF, trailing blanks dropped", () => {
		const result = extractSection(`${DOC}\n\n`, "build confirm");
		expect(result).toEqual({
			_tag: "Found",
			body: "re-confirm before every mutation.",
			heading: {level: 2, line: 13},
		});
	});

	it("refuses an absent heading with a proven reason", () => {
		const result = extractSection(DOC, "build release");
		expect(result._tag).toBe("Absent");
	});

	it("counts a heading occurring only inside a code fence as absent", () => {
		const doc = "## real\n\n```markdown\n## fenced\n\nexample bytes.\n```\n";
		expect(extractSection(doc, "fenced")._tag).toBe("Absent");
	});

	it("does not let a nested shorter fence close a longer one", () => {
		const doc = "## real\n\n````markdown\n```\n## still fenced\n```\n````\n";
		expect(extractSection(doc, "still fenced")._tag).toBe("Absent");
	});

	it("keeps a fenced equal-depth heading from ending the section", () => {
		const doc = "## a\n\nbefore.\n\n```\n## a fenced terminator\n```\n\nafter.\n\n## b\n";
		const result = extractSection(doc, "a");
		if (result._tag !== "Found") throw new Error(result._tag);
		expect(result.body).toBe("before.\n\n```\n## a fenced terminator\n```\n\nafter.");
	});

	it("refuses a duplicated heading, naming every occurrence", () => {
		const doc = "## twice\n\none.\n\n## twice\n\ntwo.\n";
		const result = extractSection(doc, "twice");
		if (result._tag !== "Duplicated") throw new Error(result._tag);
		expect(result.evidence).toBe("line 1, line 5");
	});

	it("matches the flag text against the heading text trimmed of closing hashes", () => {
		const result = extractSection("## closed ##\n\nbody.\n", "closed");
		expect(result._tag).toBe("Found");
	});

	it("matches a backticked heading by its bare name", () => {
		const result = extractSection("## `triage queue`\n\nbody.\n", "triage queue");
		expect(result._tag).toBe("Found");
	});

	it("matches one comma-separated name in a folded heading", () => {
		const doc = "## `build claim`, `build confirm`, `build release`\n\nfolded body.\n";
		const result = extractSection(doc, "build claim");
		if (result._tag !== "Found") throw new Error(result._tag);
		expect(result.body).toBe("folded body.");
	});

	it("still refuses two headings that both carry the name", () => {
		const doc = "## `build claim`\n\none.\n\n## `build claim`, `build release`\n\ntwo.\n";
		expect(extractSection(doc, "build claim")._tag).toBe("Duplicated");
	});
});

const piped = (text: string): Effect.Effect<StdinRead> => Effect.succeed({_tag: "Text", text});
const run = (source: Effect.Effect<StdinRead>, heading = "build claim", json = false) =>
	Effect.runPromise(runDocSection({heading, json, source}));

describe("wire doc-section", () => {
	it("answers the section body on stdout, exit 0", async () => {
		const out = await run(piped(DOC));
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe(
			"`won` prints your token.\n\n### exit codes\n\n20 means out of focus.\n",
		);
	});

	it("answers JSON when asked", async () => {
		const out = await run(piped(DOC), "build confirm", true);
		expect(out.code).toBe(ANSWER);
		expect(JSON.parse(out.stdout)).toEqual({
			heading: "build confirm",
			outcome: "found",
			line: 13,
			body: "re-confirm before every mutation.",
		});
	});

	it("seats absent, duplicated, empty and unseen on four distinct codes", async () => {
		const absent = await run(piped(DOC), "no such section");
		const duplicated = await run(piped("## twice\n\none.\n\n## twice\n\ntwo.\n"), "twice");
		const empty = await run(piped("   \n"));
		const unseen = await run(
			Effect.succeed({_tag: "Failed", reason: "EAGAIN with no data for 30000ms"}),
		);
		expect(absent.code).toBe(ABSENT);
		expect(duplicated.code).toBe(MALFORMED);
		expect(empty.code).toBe(EMPTY_ARTIFACT);
		expect(unseen.code).toBe(ARTIFACT_UNKNOWN);
		expect(new Set([absent.code, duplicated.code, empty.code, unseen.code]).size).toBe(4);
		for (const refusal of [absent, duplicated, empty, unseen]) expect(refusal.stdout).toBe("");
	});
});
