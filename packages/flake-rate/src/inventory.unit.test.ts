import {assert, describe, it} from "@effect/vitest";
import {parseFixedEntries} from "./inventory.ts";

const INVENTORY = `## Inventory

### SSE/DO cold-start 500 on the held live stream

- **Signature:** \`AssertionError: expected 500 to be 200\`
- **Status:** \`fixed\` →
  [#769](https://github.com/kamp-us/phoenix/issues/769) (SSE/DO cold-start), fixed in PR
  [#775](https://github.com/kamp-us/phoenix/pull/775). The fix adds a warm step.

### prependNode live frame dropped under mutation churn

- **Signature:** the held EventSource receives no prependNode frame
- **Status:** \`fixed\` →
  [#711](https://github.com/kamp-us/phoenix/issues/711), fixed in PR
  [#810](https://github.com/kamp-us/phoenix/pull/810). The durable fix is a global pin.
- **Budget note:** may still read BUDGET BLOWN until it ages out.

### report.submit D1 read-after-write staleness

- **Signature:** assertion got false
- **Status:** \`root-cause-filed\` →
  [#713](https://github.com/kamp-us/phoenix/issues/713) (D1 read-after-write).
`;

describe("parseFixedEntries", () => {
	it("extracts every fixed entry with its signature heading and fixing PR", () => {
		const entries = parseFixedEntries(INVENTORY);
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0]?.heading, "SSE/DO cold-start 500 on the held live stream");
		assert.strictEqual(entries[0]?.fixPr, 775);
		assert.strictEqual(entries[1]?.heading, "prependNode live frame dropped under mutation churn");
		assert.strictEqual(entries[1]?.fixPr, 810);
	});

	it("skips a non-fixed entry (root-cause-filed is not discountable)", () => {
		const headings = parseFixedEntries(INVENTORY).map((e) => e.heading);
		assert.notInclude(headings, "report.submit D1 read-after-write staleness");
	});

	it("skips a fixed entry with no resolvable fixing PR (unusable for the time boundary)", () => {
		const md = `### orphan fixed flake

- **Status:** \`fixed\` → made deterministic in a follow-up, no PR linked.
`;
		assert.strictEqual(parseFixedEntries(md).length, 0);
	});

	it("is empty on inventory with no fixed entries", () => {
		const md = `### only quarantined

- **Status:** \`quarantined\` → not yet owned.
`;
		assert.strictEqual(parseFixedEntries(md).length, 0);
	});

	// Behavior-preservation lock for the linear-time regex rewrite (#3341): the
	// hardened ENTRY_HEADING / FIXED_STATUS must accept and reject EXACTLY the same
	// inputs as the old backtracking forms. These pin the tolerant-matching contract
	// the docblocks promise (heading trailing-whitespace trim, casing/colon/backtick
	// slack in the Status field) so a future regex edit can't silently regress it.
	it("trims trailing whitespace off the heading (ENTRY_HEADING linear form)", () => {
		const md = `###   spaced heading with trailing ws   \t

- **Status:** \`fixed\` → fixed in PR [#900](x).
`;
		const entries = parseFixedEntries(md);
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]?.heading, "spaced heading with trailing ws");
		assert.strictEqual(entries[0]?.fixPr, 900);
	});

	it("matches the Status field across casing, colon and backtick slack (FIXED_STATUS linear form)", () => {
		const md = `### no backtick, extra spaces
- **Status** :  fixed  — fixed in PR #101.

### uppercase and colon inside markup
- **STATUS:**: \`fixed\` fixed in PR #102.

### backtick, no colon
- **Status** \`fixed\` PR #103.
`;
		const byHeading = new Map(parseFixedEntries(md).map((e) => [e.heading, e.fixPr]));
		assert.strictEqual(byHeading.get("no backtick, extra spaces"), 101);
		assert.strictEqual(byHeading.get("uppercase and colon inside markup"), 102);
		assert.strictEqual(byHeading.get("backtick, no colon"), 103);
	});
});
