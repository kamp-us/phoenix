/**
 * @vitest-environment jsdom
 *
 * What the shared inspector component draws for each of the three arms. The facts themselves are
 * `./detail.unit.test.ts`'s; what this file judges is that every one of them reaches the reader —
 * including the direction of each port as a word, not only as an arrow.
 */

import {cleanup, render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it} from "vitest";
import {ProcessId} from "../../protocol/ids.ts";
import {row} from "../ps/fixtures.ts";
import {processDetail} from "./detail.ts";
import {ProcessDetailView} from "./ProcessDetailView.tsx";

afterEach(cleanup);

const selected = row("child-a1", {
	parent: "root-a",
	program: "shell",
	revision: 12,
	lifecycle: "stopping",
	ports: {
		prompt: {kind: "tuval/prompt", direction: "in"},
		transcript: {kind: "tuval/transcript", direction: "out"},
	},
});

describe("process detail view", () => {
	it("shows the id, program, parent, lifecycle, revision and every port", () => {
		render(<ProcessDetailView detail={processDetail([selected], selected.id)} />);
		expect(screen.getByRole("heading", {name: "child-a1"})).toBeTruthy();
		const text = screen.getByRole("heading", {name: "child-a1"}).parentElement?.textContent ?? "";
		for (const fragment of [
			"shell",
			"root-a",
			"stopping",
			"12",
			"prompt",
			"tuval/prompt",
			"transcript",
			"tuval/transcript",
		]) {
			expect(text).toContain(fragment);
		}
	});

	it("spells each port's direction as a word beside its arrow", () => {
		render(<ProcessDetailView detail={processDetail([selected], selected.id)} />);
		const lines = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
		expect(lines).toEqual(["prompt→ intuval/prompt", "transcript← outtuval/transcript"]);
	});

	it("says a root has no parent rather than leaving the cell blank", () => {
		const root = row("root-a");
		render(<ProcessDetailView detail={processDetail([root], root.id)} />);
		expect(screen.getByText("none — this is a root process")).toBeTruthy();
	});

	it("names the empty state instead of rendering a blank region", () => {
		render(<ProcessDetailView detail={processDetail([selected], null)} />);
		expect(screen.getByRole("status").textContent).toContain("No process selected");
	});

	it("renders the gone state without throwing", () => {
		const gone = ProcessId.make("child-a1");
		expect(() => render(<ProcessDetailView detail={processDetail([], gone)} />)).not.toThrow();
		expect(screen.getByRole("status").textContent).toContain("has left the table");
	});
});
