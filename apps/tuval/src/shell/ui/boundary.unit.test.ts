/**
 * The boundaries this slice keeps, and it is one of the two whose boundaries point *outward*: the
 * logic slices under `src/shell/` forbid React and the DOM (`../picker/boundary.unit.test.ts`,
 * `../core/boundary.unit.test.ts`), and rendering is allowed in the three named by `rendering`
 * below. So the claims here are the inverse ones — nothing outside `ui/` may depend on `ui/`, and
 * the page's one application-level keyboard listener is registered in exactly one file.
 *
 * Every `=` probe below is a claim on the right of an assignment and each was flip-verified — see
 * `.patterns/unconditional-test-assertions.md`, "the type-level sibling".
 */

import {readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {describe, expect, it} from "vitest";
import type {PickerView} from "../picker/index.ts";
import type {ViewState} from "../window/host.ts";
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
 * - `chat` — the shared chat window a program's renderer resolves to (#7604). It is reached through
 *   the renderer registry, not by the desk, so it sits outside the chrome.
 * - `board` — the process board (#8723). `src/page/AttachedDesk.tsx` mounts it beside the desk, not
 *   inside it, and it reads the kernel table directly; under `ui/` the chrome slice would own a
 *   surface the chrome never renders. It imports nothing from `ui/`, so the outward claim below
 *   holds over it unchanged.
 */
const rendering: ReadonlySet<string> = new Set(["ui", "chat", "board"]);

/**
 * The one module of `ui/` the other rendering slice may reach for (#8407). `useForwardedKey` is the
 * renderer's half of the desk's key channel, and the desk is where the channel has to live — the
 * page owns exactly one keyboard listener (#7559) and `WindowHost` stays free of the DOM. So a
 * window renderer outside `ui/` that must hear a key has this door and no other; the desk's own
 * chrome stays as unreachable from `chat/` as it is from every logic slice.
 */
const allowed: ReadonlySet<string> = new Set(["../ui/forwarded-key.tsx"]);

describe("ui boundary", () => {
	it("stores nothing in a window's slot that the slot cannot hold", () => {
		expect(pickerViewFits).toBe(true);
		expect(mountDoesNot).toBe(false);
	});

	it("shows a window through the contract's arms and no fourth", () => {
		expect(mountArms).toEqual(["Bound", "NoRenderer", "ProcessGone", "Empty"]);
	});

	it("is one of the three rendering slices, and React lives in no other one", () => {
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

	it("is depended on by nothing outside itself, bar the one key channel a renderer needs", () => {
		const shell = dirname(import.meta.dirname);
		const offenders = readdirSync(shell, {withFileTypes: true})
			.filter((entry) => entry.isDirectory() && entry.name !== "ui")
			.flatMap((entry) =>
				sourcesIn(join(shell, entry.name)).flatMap(([name, source]) =>
					specifiersOf(source)
						.filter((specifier) => specifier.includes("/ui/") || specifier.startsWith("../ui/"))
						.filter((specifier) => !allowed.has(specifier))
						.map((specifier) => `${entry.name}/${name}: ${specifier}`),
				),
			);
		expect(offenders).toEqual([]);
		// The teeth: the edge below is one named module, not the slice. Anything else in `ui/` is
		// still refused, including from `chat/`.
		expect([...allowed].filter((specifier) => !specifier.endsWith("/forwarded-key.tsx"))).toEqual(
			[],
		);
	});

	it("registers the application-level keyboard listener in exactly one file", () => {
		const listeners = sourcesIn(import.meta.dirname)
			.filter(([, source]) => source.includes('addEventListener("keydown"'))
			.map(([name]) => name);
		expect(listeners).toEqual(["Desk.tsx"]);
	});
});
