import {render, screen} from "@testing-library/react";
import fc from "fast-check";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {runEnforcedInvariants} from "./a11y/check";
import {Diff} from "./Diff";

// The layout is a prop the library reads inside its shadow root, and jsdom neither lays out nor
// finishes the async highlight — so the only place it is decidable here is at the call.
const seen = vi.hoisted(() => ({calls: [] as Array<Record<string, unknown>>}));

vi.mock("@pierre/diffs/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@pierre/diffs/react")>();
	return {
		...actual,
		FileDiff: (props: Parameters<typeof actual.FileDiff>[0]) => {
			seen.calls.push({...props.options, lang: props.fileDiff.lang});
			return actual.FileDiff(props);
		},
	};
});

/**
 * The rows themselves are drawn by `@pierre/diffs` inside a shadow root, and jsdom applies no CSS
 * and runs no layout — so what a test here can hold is the contract this package owns: the scroller
 * is focusable and named, the layout prop reaches the library, and the markup this component adds
 * carries no axe violation.
 */
const BEFORE = "const a = 1;\nconst b = 2;\n";
const AFTER = "const a = 1;\nconst b = 3;\n";

describe("Diff", () => {
	beforeEach(() => {
		seen.calls = [];
	});

	it("puts the tab stop and the name on the element that scrolls", () => {
		render(<Diff before={BEFORE} after={AFTER} path="src/count.ts" />);

		const region = screen.getByRole("region", {name: /src\/count\.ts/});
		expect(region.tagName).toBe("DIV");
		expect(region.tabIndex).toBe(0);
		expect(region.classList.contains("kp-diff")).toBe(true);
	});

	it("names no individual line, so a screen reader reads the code and not a label per row", () => {
		const {container} = render(<Diff before={BEFORE} after={AFTER} path="src/count.ts" />);

		expect(container.querySelectorAll("[aria-label]").length).toBe(1);
	});

	it("renders unified by default and split on request", () => {
		render(<Diff before={BEFORE} after={AFTER} path="src/count.ts" />);
		expect(seen.calls.at(-1)?.diffStyle).toBe("unified");

		render(<Diff before={BEFORE} after={AFTER} path="src/count.ts" split />);
		expect(seen.calls.at(-1)?.diffStyle).toBe("split");
	});

	it("derives the language from the path's extension", () => {
		render(<Diff before={BEFORE} after={AFTER} path="src/count.ts" />);
		expect(seen.calls.at(-1)?.lang).toBe("typescript");

		render(<Diff before="# a" after="# b" path="docs/notes.md" />);
		expect(seen.calls.at(-1)?.lang).toBe("markdown");
	});

	it("colours through the role-token theme, never a theme of the library's own", () => {
		render(<Diff before={BEFORE} after={AFTER} path="src/count.ts" />);

		expect(seen.calls.at(-1)?.theme).toBe("kampus-role-tokens");
	});

	it("has no axe violations", async () => {
		const {container} = render(<Diff before={BEFORE} after={AFTER} path="src/count.ts" />);

		const violations = await runEnforcedInvariants(container, {
			kind: "presentational",
			arb: fc.constant(<div />),
		});
		expect(violations).toEqual([]);
	});
});
