/**
 * The "Open project…" frame's empty messages (#9981): under a filter, "nothing matches" is said of the
 * whole list, once, by the status line, and never under a group.
 */

import {describe, expect, it} from "vitest";
import type {FolderListing, RecentProjectRow} from "../../projects/open-project-wire.ts";
import {windowId} from "./fixtures.ts";
import {LOADING, openProjectFrame, type StepData} from "./open-project.ts";
import {browseStep, RECENT_STEP} from "./open-project-step.ts";
import {mountPicker, withFilter} from "./view.ts";

const window = windowId("window-1");

const CODE: FolderListing = {
	folder: "/home/ada/code",
	name: "code",
	key: "-home-ada-code",
	parent: {folder: "/home/ada", name: "ada"},
	open: false,
	folders: ["kamp-us", "pano", "sozluk"].map((name) => ({
		name,
		folder: `/home/ada/code/${name}`,
		hasConfig: false,
		open: false,
	})),
};
const folderData: StepData = {_tag: "Folder", listing: CODE};

const PHOENIX: RecentProjectRow = {
	folder: "/home/ada/code/phoenix",
	name: "phoenix",
	key: "-home-ada-code-phoenix",
	open: false,
};
const recentData: StepData = {_tag: "Recent", projects: [PHOENIX]};

const browse = browseStep(CODE.folder);
const filtered = (filter: string) => withFilter(mountPicker(), filter);
const emptyMessages = (frame: ReturnType<typeof openProjectFrame>) =>
	frame.groups.map((group) => group.emptyMessage);

describe("open project frame, empty messages", () => {
	it("drops the folder path group while the folders group holds the match", () => {
		const frame = openProjectFrame(window, browse, folderData, filtered("so"));
		expect(frame.groups.map((group) => group.options.map((option) => option.entry.label))).toEqual([
			["sozluk"],
		]);
		expect(frame.groups.map((group) => group.label)).toEqual(["Folders in code"]);
		expect(emptyMessages(frame)).toEqual([null]);
		expect(frame.announcement.text).toBe("1 of 5 rows");
	});

	it("drops Other folders while a recent project holds the match", () => {
		const frame = openProjectFrame(window, RECENT_STEP, recentData, filtered("phoe"));
		expect(frame.groups.map((group) => group.options.length)).toEqual([1]);
		expect(emptyMessages(frame)).toEqual([null]);
	});

	it("says nothing matches exactly once when no group holds a row", () => {
		for (const [step, data] of [
			[browse, folderData],
			[RECENT_STEP, recentData],
		] as const) {
			const frame = openProjectFrame(window, step, data, filtered("zzz"));
			const said = [...emptyMessages(frame), frame.announcement.text];
			expect(said.filter((text) => text === "Nothing matches this filter.")).toHaveLength(1);
			expect(frame.groups).toEqual([]);
		}
	});

	it("keeps each group's own empty text with no filter", () => {
		const emptyListing: FolderListing = {...CODE, folders: []};
		const cases: ReadonlyArray<
			[ReturnType<typeof openProjectFrame>, ReadonlyArray<string | null>]
		> = [
			[
				openProjectFrame(window, RECENT_STEP, {_tag: "Recent", projects: []}, mountPicker()),
				["No project has been opened yet.", null],
			],
			[
				openProjectFrame(window, RECENT_STEP, LOADING, mountPicker()),
				["Reading the recent projects…", null],
			],
			[
				openProjectFrame(window, RECENT_STEP, {_tag: "Unreadable", reason: "gone"}, mountPicker()),
				["Could not read the recent projects: gone", null],
			],
			[
				openProjectFrame(window, browse, {_tag: "Folder", listing: emptyListing}, mountPicker()),
				[null, "No folders inside code."],
			],
			[openProjectFrame(window, browse, LOADING, mountPicker()), ["Reading the folders…"]],
			[
				openProjectFrame(window, browse, {_tag: "Unreadable", reason: "denied"}, mountPicker()),
				["Could not read this folder: denied"],
			],
		];
		for (const [frame, expected] of cases) expect(emptyMessages(frame)).toEqual(expected);
	});
});
