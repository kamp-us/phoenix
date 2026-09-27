/**
 * @vitest-environment jsdom
 *
 * "Open project…" by keyboard alone (#9697): the program list ends on it, its two steps list the
 * recent projects and then a folder browser, a choice opens through the port the page answers with
 * the `project open` spell, and an already open project is landed on instead of opened twice. One
 * listbox holds DOM focus from the first key to the last, which is what "focus managed across the
 * steps" means here.
 */

import {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {type ForwardedKey, ForwardedKeyProvider} from "@kampus/tuval-ui/forwarded-key";
import {installDomShims} from "@kampus/tuval-ui/testing/dom";
import {act, render, waitFor} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {useState} from "react";
import {describe, expect, it} from "vitest";
import type {FolderListing, RecentProjectRow} from "../../projects/open-project-wire.ts";
import type {ShellMsg} from "../core/index.ts";
import {
	asPickerView,
	mountPicker,
	offerEntries,
	type PickerEntries,
	type PickerView as PickerViewState,
	type ProjectOpener,
	ProjectOpenerFailure,
} from "../picker/browser.ts";
import {programId} from "../picker/fixtures.ts";
import {PickerView} from "./PickerView.tsx";

installDomShims();

const windowId = WindowId.make("window-1");

const PHOENIX: RecentProjectRow = {
	folder: "/work/phoenix",
	name: "phoenix",
	key: "-work-phoenix",
	open: true,
};
const DEMLIK: RecentProjectRow = {
	folder: "/work/demlik",
	name: "demlik",
	key: "-work-demlik",
	open: false,
};

const listing = (folder: string, folders: ReadonlyArray<string>): FolderListing => ({
	folder,
	name: folder.split("/").at(-1) ?? folder,
	key: folder.replaceAll("/", "-"),
	parent: folder === "/work" ? {folder: "/", name: "/"} : {folder: "/work", name: "work"},
	open: false,
	folders: folders.map((name) => ({
		name,
		folder: `${folder}/${name}`,
		hasConfig: name === "tea",
		open: false,
	})),
});

/** The picker offers a Claude session in phoenix, the one project open before any step runs. */
const entries = (projects: ReadonlyArray<{key: string; label: string}>): PickerEntries => ({
	programs: offerEntries(
		[{programId: programId("claude-session"), label: "Claude", folderAtStart: true}],
		projects,
	),
	processes: [],
});

interface Kernel {
	readonly opener: ProjectOpener;
	readonly opened: Array<string>;
}

const kernel = (options: {readonly refuseOpen?: string} = {}): Kernel => {
	const opened: Array<string> = [];
	return {
		opened,
		opener: {
			recent: Effect.succeed([PHOENIX, DEMLIK]),
			browse: (folder) =>
				folder === "/work/locked"
					? Effect.fail(new ProjectOpenerFailure({reason: "permission denied"}))
					: Effect.succeed(
							folder === null || folder === "/work"
								? listing("/work", ["locked", "tea"])
								: listing(folder, []),
						),
			open: (folder) =>
				Effect.suspend(() => {
					opened.push(folder);
					return options.refuseOpen === undefined
						? Effect.succeed({
								folder,
								name: folder.split("/").at(-1) ?? folder,
								key: folder.replaceAll("/", "-"),
							})
						: Effect.fail(new ProjectOpenerFailure({reason: options.refuseOpen}));
				}),
		},
	};
};

function Stage(props: {
	readonly opener: ProjectOpener;
	readonly entries: PickerEntries;
	readonly forwarded: ForwardedKey | null;
}): ReactElement {
	const [view, setView] = useState<PickerViewState>(mountPicker);
	const dispatch = (msg: ShellMsg): void => {
		if (msg.type === "window.setView") setView(asPickerView(msg.view));
	};
	return (
		<ForwardedKeyProvider value={props.forwarded}>
			<PickerView
				windowId={windowId}
				entries={props.entries}
				view={view}
				dispatch={dispatch}
				reducedMotion={true}
				focused={true}
				opener={props.opener}
			/>
		</ForwardedKeyProvider>
	);
}

const stage = (at: Kernel, offered = entries([{key: PHOENIX.key, label: "phoenix"}])) => {
	let seq = 0;
	let current = offered;
	const result = render(<Stage opener={at.opener} entries={current} forwarded={null} />);
	const listbox = () => {
		const node = result.container.querySelector('[role="listbox"]');
		if (node === null) throw new Error("the picker rendered no listbox");
		return node;
	};
	const active = () => {
		const id = listbox().getAttribute("aria-activedescendant");
		return id === null
			? null
			: result.container.querySelector(`[id="${id}"]`)?.getAttribute("aria-label");
	};
	const press = (key: string) => {
		seq += 1;
		act(() => {
			result.rerender(
				<Stage opener={at.opener} entries={current} forwarded={{windowId, key, seq}} />,
			);
		});
	};
	const offer = (next: PickerEntries) => {
		current = next;
		result.rerender(<Stage opener={at.opener} entries={current} forwarded={null} />);
	};
	const text = () => result.container.textContent ?? "";
	return {...result, listbox, active, press, offer, text};
};

describe("Open project… by keyboard", () => {
	it("ends the program list, and its first step lists recent projects then the browser", async () => {
		const desk = stage(kernel());
		const holder = desk.listbox();
		expect(document.activeElement).toBe(holder);

		desk.press("<end>");
		expect(desk.active()).toMatch(/^Open project…/);

		desk.press("<enter>");
		expect(desk.listbox().getAttribute("aria-label")).toBe("Open project: recent projects");
		await waitFor(() => expect(desk.active()).toMatch(/^phoenix, open now/));
		const names = [...desk.container.querySelectorAll('[role="option"]')].map((option) =>
			option.getAttribute("aria-label"),
		);
		expect(names).toEqual([
			"phoenix, open now — /work/phoenix",
			"demlik — /work/demlik",
			"Browse for a folder… — starting at your home folder",
		]);
		// The same element held focus through the step, so the highlight is still announced off it.
		expect(desk.listbox()).toBe(holder);
		expect(document.activeElement).toBe(holder);
		expect(desk.text()).toContain("Open project. 2 recent projects, then Browse for a folder.");
	});

	it("lands on a project that is already open instead of opening it twice", async () => {
		const at = kernel();
		const desk = stage(at);
		desk.press("<end>");
		desk.press("<enter>");
		await waitFor(() => expect(desk.active()).toMatch(/^phoenix, open now/));

		desk.press("<enter>");
		expect(at.opened).toEqual([]);
		expect(desk.listbox().getAttribute("aria-label")).toBe(
			"Open a program or attach a running process",
		);
		expect(desk.active()).toBe("Claude · phoenix — program claude-session");
		expect(desk.text()).toContain("phoenix is already open.");
		expect(document.activeElement).toBe(desk.listbox());
	});

	it("opens a closed recent project through the port, and lands on it once it is open", async () => {
		const at = kernel();
		const desk = stage(at);
		desk.press("<end>");
		desk.press("<enter>");
		await waitFor(() => expect(desk.active()).toMatch(/^phoenix/));
		desk.press("<arrowdown>");
		expect(desk.active()).toBe("demlik — /work/demlik");

		desk.press("<enter>");
		await waitFor(() => expect(desk.text()).toContain("Opened demlik."));
		expect(at.opened).toEqual(["/work/demlik"]);
		// The projects frame names the new project a moment later; the landing waits for its rows.
		desk.offer(
			entries([
				{key: PHOENIX.key, label: "phoenix"},
				{key: DEMLIK.key, label: "demlik"},
			]),
		);
		expect(desk.active()).toBe("Claude · demlik — program claude-session");
	});

	it("shows a refused open in the step, as an alert, and leaves the step where it was", async () => {
		const desk = stage(kernel({refuseOpen: "it is not trusted, so nothing from it ran"}));
		desk.press("<end>");
		desk.press("<enter>");
		await waitFor(() => expect(desk.active()).toMatch(/^phoenix/));
		desk.press("<arrowdown>");
		desk.press("<enter>");
		await waitFor(() =>
			expect(desk.container.querySelector('[role="alert"]')?.textContent).toBe(
				"/work/demlik was not opened: it is not trusted, so nothing from it ran",
			),
		);
		expect(desk.listbox().getAttribute("aria-label")).toBe("Open project: recent projects");
	});

	it("browses into folders and back out, and Escape retraces each step to the row it left", async () => {
		const at = kernel();
		const desk = stage(at);
		desk.press("<end>");
		desk.press("<enter>");
		await waitFor(() => expect(desk.active()).toMatch(/^phoenix/));
		desk.press("<end>");
		desk.press("<enter>");
		await waitFor(() =>
			expect(desk.listbox().getAttribute("aria-label")).toBe("Open project: folders in /work"),
		);
		expect(desk.active()).toBe("Open work as a project — /work");

		desk.press("<end>");
		expect(desk.active()).toBe("tea, has a Tuval config");
		desk.press("<arrowright>");
		await waitFor(() =>
			expect(desk.listbox().getAttribute("aria-label")).toBe("Open project: folders in /work/tea"),
		);
		expect(desk.text()).toContain("No folders inside tea.");

		desk.press("<arrowleft>");
		await waitFor(() =>
			expect(desk.listbox().getAttribute("aria-label")).toBe("Open project: folders in /work"),
		);

		desk.press("<escape>");
		expect(desk.listbox().getAttribute("aria-label")).toBe("Open project: recent projects");
		await waitFor(() => expect(desk.active()).toMatch(/^Browse for a folder…/));

		desk.press("<escape>");
		expect(desk.active()).toMatch(/^Open project…/);
		expect(document.activeElement).toBe(desk.listbox());
		expect(at.opened).toEqual([]);
	});

	it("keeps the browser where it was when a folder cannot be read", async () => {
		const desk = stage(kernel());
		desk.press("<end>");
		desk.press("<enter>");
		await waitFor(() => expect(desk.active()).toMatch(/^phoenix/));
		desk.press("<end>");
		desk.press("<enter>");
		await waitFor(() => expect(desk.active()).toBe("Open work as a project — /work"));
		desk.press("<arrowdown>");
		desk.press("<arrowdown>");
		expect(desk.active()).toBe("locked");
		desk.press("<enter>");
		await waitFor(() =>
			expect(desk.container.querySelector('[role="alert"]')?.textContent).toBe(
				"Could not show the folders in /work/locked: permission denied",
			),
		);
		expect(desk.listbox().getAttribute("aria-label")).toBe("Open project: folders in /work");
	});

	it("opens the browsed folder from its own row", async () => {
		const at = kernel();
		const desk = stage(at);
		desk.press("<end>");
		desk.press("<enter>");
		await waitFor(() => expect(desk.active()).toMatch(/^phoenix/));
		desk.press("<end>");
		desk.press("<enter>");
		await waitFor(() => expect(desk.active()).toBe("Open work as a project — /work"));
		desk.press("<enter>");
		await waitFor(() => expect(desk.text()).toContain("Opened work."));
		expect(at.opened).toEqual(["/work"]);
	});
});

describe("a picker with no way to open projects", () => {
	it("offers no Open project… row", () => {
		const {container} = render(
			<PickerView
				windowId={windowId}
				entries={entries([])}
				view={mountPicker()}
				dispatch={() => {}}
				reducedMotion={true}
				focused={true}
			/>,
		);
		expect(container.textContent).not.toContain("Open project…");
	});
});
