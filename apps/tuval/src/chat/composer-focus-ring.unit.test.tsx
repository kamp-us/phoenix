/**
 * @vitest-environment jsdom
 *
 * The composer's focus ring, keyboard-only (#8786). A browser matches `:focus-visible` on a text
 * field for pointer focus too, so the desk's one ring rule paints on a click unless something tells
 * it which input the operator last used — `@kampus/tuval-ui/input-modality` is that something and the desk
 * publishes it on its root.
 *
 * The composer is reached through a real `Desk`, not a bare surface `div`: the attribute is the
 * desk's to write, and a test that wrote it itself would stay green after the wiring came out.
 *
 * jsdom does not resolve `var()` substitution, so the ring is checked by selector match against the
 * gated selector read off the sheet, never by a computed `outline` string.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import type {
	AiAgentSessionMsg,
	AiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {testProcess} from "@kampus/tuval-sdk/kernel/shell/window/fixtures";
import {empty, WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {chatWindow, initialChatView} from "@kampus/tuval-ui/chat";
import {INPUT_MODALITY_ATTRIBUTE} from "@kampus/tuval-ui/input-modality";
import {defaultPrefixTable} from "@kampus/tuval-ui/keys";
import {sessionState} from "@kampus/tuval-ui/testing/chat";
import {installDomShims} from "@kampus/tuval-ui/testing/dom";
import {fireEvent, render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import {createStack, createTree, createWindow} from "../shell/layout/index.ts";
import {Desk} from "../shell/ui/Desk.tsx";
import {deskWith} from "../shell/ui/fixtures.ts";
import type {MountResolver} from "../shell/ui/mount.ts";
import {refused} from "../shell/ui/press.ts";
import {uiSrc} from "./ui-source.testing.ts";

installDomShims();

/**
 * The one rule the desk paints its ring with, read back off the sheet by the first case. The board's
 * overlay is named beside the surface because a `Dialog` portals out of every `.tuval-surface` root
 * (#8867); it is still one rule, which is the law this file holds.
 */
const RING_SELECTOR =
	'.tuval-board-overlay :focus-visible,\n.tuval-surface:not([data-input-modality="pointer"]) :focus-visible';

const deskSheet = (): string =>
	readFileSync(fileURLToPath(import.meta.resolve("../shell/ui/tokens.css")), "utf8");

/** Every stylesheet under one source root, comments stripped — a comment naming a rule is not a rule. */
const sheetsUnder = (src: string, label: string): ReadonlyArray<readonly [string, string]> =>
	readdirSync(src, {recursive: true})
		.filter((name): name is string => typeof name === "string" && name.endsWith(".css"))
		.map((name) => [
			`${label}${name}`,
			readFileSync(join(src, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
		]);

/** Every stylesheet the desk ships: the app's own and `@kampus/tuval-ui`'s. */
const tuvalSheets = (): ReadonlyArray<readonly [string, string]> => [
	...sheetsUnder(join(import.meta.dirname, ".."), ""),
	...sheetsUnder(uiSrc, "@kampus/tuval-ui/"),
];

/** The selector of every rule in the app that declares an `outline`. */
const ringPainters = (): ReadonlyArray<string> =>
	tuvalSheets().flatMap(([name, source]) =>
		source
			.split("}")
			.filter((block) => /(^|;|\{)\s*outline(-offset)?\s*:/.test(block))
			.map((block) => `${name}: ${(block.split("{")[0] ?? "").trim()}`),
	);

const oneWindowDesk = () =>
	deskWith(
		createTree(createStack("stack-root", "horizontal", [createWindow("window-1", "process-1")])),
	);

/** A desk showing the chat window, which is where the composer lives. */
const openDesk = async () => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(
			ProcessId.make("process-1"),
			sessionState(),
		),
	);
	const host = await Effect.runPromise(process.window(WindowId.make("window-1"), initialChatView));
	const renderer = chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined});
	const resolveMount: MountResolver = (_windowId, processId) =>
		processId === null
			? empty
			: {
					_tag: "Bound",
					name: null,
					host,
					render: () => renderer.render(host) as ReactElement,
				};
	const rendered = render(
		<Desk
			state={oneWindowDesk()}
			dispatch={() => undefined}
			press={() => Promise.resolve(refused)}
			resolveMount={resolveMount}
			table={defaultPrefixTable}
		/>,
	);
	await screen.findByRole("log", {name: "Transcript"});
	const root = document.querySelector<HTMLElement>(".tuval-surface");
	const composer = document.querySelector<HTMLTextAreaElement>("textarea");
	if (root === null || composer === null) throw new Error("the desk rendered no composer");
	return {root, composer, unmount: () => rendered.unmount()};
};

