/**
 * @vitest-environment jsdom
 *
 * The `ps` table, rendered. The tier is `unit`: every assertion here could be wrong even if every
 * socket behaved perfectly, which is the litmus (`.patterns/effect-testing.md`).
 *
 * The harness runs the shipped reducer (`applyPsMsg`) over dispatched Msgs and feeds the result back
 * through the window contract's own `readProcess`, so a press that sorts leaves the next render
 * actually sorted. Anything that stubbed the reducer would prove the table agrees with a fake.
 *
 * Nothing but a `PsSourceProvider` is wired: no kernel, no socket, no process-table port. That is
 * the "reads `Snapshot.processes` and nothing else" claim, asserted by construction.
 */

import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {Effect, Stream} from "effect";
import type {ReactElement} from "react";
import {useMemo, useState} from "react";
import {afterEach, describe, expect, it} from "vitest";
import {ProcessId} from "../../protocol/ids.ts";
import type {ProcessRow} from "../../protocol/process-row.ts";
import {type AnyWindowHost, delivered, WindowId} from "../../shell/window/index.ts";
import type {SpellCaller} from "./attach.ts";
import {twoRootForest} from "./fixtures.ts";
import {PsTable} from "./PsTable.tsx";
import {PsSourceProvider} from "./source.tsx";
import {applyPsMsg, type PsMsg, type PsState, psInitialState} from "./state.ts";

afterEach(cleanup);

const PS_PROCESS = ProcessId.make("ps-1");

interface Recorded {
	readonly path: ReadonlyArray<string>;
	readonly args: unknown;
}

const recorder = (): SpellCaller & {readonly calls: Array<Recorded>} => {
	const calls: Array<Recorded> = [];
	return {calls, call: (path, args) => void calls.push({path: [...path], args})};
};

interface HarnessProps {
	readonly processes: ReadonlyArray<ProcessRow>;
	readonly spells: SpellCaller;
	readonly initial?: PsState;
}

