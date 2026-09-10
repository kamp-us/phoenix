/**
 * @vitest-environment jsdom
 *
 * The board overlay's focus ring, proven by inheritance rather than by selector text (#8867).
 *
 * `Dialog` mounts through a zag `Portal` into `document.body`, so the overlay is a sibling of the
 * desk's `.tuval-surface` root and inherits nothing from it. While the ring tokens were declared on
 * that root, `outline: var(--focus-ring)` inside the overlay resolved against an undefined custom
 * property — invalid at computed-value time, which unsets `outline` in the author origin and beats
 * the UA's own `:focus-visible` ring. A keyboard operator tabbing the tiles saw nothing, and every
 * assertion in the tree passed, because each of them read the rule's text.
 *
 * jsdom resolves no `var()`, so the two halves of the sheet are read off disk and put to the live
 * tree instead: the rule that paints the ring has to match the focused tile, and that tile has to
 * have a self-or-ancestor matching the rule that declares the tokens the paint spends. A ring
 * painted out of a root the element cannot reach fails the second half — which is the exact defect,
 * and the one thing a selector-text assertion cannot see.
 */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {render, screen} from "@testing-library/react";
import {Option} from "effect";
import {describe, expect, it} from "vitest";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import type {TableRow} from "../../table/row.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {ProcessBoardOverlay} from "./ProcessBoardOverlay.tsx";

installDomShims();

/** The desk's sheet with its comments stripped: a comment naming a rule is not a rule. */
const deskSheet = (): string =>
	readFileSync(fileURLToPath(import.meta.resolve("../ui/tokens.css")), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		"",
	);

/** The selector list of every rule in the desk's sheet whose declarations match `declaration`. */
const selectorsDeclaring = (declaration: RegExp): ReadonlyArray<string> =>
	deskSheet()
		.split("}")
		.flatMap((block) => {
			const [selector, declarations] = block.split("{");
			if (selector === undefined || declarations === undefined) return [];
			return declaration.test(declarations) ? [selector.trim()] : [];
		});

/** Where the ring tokens are declared, and where the ring is painted from them. */
const ringDeclarers = (): ReadonlyArray<string> => selectorsDeclaring(/--focus-ring\s*:/);
const ringPainters = (): ReadonlyArray<string> =>
	selectorsDeclaring(/outline\s*:\s*var\(--focus-ring\)/);

const row = (id: string): TableRow => ({
	id: ProcessId.make(id),
	programId: ProgramId.make("demo/counter"),
	parentId: Option.none(),
	ports: {},
	stateSummary: {lifecycle: "running", revision: 1},
	title: Option.none(),
	status: Option.none(),
});

/** The overlay as the page mounts it: open, inside a desk root the portal will leave behind. */
const openOverlay = () => {
	const rendered = render(
		<div className="tuval-surface">
			<ProcessBoardOverlay
				open
				onClose={() => undefined}
				rows={[row("counter")]}
				onOpen={() => undefined}
				reducedMotion
			/>
		</div>,
	);
	const opener = document.querySelector<HTMLElement>('[data-process="counter"] .tuval-board-open');
	if (opener === null) throw new Error("the overlay drew no tile to focus");
	return {opener, unmount: () => rendered.unmount()};
};

describe("the board overlay's focus ring", () => {
	it("is painted out of a root the portaled overlay can inherit from", async () => {
		const opened = openOverlay();
		await screen.findByRole("dialog", {name: "Processes"});

		opened.opener.focus();

		// The rule reaches the tile...
		expect([...document.querySelectorAll(ringPainters().join(","))]).toContain(opened.opener);
		// ...and the tokens it spends are declared somewhere the tile inherits from. Both halves, or
		// the outline computes to its initial value and takes the UA's ring down with it.
		expect(opened.opener.closest(ringDeclarers().join(","))).not.toBeNull();
		opened.unmount();
	});

	it("leaves the overlay outside every `.tuval-surface` root, which is why the first case matters", async () => {
		const opened = openOverlay();
		const dialog = await screen.findByRole("dialog", {name: "Processes"});

		expect(dialog.closest(".tuval-surface")).toBeNull();
		expect(opened.opener.closest(".tuval-surface")).toBeNull();
		opened.unmount();
	});
});
