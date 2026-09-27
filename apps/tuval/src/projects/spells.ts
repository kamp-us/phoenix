/**
 * The kernel's project commands (#9685): what the `tuval` command and the picker's "Open project…"
 * call to open a folder into the running desk or close one, and what an agent calls through the
 * spell bridge. "Open project…" also reads the recent folders and browses for one here (#9697). A folder is named by its absolute path, because the kernel has no working directory
 * a caller could mean a relative one against.
 */

import {isAbsolute} from "node:path";
import {type AnySpell, defineSpell} from "@kampus/tuval-sdk/kernel/commands/spell";
import {Effect, Schema} from "effect";
import {FolderListing, RecentProjects} from "./open-project-wire.ts";
import {Projects} from "./Projects.ts";

const Folder = Schema.String.check(
	Schema.makeFilter((folder: string) => isAbsolute(folder), {
		message: "Expected an absolute folder path",
	}),
);

const ProjectRow = Schema.Struct({folder: Schema.String, name: Schema.String});

const openSpell = defineSpell({
	path: ["project", "open"],
	describe: "Open a project folder into the running desk and start its programs.",
	params: Schema.Struct({folder: Folder}),
	result: Schema.Struct({
		folder: Schema.String,
		name: Schema.String,
		/** The id the project's rows are scoped by, which the page's projects frame labels by. */
		key: Schema.String,
		programs: Schema.Int,
		/** Why each program the project declares outside its SDK range was not loaded. */
		refused: Schema.Array(Schema.String),
		processes: Schema.Int,
		restored: Schema.Int,
	}),
	execute: (args) =>
		Effect.map(
			Effect.flatMap(Projects, (projects) => projects.open(args.folder)),
			(opened) => ({
				folder: opened.project.folder,
				name: opened.project.id.name,
				key: opened.project.id.key,
				programs: opened.programCount,
				refused: opened.refused.map((refusal) => refusal.message),
				processes: opened.launched.length + opened.restored.length,
				restored:
					opened.launched.filter((process) => process.restored).length + opened.restored.length,
			}),
		),
	capabilities: [{family: "process-control"}],
});

const closeSpell = defineSpell({
	path: ["project", "close"],
	describe: "Close an open project: stop its programs and drop its connections.",
	params: Schema.Struct({folder: Folder}),
	result: ProjectRow,
	execute: (args) =>
		Effect.map(
			Effect.flatMap(Projects, (projects) => projects.close(args.folder)),
			({project}) => ({folder: project.folder, name: project.id.name}),
		),
	capabilities: [{family: "process-control"}],
});

const listSpell = defineSpell({
	path: ["project", "list"],
	describe: "List the projects open in this desk, in the order they opened.",
	params: Schema.Struct({}),
	result: Schema.Array(ProjectRow),
	execute: () =>
		Effect.map(
			Effect.flatMap(Projects, (projects) => projects.list),
			(open) => open.map((project) => ({folder: project.folder, name: project.id.name})),
		),
	capabilities: [],
});

const recentSpell = defineSpell({
	path: ["project", "recent"],
	describe: "List the folders opened most recently, newest first, and whether each is open now.",
	params: Schema.Struct({}),
	result: RecentProjects,
	execute: () =>
		Effect.map(
			Effect.flatMap(Projects, (projects) => projects.recent),
			(recent) =>
				recent.map((project) => ({
					folder: project.folder,
					name: project.id.name,
					key: project.id.key,
					open: project.open,
				})),
		),
	capabilities: [],
});

const browseSpell = defineSpell({
	path: ["project", "browse"],
	describe: "List the subfolders of a folder, or of the home folder, to choose a project from.",
	params: Schema.Struct({folder: Schema.optionalKey(Folder)}),
	result: FolderListing,
	execute: (args) => Effect.flatMap(Projects, (projects) => projects.browse(args.folder)),
	capabilities: [],
});

export const projectSpells: ReadonlyArray<AnySpell> = [
	openSpell,
	closeSpell,
	listSpell,
	recentSpell,
	browseSpell,
];
