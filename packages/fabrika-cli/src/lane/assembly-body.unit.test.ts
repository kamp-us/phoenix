/**
 * The tail body's one rule, driven over the four shapes a real assembly body takes — and over the
 * agreement that makes it a guard rather than a second opinion: every body this refuses is one
 * `provenClosure` would later read as partial or as unreadable.
 */
import {describe, expect, it} from "vitest";
import {issueRefsOf} from "../review/classes.ts";
import {tailBodyRead} from "./assembly-body.ts";
import {provenClosure} from "./reconcile.ts";

const EPIC = 4300;

const merged = (body: string) => {
	const refs = issueRefsOf(body);
	return provenClosure(EPIC, [
		{
			number: 9001,
			open: false,
			merged: true,
			linkedIssues: refs.numbers,
			linkKind: refs.kind,
			referencedIssues: refs.referenced,
		},
	]);
};

const CHILDREN = "Fixes #4301\nFixes #4302\n";

describe("tailBodyRead", () => {
	it("reads a body closing the epic beside its children as the run's landing", () => {
		expect(tailBodyRead(`${CHILDREN}Fixes #${EPIC}\n`, EPIC)).toEqual({_tag: "Closes"});
	});

	// Membership, not first match: the epic's own reference sits at an arbitrary position among one
	// closing keyword per landed child, so a scalar reader answers off whichever child leads.
	it("finds the epic's reference wherever it sits among the children's", () => {
		expect(tailBodyRead(`Fixes #4301\nFixes #${EPIC}\nFixes #4302\n`, EPIC)).toEqual({
			_tag: "Closes",
		});
	});

	it("refuses a body that reaches the epic through `Part of`, naming what it read", () => {
		const read = tailBodyRead(`Part of #${EPIC}\n`, EPIC);

		expect(read._tag).toBe("Unclosing");
		expect(read._tag === "Unclosing" && read.read).toContain("Part of");
	});

	it("refuses a body that closes only the children", () => {
		const read = tailBodyRead(CHILDREN, EPIC);

		expect(read._tag).toBe("Unclosing");
		expect(read._tag === "Unclosing" && read.read).toContain("#4301, #4302");
	});

	// The shape `provenClosure` calls out by name: a body carrying both kinds drops every `Part of`
	// number, so the epic is in neither set and the merge answers `unknown` — no `partial` recorded,
	// and the tail folds to `shipped` over an open epic.
	it("refuses a body mixing the children's closings with a `Part of` on the epic", () => {
		expect(tailBodyRead(`${CHILDREN}Part of #${EPIC}\n`, EPIC)._tag).toBe("Unclosing");
	});

	it("refuses a body linking nothing at all", () => {
		expect(tailBodyRead("## Deviations\n\nNone.\n", EPIC)).toEqual({
			_tag: "Unclosing",
			read: "it links no issue at all",
		});
	});
});

describe("the guard and the post-merge reader agree about one body", () => {
	const bodies = [
		`${CHILDREN}Fixes #${EPIC}\n`,
		`Part of #${EPIC}\n`,
		CHILDREN,
		`${CHILDREN}Part of #${EPIC}\n`,
		"## Deviations\n\nNone.\n",
	];

	it("relays exactly the bodies whose merge would prove a closure, and refuses the rest", () => {
		for (const body of bodies) {
			const closure = merged(body);
			const closes = closure._tag === "Read" && closure.closure._tag === "Closes";
			expect(tailBodyRead(body, EPIC)._tag === "Closes").toBe(closes);
		}
	});
});
