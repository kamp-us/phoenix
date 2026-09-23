/**
 * The boundaries this slice keeps, and it is one of the two whose boundaries point *outward*: the
 * logic slices under `src/shell/` forbid React and the DOM (`../picker/boundary.unit.test.ts`,
 * `../core/boundary.unit.test.ts`), and rendering is allowed in the two named by `rendering`
 * below. So the claims here are the inverse ones — nothing outside `ui/` may depend on `ui/`, and
 * the page's one application-level keyboard listener is registered in exactly one file.
 *
 * Every `=` probe below is a claim on the right of an assignment and each was flip-verified — see
 * `.patterns/unconditional-test-assertions.md`, "the type-level sibling".
 */

import {readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import type {ViewState} from "@kampus/tuval-sdk/kernel/shell/window/host";
import {describe, expect, it} from "vitest";
import type {PickerView} from "../picker/index.ts";
import type {WindowMount} from "./mount.ts";

type FitsTheSlot<V> = V extends ViewState ? true : false;
type Arms<M> = M extends {readonly _tag: infer T} ? T : never;

/** What `PickerView` reads back out of the slot still fits it — the surface writes nothing wider. */
const pickerViewFits: FitsTheSlot<PickerView> = true;
const mountDoesNot: FitsTheSlot<WindowMount> = false;

/** The mount arms are the window contract's three plus the one the surface adds, and no more. */
const mountArms: Arms<WindowMount>[] = ["Bound", "NoRenderer", "ProcessGone", "Empty"];

const sourcesIn = (dir: string): ReadonlyArray<readonly [string, string]> =>
	readdirSync(dir)
		.filter((name) => /\.(ts|tsx)$/.test(name) && !/\.unit\.test\./.test(name))
		.map((name) => [name, readFileSync(join(dir, name), "utf8")] as const);

const specifiersOf = (source: string): ReadonlyArray<string> =>
	[...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

/**
 * The slices under `src/shell/` that render. A new one is a decision, not a drift, so each entry
 * names the surface it is and why it could not live inside `ui/`.
 *
 * - `ui` — the desk itself, the page's chrome and its one keyboard listener.
 * - `board` — the process board (#8723). `src/page/AttachedDesk.tsx` mounts it beside the desk, not
 *   inside it, and it reads the kernel table directly; under `ui/` the chrome slice would own a
 *   surface the chrome never renders. It imports nothing from `ui/`, so the outward claim below
 *   holds over it unchanged.
 */
const rendering: ReadonlySet<string> = new Set(["ui", "board"]);

describe("ui boundary", () => {
	it("stores nothing in a window's slot that the slot cannot hold", () => {
		expect(pickerViewFits).toBe(true);
		expect(mountDoesNot).toBe(false);
	});

	it("shows a window through the contract's arms and no fourth", () => {
		expect(mountArms).toEqual(["Bound", "NoRenderer", "ProcessGone", "Empty"]);
	});

	it("is one of the two rendering slices, and React lives in no other one", () => {
		const shell = dirname(import.meta.dirname);
		const offenders = readdirSync(shell, {withFileTypes: true})
			.filter((entry) => entry.isDirectory() && !rendering.has(entry.name))
			.flatMap((entry) =>
				sourcesIn(join(shell, entry.name)).flatMap(([name, source]) =>
					specifiersOf(source)
						.filter((specifier) => /^react/.test(specifier))
						.map((specifier) => `${entry.name}/${name}: ${specifier}`),
				),
			);
		expect(offenders).toEqual([]);
	});

	it("is depended on by nothing outside itself", () => {
		const shell = dirname(import.meta.dirname);
		const offenders = readdirSync(shell, {withFileTypes: true})
			.filter((entry) => entry.isDirectory() && entry.name !== "ui")
			.flatMap((entry) =>
				sourcesIn(join(shell, entry.name)).flatMap(([name, source]) =>
					specifiersOf(source)
						.filter((specifier) => specifier.includes("/ui/") || specifier.startsWith("../ui/"))
						.map((specifier) => `${entry.name}/${name}: ${specifier}`),
				),
			);
		expect(offenders).toEqual([]);
	});

	it("registers the application-level keyboard listener in exactly one file", () => {
		const listeners = sourcesIn(import.meta.dirname)
			.filter(([, source]) => source.includes('addEventListener("keydown"'))
			.map(([name]) => name);
		expect(listeners).toEqual(["Desk.tsx"]);
	});
});
