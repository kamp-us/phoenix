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
});
