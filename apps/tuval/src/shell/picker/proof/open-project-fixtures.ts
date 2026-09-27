/**
 * The kernel the picker proof's "Open project…" panes ask (#9697): a `ProjectOpener` answered from
 * fixtures, so the recent list, the folder browser and an open's refusal render with no desk behind
 * them. Everything answers at once except an open, which waits a moment the way one waiting on the
 * trust prompt does, so a hand-driven pane shows its "Opening…" line.
 */

import {Duration, Effect} from "effect";
import type {FolderListing, RecentProjectRow} from "../../../projects/open-project-wire.ts";
import {type ProjectOpener, ProjectOpenerFailure} from "../browser.ts";

const HOME = "/Users/ada";

/** Keyed the way `projectKey` keys a folder: its path with every separator a dash. */
const keyOf = (folder: string): string => folder.replaceAll("/", "-");

const recent = (folder: string, open: boolean): RecentProjectRow => ({
	folder,
	name: folder.split("/").at(-1) ?? folder,
	key: keyOf(folder),
	open,
});

/** Newest first; two checkouts named phoenix, told apart by their folder path. */
export const RECENT_PROJECTS: ReadonlyArray<RecentProjectRow> = [
	recent(`${HOME}/code/kamp-us/phoenix`, true),
	recent(`${HOME}/code/kamp-us/demlik`, false),
	recent(`${HOME}/code/usirin/phoenix`, false),
	recent(`${HOME}/notes`, true),
	recent(`${HOME}/code/tea`, false),
];

const folder = (parent: string, name: string, hasConfig = false, open = false) => ({
	name,
	folder: `${parent}/${name}`,
	hasConfig,
	open,
});

const listing = (path: string, folders: FolderListing["folders"], open = false): FolderListing => {
	const segments = path.split("/").filter((segment) => segment !== "");
	const parent = segments.length === 0 ? null : `/${segments.slice(0, -1).join("/")}`;
	return {
		folder: path,
		name: segments.at(-1) ?? path,
		key: keyOf(path),
		parent: parent === null ? null : {folder: parent, name: parent.split("/").at(-1) || parent},
		open,
		folders,
	};
};

export const CODE_FOLDER = `${HOME}/code`;

const LISTINGS: ReadonlyMap<string, FolderListing> = new Map([
	[
		HOME,
		listing(HOME, [
			folder(HOME, "code"),
			folder(HOME, "Desktop"),
			folder(HOME, "Documents"),
			folder(HOME, "Downloads"),
			folder(HOME, "notes", true, true),
		]),
	],
	[
		CODE_FOLDER,
		listing(CODE_FOLDER, [
			folder(CODE_FOLDER, "atolye", true),
			folder(CODE_FOLDER, "kamp-us"),
			folder(CODE_FOLDER, "locked"),
			folder(CODE_FOLDER, "pano"),
			folder(CODE_FOLDER, "sozluk", true),
			folder(CODE_FOLDER, "tea", true),
			folder(CODE_FOLDER, "usirin"),
		]),
	],
	[
		`${CODE_FOLDER}/kamp-us`,
		listing(`${CODE_FOLDER}/kamp-us`, [
			folder(`${CODE_FOLDER}/kamp-us`, "demlik", true),
			folder(`${CODE_FOLDER}/kamp-us`, "phoenix", true, true),
		]),
	],
	[`${CODE_FOLDER}/tea`, listing(`${CODE_FOLDER}/tea`, [])],
]);

/** A folder the proof's desk may not read, so browsing into it shows the refusal. */
const LOCKED = `${CODE_FOLDER}/locked`;

const openKeys = new Set(RECENT_PROJECTS.filter((row) => row.open).map((row) => row.key));

export const fixtureOpener = (recentProjects: ReadonlyArray<RecentProjectRow>): ProjectOpener => ({
	recent: Effect.succeed(recentProjects),
	browse: (path) => {
		const at = path ?? HOME;
		if (at === LOCKED) {
			return Effect.fail(new ProjectOpenerFailure({reason: "permission denied"}));
		}
		return Effect.succeed(LISTINGS.get(at) ?? listing(at, []));
	},
	open: (path) =>
		openKeys.has(keyOf(path))
			? Effect.fail(new ProjectOpenerFailure({reason: `the project ${path} is already open`}))
			: Effect.as(Effect.sleep(Duration.millis(1_500)), {
					folder: path,
					name: path.split("/").at(-1) ?? path,
					key: keyOf(path),
				}),
});