function Harness({processes, spells, initial = psInitialState}: HarnessProps): ReactElement {
	const [state, setState] = useState(initial);
	const host = useMemo<AnyWindowHost>(
		() => ({
			windowId: WindowId.make("window-1"),
			processId: PS_PROCESS,
			readProcess: Stream.succeed({
				_tag: "Live" as const,
				processId: PS_PROCESS,
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
		[state],
	);
	return (
		<PsSourceProvider source={{processes, spells}}>
			<PsTable host={host} />
		</PsSourceProvider>
	);
}

const mount = (processes: ReadonlyArray<ProcessRow>) => {
	const spells = recorder();
	const view = render(<Harness processes={processes} spells={spells} />);
	return {spells, view};
};

const bodyRows = (): ReadonlyArray<HTMLTableRowElement> => {
	const table = screen.getByRole("table");
	const body = table.querySelector("tbody");
	return [...(body?.querySelectorAll("tr") ?? [])];
};

const renderedIds = (): ReadonlyArray<string> =>
	bodyRows().map((element) => element.getAttribute("data-process-id") ?? "");

const header = (name: string): HTMLElement =>
	within(screen.getByRole("table")).getByRole("button", {name: new RegExp(`^${name}`)});

describe("the ps table", () => {
	it("renders one row per process in the snapshot, with the six named columns", () => {
		mount(twoRootForest);
		expect(
			within(screen.getByRole("table"))
				.getAllByRole("columnheader")
				.map((cell) => cell.textContent?.replace(/[▲▼]/g, "").trim()),
		).toEqual(["Process", "Program", "Parent", "Ports", "Lifecycle", "Revision"]);
		expect(renderedIds()).toHaveLength(twoRootForest.length);
		expect([...renderedIds()].sort()).toEqual(twoRootForest.map((each) => String(each.id)).sort());
	});

	it("shows a process's own facts, port summary included", () => {
		mount(twoRootForest);
		const target = bodyRows().find(
			(element) => element.getAttribute("data-process-id") === "child-a1",
		);
		expect([...(target?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent)).toEqual([
			"child-a1",
			"shell",
			"root-a",
			"3 (tuval/prompt, tuval/transcript)",
			"running",
			"3",
		]);
	});

	it("orders parents before children even though the snapshot arrived shuffled", () => {
		mount(twoRootForest);
		expect(renderedIds()).toEqual([
			"root-a",
			"child-a1",
			"grandchild-a1",
			"child-a2",
			"root-b",
			"child-b1",
		]);
	});

	it("sorts on a header press and flips on the next one, with aria-sort following", async () => {
		mount(twoRootForest);
		fireEvent.click(header("Revision"));
		await waitFor(() => expect(renderedIds()[0]).toBe("root-a"));
		// Three rows share revision 3, and they keep the default order among themselves.
		expect(renderedIds()).toEqual([
			"root-a",
			"child-a1",
			"root-b",
			"child-b1",
			"grandchild-a1",
			"child-a2",
		]);
		expect(header("Revision").closest("th")?.getAttribute("aria-sort")).toBe("ascending");

		fireEvent.click(header("Revision"));
		await waitFor(() =>
			expect(header("Revision").closest("th")?.getAttribute("aria-sort")).toBe("descending"),
		);
		expect(renderedIds()[0]).toBe("child-a2");
	});

	it("sorts from the keyboard alone", async () => {
		mount(twoRootForest);
		const button = header("Program");
		button.focus();
		// Reachable by Tab and activated by Enter or Space because it is a real `<button>`: the
		// activation is the platform's, and jsdom does not synthesise it, so the element's own tag is
		// what this asserts before pressing it.
		expect(document.activeElement).toBe(button);
		expect(button.tagName).toBe("BUTTON");
		expect(button.getAttribute("type")).toBe("button");
		fireEvent.click(button);
		await waitFor(() =>
			expect(header("Program").closest("th")?.getAttribute("aria-sort")).toBe("ascending"),
		);
		expect(renderedIds()[0]).toBe("root-a");
	});

	it("walks rows with the arrow keys and announces the selected one", async () => {
		mount(twoRootForest);
		const first = bodyRows()[0];
		expect(first?.tabIndex).toBe(0);
		first?.focus();
		await waitFor(() => expect(bodyRows()[0]?.getAttribute("aria-current")).toBe("true"));

		fireEvent.keyDown(bodyRows()[0] as HTMLElement, {key: "ArrowDown"});
		await waitFor(() => expect(bodyRows()[1]?.getAttribute("aria-current")).toBe("true"));
		expect(document.activeElement).toBe(bodyRows()[1]);
		expect(bodyRows()[0]?.getAttribute("aria-current")).toBeNull();

		fireEvent.keyDown(bodyRows()[1] as HTMLElement, {key: "End"});
		await waitFor(() => expect(bodyRows()[5]?.getAttribute("aria-current")).toBe("true"));

		fireEvent.keyDown(bodyRows()[5] as HTMLElement, {key: "Home"});
		await waitFor(() => expect(bodyRows()[0]?.getAttribute("aria-current")).toBe("true"));
	});

	it("issues the shell attach call for that row's process on Enter, and nothing else", async () => {
		const {spells} = mount(twoRootForest);
		const target = bodyRows()[1];
		target?.focus();
		await waitFor(() => expect(bodyRows()[1]?.getAttribute("aria-current")).toBe("true"));
		fireEvent.keyDown(bodyRows()[1] as HTMLElement, {key: "Enter"});
		expect(spells.calls).toEqual([
			{path: ["shell", "window", "attach"], args: {process: "child-a1"}},
		]);
	});

	it("clears a stale selection and leaves no blank row when a process leaves the table", async () => {
		const spells = recorder();
		const view = render(<Harness processes={twoRootForest} spells={spells} />);
		bodyRows()[1]?.focus();
		await waitFor(() => expect(bodyRows()[1]?.getAttribute("aria-current")).toBe("true"));

		const remaining = twoRootForest.filter((each) => String(each.id) !== "child-a1");
		view.rerender(<Harness processes={remaining} spells={spells} />);
		await waitFor(() => expect(renderedIds()).not.toContain("child-a1"));
		expect(renderedIds()).toHaveLength(remaining.length);
		expect(bodyRows().map((element) => element.getAttribute("aria-current"))).toEqual(
			bodyRows().map(() => null),
		);
	});

	it("says so rather than drawing an empty table when nothing is running", () => {
		mount([]);
		expect(screen.getByRole("status").textContent).toBe("No processes are running.");
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("has no process facts at all with no snapshot above it", () => {
		render(
			<PsTable
				host={
					{
						windowId: WindowId.make("window-1"),
						processId: PS_PROCESS,
						readProcess: Stream.succeed({
							_tag: "Live" as const,
							processId: PS_PROCESS,
							lifecycle: "running" as const,
							revision: 0,
							state: psInitialState,
						}),
						dispatch: () => Effect.succeed(delivered),
						view: () => null,
						setView: () => Effect.void,
					} as AnyWindowHost
				}
			/>,
		);
		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.getByRole("status").textContent).toContain("no desk snapshot");
	});
});
