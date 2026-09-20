/**
 * @vitest-environment jsdom
 *
 * What an operator sees and reaches on the board: a tile per process, a child inside its parent, an
 * entry animation that respects reduced motion, and one activation the mouse and the keyboard share.
 */

import {render, screen, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import {Option} from "effect";
import {describe, expect, it, vi} from "vitest";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import type {PortDeclaration, TableRow} from "../../table/row.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {ProcessBoard} from "./ProcessBoard.tsx";

installDomShims();

const port: PortDeclaration = {kind: "tuval/title/v1", direction: "out"};

const row = (
	id: string,
	options: {
		readonly programId?: string;
		readonly parent?: string;
		readonly title?: string;
		readonly status?: string;
		readonly ports?: Readonly<Record<string, PortDeclaration>>;
	} = {},
): TableRow => ({
	id: ProcessId.make(id),
	programId: ProgramId.make(options.programId ?? "demo/counter"),
	parentId:
		options.parent === undefined ? Option.none() : Option.some(ProcessId.make(options.parent)),
	ports: options.ports ?? {},
	stateSummary: {lifecycle: "running", revision: 1},
	title: options.title === undefined ? Option.none() : Option.some(options.title),
	status: options.status === undefined ? Option.none() : Option.some(options.status),
});

const board = (rows: ReadonlyArray<TableRow>, reducedMotion = true) => {
	const onOpen = vi.fn();
	const rendered = render(
		<div className="tuval-surface">
			<ProcessBoard rows={rows} onOpen={onOpen} reducedMotion={reducedMotion} />
		</div>,
	);
	return {rendered, onOpen};
};

const tileFor = (processId: string): HTMLElement => {
	const tile = document.querySelector(`[data-process="${processId}"]`);
	if (tile === null) throw new Error(`no tile for ${processId}`);
	return tile as HTMLElement;
};

/** The tile's one control: the row that opens the process. */
const openerFor = (processId: string): HTMLElement => {
	const opener = tileFor(processId).querySelector(".tuval-board-open");
	if (opener === null) throw new Error(`no opener on the tile for ${processId}`);
	return opener as HTMLElement;
};

describe("the process board", () => {
	it("gives every live process a tile, including one whose program declares no port", () => {
		board([row("counter"), row("claude", {programId: "ai/claude", ports: {"title@1": port}})]);
		expect(screen.getAllByRole("button")).toHaveLength(2);
		expect(within(tileFor("counter")).getByText("0 ports")).toBeTruthy();
	});

	it("shows the program id and the lifecycle from the kernel row", () => {
		board([
			row("counter", {programId: "demo/counter", title: "count: 3", ports: {"title@1": port}}),
		]);
		const tile = tileFor("counter");
		expect(tile.querySelector('[data-field="program"]')?.textContent).toBe("demo/counter");
		expect(tile.querySelector('[data-field="state"]')?.textContent).toBe("running");
	});

	// A tile with no title is headed by its program id, so printing it again in the meta row would
	// spend the tile's one strong line on a repeat.
	it("heads a title-less tile with its program id and does not repeat it", () => {
		board([row("counter", {programId: "demo/counter"})]);
		const tile = tileFor("counter");
		expect(tile.querySelector(".tuval-board-tile-heading")?.textContent).toBe("demo/counter");
		expect(tile.querySelector('[data-field="program"]')).toBeNull();
		expect(tile.querySelector('[data-field="state"]')?.textContent).toBe("running");
	});

	it("heads a tile with its title@1 line and shows its status@1 line under it", () => {
		board([
			row("claude", {
				programId: "ai/claude",
				title: "claude · fable · phoenix",
				status: "reading the board",
				ports: {"title@1": port, "status@1": port},
			}),
		]);
		const tile = tileFor("claude");
		expect(tile.textContent).toContain("claude · fable · phoenix");
		expect(tile.querySelector('[data-field="status"]')?.textContent).toBe("reading the board");
	});

	// The base contract and nothing else: a demo counter and an agent are drawn by one path, so
	// swapping the program id changes the words on the tile and never its shape.
	it("draws a demo counter and an agent through the same path", () => {
		board([
			row("counter", {programId: "demo/counter", title: "count: 3", ports: {"title@1": port}}),
			row("claude", {programId: "ai/claude", title: "claude · fable", ports: {"title@1": port}}),
		]);
		const shapeOf = (id: string) =>
			[...tileFor(id).querySelectorAll("[data-field]")].map((node) =>
				node.getAttribute("data-field"),
			);
		expect(shapeOf("counter")).toEqual(shapeOf("claude"));
	});

	it("renders a child inside its parent's tile", () => {
		board([row("parent"), row("child", {parent: "parent"})]);
		const item = tileFor("parent").closest("li");
		expect(item?.querySelector(".tuval-board-children")).toBeTruthy();
		expect(item?.contains(tileFor("child"))).toBe(true);
	});

	it("opens a process when its tile is clicked", async () => {
		const {onOpen} = board([row("counter")]);
		await userEvent.click(openerFor("counter"));
		expect(onOpen).toHaveBeenCalledWith("counter");
	});

	// The keyboard reaches the tile through the handler the mouse calls — the button's own
	// activation — and never through a second copy that could drift.
	it("opens a process from the keyboard, through the same handler", async () => {
		const {onOpen} = board([row("counter"), row("claude", {programId: "ai/claude"})]);
		await userEvent.tab();
		expect(document.activeElement).toBe(openerFor("counter"));
		await userEvent.keyboard("{Enter}");
		await userEvent.tab();
		await userEvent.keyboard(" ");
		expect(onOpen.mock.calls).toEqual([["counter"], ["claude"]]);
	});

	// The desk's one document-level listener would otherwise forward this Enter to the focused
	// window as well, so opening a tile would also type into the chat behind it.
	it("keeps a tile's Enter and Space off the desk's key listener", async () => {
		const heard: Array<string> = [];
		document.addEventListener("keydown", (event) => heard.push(event.key));
		board([row("counter")]);
		await userEvent.tab();
		await userEvent.keyboard("{Enter}");
		await userEvent.keyboard(" ");
		// Escape is the control: it is not the board's key, it reaches the listener, and without it a
		// green here would also be what a listener nobody attached looks like.
		await userEvent.keyboard("{Escape}");
		expect(heard.filter((key) => key !== "Tab")).toEqual(["Escape"]);
	});

	it("marks a newly spawned child as entering, and leaves the first board unmarked", () => {
		const {rendered} = board([row("parent")], false);
		expect(tileFor("parent").getAttribute("data-entering")).toBeNull();
		rendered.rerender(
			<div className="tuval-surface">
				<ProcessBoard
					rows={[row("parent"), row("child", {parent: "parent"})]}
					onOpen={() => undefined}
					reducedMotion={false}
				/>
			</div>,
		);
		expect(tileFor("child").getAttribute("data-entering")).toBe("true");
		expect(tileFor("parent").getAttribute("data-entering")).toBeNull();
	});

	it("marks nothing as entering when the operator asked for no motion", () => {
		const {rendered} = board([row("parent")]);
		rendered.rerender(
			<div className="tuval-surface">
				<ProcessBoard
					rows={[row("parent"), row("child", {parent: "parent"})]}
					onOpen={() => undefined}
					reducedMotion={true}
				/>
			</div>,
		);
		expect(tileFor("child").getAttribute("data-entering")).toBeNull();
	});

	it("draws a designed empty state rather than a void when nothing is running", () => {
		board([]);
		expect(screen.getByText("Nothing is running")).toBeTruthy();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});
});

describe("axe over the board", () => {
	it("reports no violations over a board with a nested child", async () => {
		board([
			row("parent", {
				title: "claude · fable · phoenix",
				status: "reading",
				ports: {"title@1": port},
			}),
			row("child", {parent: "parent"}),
		]);
		const results = await axe.run(
			{include: [[".tuval-board"]]},
			// jsdom paints nothing, so axe cannot measure a ratio; the contrast floor is the design
			// layer's, enforced by `@kampus/design`'s own a11y tier.
			{rules: {"color-contrast": {enabled: false}}},
		);
		expect(results.violations.map((violation) => violation.id)).toEqual([]);
	});
});
