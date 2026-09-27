/**
 * The kernel's project commands (#9685): what the `tuval` command and the picker's "Open project…"
 * call to open a folder into the running desk or close one, and what an agent calls through the
 * spell bridge. A folder is named by its absolute path, because the kernel has no working directory
 * a caller could mean a relative one against.
 */

import {isAbsolute} from "node:path";
import {type AnySpell, defineSpell} from "@kampus/tuval-sdk/kernel/commands/spell";
import {Effect, Schema} from "effect";
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
		programs: Schema.Int,
		processes: Schema.Int,
		restored: Schema.Int,
	}),
	execute: (args) =>
		Effect.map(
			Effect.flatMap(Projects, (projects) => projects.open(args.folder)),
			(opened) => ({
				folder: opened.project.folder,
				name: opened.project.id.name,
				programs: opened.programCount,
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

export const projectSpells: ReadonlyArray<AnySpell> = [openSpell, closeSpell, listSpell];
