import {assert, describe, it} from "@effect/vitest";
import {composeSubIssueBody, type SubIssueSpec, validateSubIssueSpec} from "./compose.ts";

const wellFormed: SubIssueSpec = {
	stories: "4, 9",
	tdd: "yes",
	containment: "exempt (internal pipeline tooling — no user-facing surface)",
	whatToBuild: "Add a pipeline-cli verb that composes an intake body.",
	acceptanceCriteria: ["A verb emits a format-2 body.", "Consumers cite the verb."],
};

describe("composeSubIssueBody — deterministic format-2 emission (contract §2)", () => {
	it("emits the header block, both sections, and checkbox bullets in order", () => {
		const body = composeSubIssueBody(wellFormed);
		assert.strictEqual(
			body,
			[
				"**Stories:** 4, 9",
				"**TDD:** yes",
				"**Containment:** exempt (internal pipeline tooling — no user-facing surface)",
				"",
				"### What to build",
				"Add a pipeline-cli verb that composes an intake body.",
				"",
				"### Acceptance criteria",
				"- [ ] A verb emits a format-2 body.",
				"- [ ] Consumers cite the verb.",
				"",
			].join("\n"),
		);
	});

	it("is deterministic — same spec, byte-identical output", () => {
		assert.strictEqual(composeSubIssueBody(wellFormed), composeSubIssueBody(wellFormed));
	});

	it("omits the Containment line when no marker is given (missing reads as none)", () => {
		const {containment: _omit, ...rest} = wellFormed;
		const body = composeSubIssueBody(rest);
		assert.notInclude(body, "**Containment:**");
		assert.include(body, "**TDD:** yes\n\n### What to build");
	});

	it("trims trailing whitespace and blank criteria for a stable body", () => {
		const body = composeSubIssueBody({
			...wellFormed,
			whatToBuild: "  spec with padding  ",
			acceptanceCriteria: ["  a  ", "", "   ", "b"],
		});
		assert.include(body, "### What to build\nspec with padding\n");
		assert.include(body, "- [ ] a\n- [ ] b");
		assert.notInclude(body, "- [ ] \n");
	});
});

describe("validateSubIssueSpec — the format-2 invariants (contract §2)", () => {
	it("accepts a well-formed spec", () => {
		assert.deepStrictEqual(validateSubIssueSpec(wellFormed), []);
	});

	it("rejects zero acceptance criteria (the hard floor)", () => {
		const v = validateSubIssueSpec({...wellFormed, acceptanceCriteria: []});
		assert.strictEqual(v.length, 1);
		assert.include(v[0] ?? "", "acceptance criterion");
	});

	it("rejects an all-blank acceptance list (no checkable criterion survives the trim)", () => {
		const v = validateSubIssueSpec({...wellFormed, acceptanceCriteria: ["", "   "]});
		assert.include(v[0] ?? "", "acceptance criterion");
	});

	it("rejects an empty Stories back-reference", () => {
		const v = validateSubIssueSpec({...wellFormed, stories: "   "});
		assert.include(v.join(" "), "Stories");
	});

	it("rejects an empty What to build", () => {
		const v = validateSubIssueSpec({...wellFormed, whatToBuild: ""});
		assert.include(v.join(" "), "What to build");
	});

	it("rejects a non yes|no TDD flag", () => {
		const v = validateSubIssueSpec({...wellFormed, tdd: "maybe" as SubIssueSpec["tdd"]});
		assert.include(v.join(" "), "TDD");
	});
});

// AC3 — the safe body handoff cannot reintroduce the `-f body=@file` leak. The
// composer emits the body BY VALUE, so a caller captures it into `$BODY` and passes
// `-f body="$BODY"`; there is no file path to `@`-reference. This asserts the emitted
// body is pure markdown that carries no machine-local filesystem path — a body a
// filer can post by value with no leak. (These are placeholder path shapes, not real
// paths, so this test file itself stays leak-clean.)
describe("intake-compose body handoff is leak-safe (AC3, #2002 / #754 / PR #1567)", () => {
	it("emits a by-value markdown body carrying no local filesystem path", () => {
		const body = composeSubIssueBody({
			...wellFormed,
			whatToBuild: "Prose that mentions no scratchpad file.",
		});
		assert.match(body, /^\*\*Stories:\*\*/);
		// No `@`-prefixed path and no machine-local absolute-path root leaked into the body.
		assert.notMatch(body, /(^|\s)@[/~]/);
		assert.notMatch(body, /\/(?:tmp|var\/folders|Users|home|private)\//);
	});
});
