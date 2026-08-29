/** The machine-versus-board judgement — #7024's wrong-template lane, as a total function. */
import {describe, expect, it} from "vitest";
import {judgeShape, originOf} from "./shape.ts";

describe("originOf", () => {
	it("reads an emitted document's epic off its id", () => {
		expect(originOf("epic-5979")).toEqual({_tag: "Generated", epic: 5979});
	});

	it("reads every other id as the committed template it names", () => {
		expect(originOf("coder")).toEqual({_tag: "Booted", template: "coder"});
		expect(originOf("chore")).toEqual({_tag: "Booted", template: "chore"});
	});

	it("does not read an epic-shaped prefix as an emitted machine", () => {
		expect(originOf("epic-planner")).toEqual({_tag: "Booted", template: "epic-planner"});
	});
});

describe("judgeShape", () => {
	it("names the mismatch when an epic runs a booted template", () => {
		const verdict = judgeShape(
			5979,
			{_tag: "Booted", template: "coder"},
			{
				_tag: "Epic",
				children: 6,
			},
		);

		expect(verdict._tag).toBe("Mismatched");
		if (verdict._tag !== "Mismatched") return;
		expect(verdict.reason).toContain("6 sub-issue link(s)");
		expect(verdict.reason).toContain('"coder"');
	});

	it("names the mismatch when an epic with no children yet runs a booted template", () => {
		const verdict = judgeShape(
			5979,
			{_tag: "Booted", template: "coder"},
			{
				_tag: "Epic",
				children: 0,
			},
		);

		expect(verdict._tag).toBe("Mismatched");
		if (verdict._tag !== "Mismatched") return;
		expect(verdict.reason).toContain("no plan");
		expect(verdict.reason).not.toContain("0 sub-issue link(s)");
	});

	it("matches an epic running the machine emitted for it", () => {
		expect(judgeShape(5979, {_tag: "Generated", epic: 5979}, {_tag: "Epic", children: 6})).toEqual({
			_tag: "Matches",
		});
	});

	it("flags a lane running the machine emitted for a different epic", () => {
		const verdict = judgeShape(
			5979,
			{_tag: "Generated", epic: 5680},
			{
				_tag: "Epic",
				children: 6,
			},
		);

		expect(verdict).toMatchObject({_tag: "Mismatched"});
		if (verdict._tag !== "Mismatched") return;
		expect(verdict.reason).toContain("#5680");
	});

	it("matches a childless issue on a booted template", () => {
		expect(judgeShape(42, {_tag: "Booted", template: "coder"}, {_tag: "Single"})).toEqual({
			_tag: "Matches",
		});
	});

	it("flags an emitted machine on an issue the board says has no children", () => {
		const verdict = judgeShape(42, {_tag: "Generated", epic: 42}, {_tag: "Single"});

		expect(verdict).toMatchObject({_tag: "Mismatched"});
		if (verdict._tag !== "Mismatched") return;
		expect(verdict.reason).toContain("no sub-issue links");
	});
});
