/**
 * The membership of the local-tree set, asserted against the ruling that named it.
 *
 * A data test over the shipped registry, not over a copy of it: the ruling names seven members and
 * three non-members by hand, and the rest are classified by the predicate. If a later port drops a
 * named member out of the set — or lets a board-reading guard into it — a builder's `build check`
 * silently stops predicting a CI gate, which is the failure the record exists to close.
 */

import {describe, expect, it} from "vitest";
import {localTreeGuards} from "./command.ts";

const names = localTreeGuards.map((guard) => guard.name);

describe("the local-tree guard set", () => {
	it("holds every member the ruling names", () => {
		for (const name of [
			"portability-guard",
			"patch-guard",
			"catalog-guard",
			"readme-guard",
			"fanout-guard",
			"i18n-guard",
			"decisions-index",
		]) {
			expect(names).toContain(name);
		}
	});

	// The predicate's whole warrant: a builder can run the set offline against the tree in front of
	// them. A guard needing a PR number, a board read or a credential has nothing to say there.
	it("holds no guard that needs a pull request, the board or a credential", () => {
		for (const name of [
			"unresolved-threads-guard",
			"homing-guard",
			"pitch-guard",
			"roadmap-guard",
		]) {
			expect(names).not.toContain(name);
		}
	});

	it("holds no guard that takes operands — leak-guard scans the files it is handed", () => {
		expect(names).not.toContain("leak-guard");
	});

	it("invokes each member under its own leaf, which is not always `check`", () => {
		expect(localTreeGuards.find((guard) => guard.name === "decisions-index")?.leaf).toBe(
			"validate",
		);
	});

	it("names each member once", () => {
		expect(new Set(names).size).toBe(names.length);
	});
});