const modalityOf = (root: HTMLElement): string | null =>
	root.getAttribute(INPUT_MODALITY_ATTRIBUTE);

/** Does the desk's one ring rule reach this element as the desk currently stands? */
const wearsTheRing = (element: Element): boolean =>
	// The rule's own selector list, newlines and all, is what `querySelectorAll` is handed — so this
	// asks the exact question the sheet answers rather than a re-spelling of it.
	[...document.querySelectorAll(RING_SELECTOR)].includes(element);

describe("the composer's focus ring", () => {
	it("is the desk's one rule, gated on the modality the desk publishes", () => {
		expect(deskSheet()).toMatch(
			/\.tuval-board-overlay :focus-visible,\s*\.tuval-surface:not\(\[data-input-modality="pointer"\]\) :focus-visible \{[^}]*outline: var\(--focus-ring\);[^}]*outline-offset: var\(--focus-ring-offset\);/s,
		);
		// One rule and no second: a component sheet in the app or in `@kampus/tuval-ui` that painted its own ring
		// would be the per-component outline Pillar 4 forbids, and the gate would not reach it.
		expect(ringPainters()).toEqual([`shell/ui/tokens.css: ${RING_SELECTOR}`]);
	});

	it("still reaches a surface that publishes no modality at all", () => {
		// The attaching placeholder, the boot screens and every proof page are `.tuval-surface` roots
		// that are not the desk and mark nothing. The gate may only take a ring off a surface that has
		// seen a click, so those keep the one they had.
		const surface = document.createElement("div");
		surface.className = "tuval-surface";
		const button = document.createElement("button");
		surface.append(button);
		document.body.append(surface);

		button.focus();

		expect(wearsTheRing(button)).toBe(true);
		surface.remove();
	});

	it("is armed on a desk nobody has touched, so the first Tab lands on a ring", async () => {
		const opened = await openDesk();
		expect(modalityOf(opened.root)).toBe("keyboard");
		opened.composer.focus();
		expect(wearsTheRing(opened.composer)).toBe(true);
		opened.unmount();
	});

	it("paints nothing when the operator lands there with the mouse", async () => {
		const opened = await openDesk();
		fireEvent.pointerDown(opened.composer);
		opened.composer.focus();

		expect(modalityOf(opened.root)).toBe("pointer");
		expect(wearsTheRing(opened.composer)).toBe(false);
		opened.unmount();
	});

	it("paints when the operator arrives on a key", async () => {
		const opened = await openDesk();
		fireEvent.pointerDown(opened.composer);
		fireEvent.keyDown(opened.composer, {key: "Tab"});
		opened.composer.focus();

		expect(modalityOf(opened.root)).toBe("keyboard");
		expect(wearsTheRing(opened.composer)).toBe(true);
		opened.unmount();
	});

	it("tracks the last input rather than latching on the first", async () => {
		const opened = await openDesk();
		opened.composer.focus();

		fireEvent.pointerDown(opened.composer);
		expect([modalityOf(opened.root), wearsTheRing(opened.composer)]).toEqual(["pointer", false]);

		fireEvent.keyDown(opened.composer, {key: "a"});
		expect([modalityOf(opened.root), wearsTheRing(opened.composer)]).toEqual(["keyboard", true]);

		fireEvent.pointerDown(opened.composer);
		expect([modalityOf(opened.root), wearsTheRing(opened.composer)]).toEqual(["pointer", false]);
		opened.unmount();
	});

	it("hears a key the composer stops on its way up", async () => {
		const opened = await openDesk();
		fireEvent.pointerDown(opened.composer);
		opened.composer.addEventListener("keydown", (event) => event.stopPropagation());

		fireEvent.keyDown(opened.composer, {key: "Tab"});

		expect(modalityOf(opened.root)).toBe("keyboard");
		opened.unmount();
	});

	it("stays armed when the desk takes focus back from an overlay, which is a keyboard path", async () => {
		const opened = await openDesk();
		fireEvent.keyDown(opened.root, {key: "Escape"});
		opened.root.focus();

		expect(modalityOf(opened.root)).toBe("keyboard");
		opened.unmount();
	});
});
