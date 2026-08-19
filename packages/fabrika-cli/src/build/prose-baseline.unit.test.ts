import {describe, expect, it} from "vitest";
import {docLeaks} from "./doc-leaks.ts";
import {introducedLeaks} from "./prose-baseline.ts";

const scan = (text: string) => docLeaks("docs/guide.md", text, []);

describe("introducedLeaks — a defect the base already carried is not this diff's", () => {
	it("keeps nothing when the head only reproduces the base's leaks", () => {
		const text = "the home root reads /Users/account\n";
		expect(introducedLeaks(scan(text), scan(text))).toEqual([]);
	});

	// The whole point: an edit above a defect line shifts its number, so identity cannot use one.
	it("keeps nothing when an inserted paragraph moved the base's leak down the file", () => {
		const base = scan("the home root reads /Users/account\n");
		const head = scan("a new opening paragraph\n\nthe home root reads /Users/account\n");
		expect(head[0]?.line).toBe(3);
		expect(introducedLeaks(base, head)).toEqual([]);
	});

	it("keeps a leak the head added beside one the base already carried", () => {
		const base = scan("the home root reads /Users/account\n");
		const head = scan("the home root reads /Users/account\nthe fork sits at ~/code/x\n");
		expect(introducedLeaks(base, head).map((leak) => leak.matched)).toEqual(["~/code/"]);
	});

	it("counts occurrences, so a third copy of a leak the base held twice still reds", () => {
		const line = "the home root reads /Users/account\n";
		expect(introducedLeaks(scan(line.repeat(2)), scan(line.repeat(3)))).toHaveLength(1);
	});

	it("keeps every leak when the base is empty — a file this diff creates owns all of them", () => {
		const head = scan("/Users/account and ~/code/x\n");
		expect(introducedLeaks([], head)).toEqual(head);
	});

	it("reports in head order, so the defects read against the file they came from", () => {
		const head = scan("~/code/x\n/Users/account\n");
		expect(introducedLeaks([], head).map((leak) => leak.line)).toEqual([1, 2]);
	});
});
