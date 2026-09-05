/**
 * @vitest-environment jsdom
 *
 * The property-based accessibility pass over the `ps` table, in the shape
 * `.patterns/property-based-a11y.md` fixes for `@kampus/design`: `fast-check` generates randomized
 * **valid** inputs, each is rendered in jsdom, and the ADR 0162 pillar-4 invariants that are
 * decidable there are asserted through `axe-core` plus a direct keyboard-focus probe.
 *
 * Only the jsdom-decidable half runs, and for the pattern's own reason: jsdom has no layout engine
 * and applies no CSS, so name and ARIA validity are decidable and contrast and tap-target are not.
 * Asserting either of those here would be a false gate, so they are not asserted at all — the
 * table's sizes and colours are role tokens (`./ps.css`), and a real-browser pass is what could
 * judge them.
 *
 * The harness is this program's, not `packages/design`'s: that one is keyed to the design package's
 * export barrel and its fail-closed coverage test, and `ps` is a program's renderer rather than a
 * primitive. What is shared is the method and the enforced rule set.
 */

import {cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import axe from "axe-core";
import {Effect, Stream} from "effect";
import fc from "fast-check";
import type {ReactElement} from "react";
import {useMemo, useState} from "react";
import {afterEach, describe, expect, it} from "vitest";
import {ProcessId, ProgramId} from "../../protocol/ids.ts";
import type {ProcessRow} from "../../protocol/process-row.ts";
import {type AnyWindowHost, delivered, WindowId} from "../../shell/window/index.ts";
import type {SpellCaller} from "./attach.ts";
import {psColumnOrder} from "./columns.ts";
import {PsTable} from "./PsTable.tsx";
import {PsSourceProvider} from "./source.tsx";
import {applyPsMsg, type PsMsg, type PsState} from "./state.ts";

afterEach(cleanup);

/** The rules that assert an accessible NAME on a control. jsdom-decidable. */
const NAME_RULES = ["button-name", "aria-command-name", "aria-toggle-field-name"];

/** The rules that assert ARIA and role validity, including required attributes and parents. */
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
	"nested-interactive",
	"presentation-role-conflict",
	"td-headers-attr",
	"th-has-data-cells",
	"scope-attr-valid",
];

const axeOptions: axe.RunOptions = {
	runOnly: {type: "rule", values: [...NAME_RULES, ...ARIA_RULES]},
	resultTypes: ["violations"],
};

const noSpells: SpellCaller = {call: () => {}};

function Harness({
	processes,
	initial,
}: {
	readonly processes: ReadonlyArray<ProcessRow>;
	readonly initial: PsState;
}): ReactElement {
	const [state, setState] = useState(initial);
	const id = ProcessId.make("ps-1");
	const host = useMemo<AnyWindowHost>(
		() => ({
			windowId: WindowId.make("window-1"),
			processId: id,
			readProcess: Stream.succeed({
				_tag: "Live" as const,
				processId: id,
				lifecycle: "running" as const,
				revision: 0,
				state,
			}),
			dispatch: (msg: PsMsg) =>
				Effect.sync(() => {
					setState((current) => applyPsMsg(current, msg));
					return delivered;
				}),
			view: () => null,
			setView: () => Effect.void,
		}),
		[state, id],
	);
	return (
		<PsSourceProvider source={{processes, spells: noSpells}}>
			<PsTable host={host} />
		</PsSourceProvider>
	);
}

/** Valid props only: the harness asserts that a correctly-driven table is accessible. */
const idArbitrary = fc.nat({max: 99}).map((n) => `process-${n}`);

const rowsArbitrary = fc
	.uniqueArray(idArbitrary, {minLength: 1, maxLength: 8})
	.chain((ids) =>
		fc.tuple(
			fc.constant(ids),
			fc.array(fc.integer({min: -1, max: ids.length - 1}), {
				minLength: ids.length,
				maxLength: ids.length,
			}),
			fc.array(fc.constantFrom("running" as const, "stopping" as const), {
				minLength: ids.length,
				maxLength: ids.length,
			}),
			fc.array(fc.nat({max: 999}), {minLength: ids.length, maxLength: ids.length}),
		),
	)
	.map(
		([ids, parents, lifecycles, revisions]): ReadonlyArray<ProcessRow> =>
			ids.map((id, index) => {
				// A parent strictly earlier in the list, so a generated table is always a forest.
				const parentIndex = Math.min(parents[index] ?? -1, index - 1);
				return {
					id: ProcessId.make(id),
					programId: ProgramId.make(index % 2 === 0 ? "counter" : "shell"),
					parentId: parentIndex < 0 ? null : ProcessId.make(ids[parentIndex] ?? id),
					ports:
						index % 3 === 0
							? {}
							: {transcript: {kind: "tuval/transcript", direction: "out" as const}},
					stateSummary: {
						lifecycle: lifecycles[index] ?? "running",
						revision: revisions[index] ?? 0,
					},
					recency: index,
				};
			}),
	);

const stateArbitrary = fc.record({
	sortColumn: fc.constantFrom(null, ...psColumnOrder),
	sortDirection: fc.constantFrom("ascending" as const, "descending" as const),
	selectedProcessId: fc.constant(null),
});

const violationsIn = async (root: HTMLElement): Promise<ReadonlyArray<string>> => {
	const results = await axe.run(root, axeOptions);
	return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
};

describe("ps table accessibility", () => {
	it("holds the enforced name and ARIA invariants over randomized valid tables", async () => {
		await fc.assert(
			fc.asyncProperty(rowsArbitrary, stateArbitrary, async (processes, initial) => {
				const view = render(<Harness processes={processes} initial={initial} />);
				const found = await violationsIn(view.container);
				cleanup();
				return found.length === 0;
			}),
			{numRuns: 25},
		);
	});

	it("reports the violations it found when one is planted, so the probe is not vacuous", async () => {
		// A button with no text and no naming attribute: the `button-name` rule's own failure case.
		const view = render(
			<div>
				<button type="button" />
			</div>,
		);
		expect(await violationsIn(view.container)).not.toEqual([]);
	});

	it("keeps every operable control reachable by keyboard", async () => {
		await fc.assert(
			fc.asyncProperty(rowsArbitrary, stateArbitrary, async (processes, initial) => {
				render(<Harness processes={processes} initial={initial} />);
				const table = screen.getByRole("table");
				const headers = within(table).getAllByRole("button");
				for (const control of headers) {
					control.focus();
					if (document.activeElement !== control) {
						cleanup();
						return false;
					}
				}
				const rows = [...(table.querySelector("tbody")?.querySelectorAll("tr") ?? [])];
				// Exactly one row is in the tab order; the rest are reached with the arrow keys.
				const tabbable = rows.filter((element) => element.tabIndex === 0);
				const first = rows[0];
				if (tabbable.length !== 1 || first === undefined) {
					cleanup();
					return false;
				}
				first.focus();
				const reached = document.activeElement === first;
				fireEvent.keyDown(first, {key: "ArrowDown"});
				cleanup();
				return reached;
			}),
			{numRuns: 25},
		);
	});
});
