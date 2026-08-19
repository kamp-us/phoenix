import {describe, expect, it} from "vitest";
import {SHIPPED_CONTAINMENT_VOCABULARY} from "../config/keys/containment-vocabulary.ts";
import {composeChildBody, normalizeChildBody} from "./child-body.ts";
import {childBody} from "./fixtures.test-support.ts";

const compose = (text: string, cycleDoc: "present" | "absent" | "unknown" = "present") =>
	composeChildBody({
		text,
		cycleDoc,
		type: "type:feature",
		vocabulary: SHIPPED_CONTAINMENT_VOCABULARY,
	});

describe("normalizeChildBody", () => {
	it("makes the three field lines consecutive", () => {
		const body = normalizeChildBody(
			"**Stories:** 1\n\n**TDD:** yes\n\n**Containment:** flag\n\n### What to build\n\nx\n\n### Acceptance criteria\n- [ ] y\n",
			"present",
		);
		expect(body.startsWith("**Stories:** 1\n**TDD:** yes\n**Containment:** flag\n\n")).toBe(true);
	});

	it("hugs the acceptance-criteria heading to its first item", () => {
		const body = normalizeChildBody(
			"**TDD:** yes\n\n### Acceptance criteria\n\n\n- [ ] y\n",
			"absent",
		);
		expect(body).toContain("### Acceptance criteria\n- [ ] y");
	});

	it("puts exactly one blank line before each heading and ends in one newline", () => {
		const body = normalizeChildBody(
			"**TDD:** yes\n### What to build\nx\n\n\n### Acceptance criteria\n- [ ] y\n\n\n",
			"absent",
		);
		expect(body).toBe("**TDD:** yes\n\n### What to build\nx\n\n### Acceptance criteria\n- [ ] y\n");
	});

	/**
	 * The field is emitted only when the cycle doc is present. v1's template omitted it while its skill
	 * body required it, so "forgot" and "no cycle doc" became indistinguishable.
	 */
	it("drops the containment line when the repo carries no cycle doc", () => {
		expect(normalizeChildBody(childBody(), "absent")).not.toContain("**Containment:**");
		expect(normalizeChildBody(childBody(), "present")).toContain("**Containment:**");
	});
});

describe("composeChildBody", () => {
	it("composes a conforming body and reports what the readers saw", () => {
		expect(compose(childBody())).toMatchObject({
			_tag: "Composed",
			stories: [1, 2],
			containment: "flag",
			criteria: 1,
		});
	});

	it('reads "none" as an explicit empty story claim', () => {
		expect(compose(childBody({stories: "none"}))).toMatchObject({stories: []});
	});

	/** v1 harvested every digit run, so `1, 3 (see #4021)` silently claimed a story 4021. */
	it("refuses a **Stories:** value that is not bare integers or none", () => {
		expect(compose(childBody({stories: "1, 3 (see #4021)"}))).toEqual({
			_tag: "Bad",
			reason: '**Stories:** value does not conform: "1, 3 (see #4021)" — bare integers or "none".',
		});
	});

	it("refuses a body with no acceptance criteria", () => {
		expect(compose("**TDD:** yes\n\n### What to build\n\nx\n")).toMatchObject({
			reason: expect.stringContaining("acceptance criteria read as absent"),
		});
	});

	it("refuses a heading that reaches for the criteria block and misses", () => {
		expect(compose("**TDD:** yes\n\n### Acceptance criteri\n- [ ] y\n")).toMatchObject({
			reason: expect.stringContaining("acceptance criteria read as malformed"),
		});
	});

	/** The gate's `MISSING_CONTAINMENT` treats `none` exactly as unset, so admitting it authors a defect. */
	it("refuses a type:feature child whose containment is none while the cycle doc is present", () => {
		expect(compose(childBody({containment: "none"}))).toMatchObject({
			reason: expect.stringContaining("needs **Containment:** flag or exempt"),
		});
	});

	it("refuses one whose containment line is missing entirely", () => {
		expect(compose(childBody({containment: null}))).toMatchObject({
			reason: expect.stringContaining("needs **Containment:** flag or exempt"),
		});
	});

	it("asks nothing of containment when the cycle doc is absent", () => {
		expect(compose(childBody({containment: null}), "absent")).toMatchObject({_tag: "Composed"});
	});

	it("asks nothing of containment on a child that is not a type:feature", () => {
		expect(
			composeChildBody({
				text: childBody({containment: null}),
				vocabulary: SHIPPED_CONTAINMENT_VOCABULARY,
				cycleDoc: "present",
				type: "type:chore",
			}),
		).toMatchObject({_tag: "Composed"});
	});

	it("refuses a duplicated field line — the gate refuses it too", () => {
		expect(compose(`**Stories:** 1\n${childBody()}`)).toMatchObject({
			reason: expect.stringContaining("**Stories:** appears 2 times"),
		});
	});
});
