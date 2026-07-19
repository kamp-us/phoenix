/**
 * Unit tests for the `split-guard` pure core (#3464): the create-once key that makes the triage
 * split idempotent. IO-free — no `gh` boundary here. The headline invariant is
 * "split runs twice → one child" (the #3462/#3463 double-fire).
 */
import {describe, expect, it} from "@effect/vitest";
import {type ChildRef, findExistingChild, referencesParent, unitKey} from "./split-match.ts";

describe("referencesParent", () => {
	it("matches the canonical `split from #<parent>` back-reference", () => {
		expect(referencesParent("... \n\nsplit from #3461\n", 3461)).toBe(true);
	});

	it("is case- and whitespace-tolerant", () => {
		expect(referencesParent("Split  From   #3461", 3461)).toBe(true);
	});

	it("does not match a different parent, and guards the number boundary", () => {
		expect(referencesParent("split from #3461", 3462)).toBe(false);
		// #3461 must not match when the parent is #346 (prefix boundary).
		expect(referencesParent("split from #3461", 346)).toBe(false);
	});

	it("is false when there is no back-reference", () => {
		expect(referencesParent("a body with no split marker", 3461)).toBe(false);
	});
});

describe("unitKey", () => {
	it("normalizes case, punctuation, and whitespace to a stable slug", () => {
		expect(unitKey("Migrate node:fs call sites to @effect/platform")).toBe(
			unitKey("migrate   node/fs call-sites to @effect/platform"),
		);
	});

	it("keeps genuinely different titles distinct", () => {
		expect(unitKey("Migrate node:fs call sites")).not.toBe(unitKey("Add a moderation backend"));
	});

	it("is empty for an all-punctuation title", () => {
		expect(unitKey("--- !!! ---")).toBe("");
	});
});

describe("findExistingChild — the create-once decision", () => {
	const parent = 3461;
	const proposed =
		"Migrate raw node:fs/os/path call sites in pipeline packages to @effect/platform layers";
	const firstChild: ChildRef = {
		number: 3462,
		title: proposed,
		body: `### What to build\n...\n\nsplit from #${parent}\n`,
	};

	it("returns undefined on the FIRST run (no existing child) — safe to create", () => {
		expect(findExistingChild(parent, proposed, [])).toBeUndefined();
	});

	it("split runs twice → one child: the SECOND run finds the first child and skips the POST", () => {
		// After the first emit, the read-after-write needs-triage queue carries #3462. A second run
		// of the split with the same (parent, title) must resolve to #3462 — never a #3463 twin.
		expect(findExistingChild(parent, proposed, [firstChild])).toBe(3462);
	});

	it("is robust to a body that differs slightly from the first emit (#3464 AC2)", () => {
		// A twin re-emitted with a reworded body still carries `split from #<parent>`; the key is the
		// back-ref + title-slug, not the body text — so byte-different bodies are still deduped.
		const rewordedBody: ChildRef = {
			number: 3462,
			title: proposed,
			body: `Slightly reworded lead paragraph.\n\nsplit from #${parent}`,
		};
		expect(findExistingChild(parent, proposed, [rewordedBody])).toBe(3462);
	});

	it("is robust to a title that differs only in case/whitespace/punctuation", () => {
		const variantTitle: ChildRef = {
			number: 3462,
			title:
				"migrate RAW node:fs / os / path call-sites in pipeline packages to @effect/platform layers",
			body: `split from #${parent}`,
		};
		expect(findExistingChild(parent, proposed, [variantTitle])).toBe(3462);
	});

	it("does NOT collapse a genuinely different sibling of the same parent", () => {
		// A parent legitimately splits into distinct units; a different-unit child must not suppress
		// creation of this one.
		const differentSibling: ChildRef = {
			number: 3470,
			title: "Add a create-once guard to the plan-epic child spawner",
			body: `split from #${parent}`,
		};
		expect(findExistingChild(parent, proposed, [differentSibling])).toBeUndefined();
	});

	it("ignores a same-title child that back-references a DIFFERENT parent", () => {
		const otherParentChild: ChildRef = {
			number: 3480,
			title: proposed,
			body: "split from #9999",
		};
		expect(findExistingChild(parent, proposed, [otherParentChild])).toBeUndefined();
	});

	it("returns the lowest number when several twins already leaked (deterministic survivor)", () => {
		const twinA: ChildRef = {number: 3462, title: proposed, body: `split from #${parent}`};
		const twinB: ChildRef = {number: 3463, title: proposed, body: `split from #${parent}`};
		expect(findExistingChild(parent, proposed, [twinB, twinA])).toBe(3462);
	});

	it("fails open (undefined) on an empty/keyless proposed title rather than a false reuse", () => {
		const keyless: ChildRef = {number: 3462, title: "!!!", body: `split from #${parent}`};
		expect(findExistingChild(parent, "!!!", [keyless])).toBeUndefined();
	});
});
