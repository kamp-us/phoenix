/**
 * @vitest-environment jsdom
 *
 * The property-based accessibility pass over the desk inspector, in the shape
 * `.patterns/property-based-a11y.md` fixes: `fast-check` generates randomized **valid** inputs, each
 * is rendered in jsdom, and the ADR 0162 pillar-4 invariants decidable there are asserted through
 * `axe-core`. It is the sibling of `../ps/a11y.unit.test.tsx`, and it covers the inspector for the
 * same reason: this is the surface a screen-reader user reads a process's detail from, so a
 * regression here is the feature failing rather than a primitive drifting.
 *
 * Only the jsdom-decidable half runs. jsdom has no layout engine and applies no CSS, so name and
 * ARIA validity are decidable while contrast and tap-target are not; asserting either of those here
 * would be a false gate, so they are not asserted at all — the panel's sizes and colours are role
 * tokens (`./process-detail.css`), and a real-browser pass is what could judge them. The probe
 * carries a planted violation it must report, so a rule set that silently matches nothing cannot
 * pass.
 */

import {cleanup, render} from "@testing-library/react";
import axe from "axe-core";
import fc from "fast-check";
import {afterEach, describe, expect, it} from "vitest";
import {ProcessId, ProgramId} from "../../protocol/ids.ts";
import type {ProcessRow} from "../../protocol/process-row.ts";
import type {ProcessDetail} from "./detail.ts";
import {processDetail} from "./detail.ts";
import {ProcessDetailView} from "./ProcessDetailView.tsx";

afterEach(cleanup);

/** The rules that assert an accessible NAME on a control. jsdom-decidable. */
const NAME_RULES = ["button-name", "aria-command-name", "aria-toggle-field-name"];

/** The rules that assert ARIA, role and list validity, including required children and parents. */
const ARIA_RULES = [
	"aria-allowed-attr",
	"aria-allowed-role",
	"aria-required-attr",
	"aria-required-children",
	"aria-required-parent",
	"aria-roles",
	"aria-valid-attr",
	"aria-valid-attr-value",
	"aria-hidden-focus",
	"aria-prohibited-attr",
	"definition-list",
	"dlitem",
	"list",
	"listitem",
	"empty-heading",
	"heading-order",
	"nested-interactive",
	"presentation-role-conflict",
];

const axeOptions: axe.RunOptions = {
	runOnly: {type: "rule", values: [...NAME_RULES, ...ARIA_RULES]},
	resultTypes: ["violations"],
};

const portsArbitrary = fc.dictionary(
	fc.stringMatching(/^[a-z][a-z-]{0,11}$/),
	fc.record({
		kind: fc.constantFrom("tuval/transcript", "tuval/prompt", "tuval/cancel"),
		direction: fc.constantFrom("in" as const, "out" as const),
	}),
	{maxKeys: 4},
);

/** Valid rows only: the harness asserts that a correctly-driven panel is accessible. */
const rowArbitrary: fc.Arbitrary<ProcessRow> = fc
	.record({
		id: fc.stringMatching(/^process-[0-9]{1,3}$/),
		program: fc.constantFrom("counter", "shell", "engine-view", "ps"),
		parent: fc.option(fc.stringMatching(/^process-[0-9]{1,3}$/), {nil: null}),
		ports: portsArbitrary,
		lifecycle: fc.constantFrom("running" as const, "stopping" as const),
		revision: fc.nat({max: 999}),
	})
	.map((fields) => ({
		id: ProcessId.make(fields.id),
		programId: ProgramId.make(fields.program),
		parentId: fields.parent === null ? null : ProcessId.make(fields.parent),
		ports: fields.ports,
		stateSummary: {lifecycle: fields.lifecycle, revision: fields.revision},
		recency: 0,
	}));

/** One arbitrary over all three arms, so no arm of the component escapes the pass. */
const detailArbitrary: fc.Arbitrary<ProcessDetail> = fc.oneof(
	rowArbitrary.map((row) => processDetail([row], row.id)),
	rowArbitrary.map((row) => processDetail([row], null)),
	rowArbitrary.map((row) => processDetail([], row.id)),
);

const violationsIn = async (root: HTMLElement): Promise<ReadonlyArray<string>> => {
	const results = await axe.run(root, axeOptions);
	return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
};

describe("desk inspector accessibility", () => {
	it("holds the enforced name and ARIA invariants over randomized valid details", async () => {
		await fc.assert(
			fc.asyncProperty(detailArbitrary, async (detail) => {
				const view = render(<ProcessDetailView detail={detail} />);
				const found = await violationsIn(view.container);
				cleanup();
				return found.length === 0;
			}),
			{numRuns: 30},
		);
	});

	it("reports the violations it found when one is planted, so the probe is not vacuous", async () => {
		// A `<dd>` with no `<dl>` parent: the `dlitem` rule's own failure case.
		const view = render(
			<div>
				<dd>orphan</dd>
			</div>,
		);
		expect(await violationsIn(view.container)).not.toEqual([]);
	});
});
