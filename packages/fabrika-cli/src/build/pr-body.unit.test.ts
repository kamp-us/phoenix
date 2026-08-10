import {describe, expect, it} from "vitest";
import {bodyDefect, classificationIn, hasDeviations, proseOf} from "./pr-body.ts";

const body = (extra: string) => `Fixes #4312\n\nsome prose.\n${extra}\n## Deviations\n\nNone.\n`;

describe("the Deviations section blocks, and 'None.' counts", () => {
	it("accepts a section with content", () => {
		expect(hasDeviations("## Deviations\nNone.\n")).toBe(true);
	});

	it("refuses a missing section", () => {
		expect(hasDeviations("Fixes #4312\n")).toBe(false);
	});

	it("refuses a section whose only content is the next heading — silence is not content (#4542)", () => {
		expect(hasDeviations("## Deviations\n\n## Testing\nran it\n")).toBe(false);
	});
});

describe("the closing keyword", () => {
	it("accepts exactly one aimed at this PR's issue", () => {
		expect(bodyDefect(body(""), 4312, false)).toBeNull();
	});

	it("refuses a stray keyword aimed elsewhere — the #4471 auto-close", () => {
		expect(bodyDefect(`${body("")}\nAlso closes #999.\n`, 4312, false)).toEqual({
			_tag: "StrayClosing",
			target: 999,
		});
	});

	it("refuses a body with no link at all", () => {
		expect(bodyDefect("## Deviations\nNone.\n", 4312, false)).toEqual({_tag: "NoLink"});
	});

	it("refuses a duplicated keyword aimed at the same issue", () => {
		expect(bodyDefect(`${body("")}\nfixes #4312 again\n`, 4312, false)).toEqual({
			_tag: "DuplicateClosing",
		});
	});

	it("refuses an auto-close under --partial, and accepts Part of instead", () => {
		expect(bodyDefect(body(""), 4312, true)).toEqual({_tag: "ClosesWhilePartial", target: 4312});
		expect(bodyDefect("Part of #4312\n\n## Deviations\nNone.\n", 4312, true)).toBeNull();
	});

	it("puts the Deviations refusal ahead of the link refusal when both are wrong", () => {
		expect(bodyDefect("no link, no section", 4312, false)).toEqual({_tag: "NoDeviations"});
	});
});

describe("the classification guard reads prose only", () => {
	it("catches a control-plane claim in either polarity (#4153)", () => {
		expect(classificationIn("this is not control-plane")).toBe("control-plane");
		expect(classificationIn("Control Plane: yes")).toBe("control-plane");
	});

	it("catches a type and a standalone priority assertion", () => {
		expect(classificationIn("this lands as type:chore")).toBe("type");
		expect(classificationIn("priority is p0 here")).toBe("priority");
	});

	it("passes a body that merely quotes one inside a fence or a block quote", () => {
		expect(classificationIn(proseOf("```\nnot control-plane\n```\nplain prose\n"))).toBeNull();
		expect(classificationIn(proseOf("> the reviewer said type:bug\n\nplain prose\n"))).toBeNull();
	});

	it("passes an ordinary body", () => {
		expect(classificationIn("Editor focus now survives a save.")).toBeNull();
	});
});
