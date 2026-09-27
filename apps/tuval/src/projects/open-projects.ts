/**
 * Which projects a desk has open, and the one saved list of them under the home `.tuval` (#9685,
 * ruling #9668 R1.1 and R6.1). The list is one record per folder: trust, labels, reopening and a
 * project's remembered "no" to its recommends are later fields on that same record, so nothing here
 * is keyed on anything but the folder.
 *
 * Two spellings of one folder are one project: the identity is the ADR 0402 path key, the name the
 * project's rows and state directory are already keyed by (`../project-id.ts`).
 */

import {join, resolve} from "node:path";
import {homeTuvalDir} from "@kampus/tuval-sdk/kernel/state-dir";
import {Effect, FileSystem, Result, Schema} from "effect";
import {ProjectId} from "../project-id.ts";

export interface OpenProject {
	/** The folder as the desk opened it: absolute, with no trailing separator. */
	readonly folder: string;
	readonly id: ProjectId;
}

export class ProjectAlreadyOpen extends Schema.TaggedError<ProjectAlreadyOpen>()(
	"tuval/ProjectAlreadyOpen",
	{folder: Schema.String},
) {
	override get message(): string {
		return `the project ${this.folder} is already open`;
	}
}

export class ProjectNotOpen extends Schema.TaggedError<ProjectNotOpen>()("tuval/ProjectNotOpen", {
	folder: Schema.String,
}) {
	override get message(): string {
		return `the project ${this.folder} is not open`;
	}
}

/** One folder's record in the saved list. */
export const OpenProjectRecord = Schema.Struct({folder: Schema.String});

export const OpenProjectsRecord = Schema.Struct({
	version: Schema.Literal(1),
	projects: Schema.Array(OpenProjectRecord),
});
export type OpenProjectsRecord = typeof OpenProjectsRecord.Type;

/** The desk's open projects, in the order they opened. */
export class OpenProjects {
	static readonly none = new OpenProjects([]);

	readonly projects: ReadonlyArray<OpenProject>;

	private constructor(projects: ReadonlyArray<OpenProject>) {
		this.projects = projects;
	}

	/** The open project at `folder`, under any spelling of it. */
	find(folder: string): OpenProject | undefined {
		const {key} = ProjectId.of(resolve(folder));
		return this.projects.find((project) => project.id.key === key);
	}

	open(
		folder: string,
	): Result.Result<
		{readonly projects: OpenProjects; readonly project: OpenProject},
		ProjectAlreadyOpen
	> {
		const absolute = resolve(folder);
		if (this.find(absolute) !== undefined) {
			return Result.fail(new ProjectAlreadyOpen({folder: absolute}));
		}
		const project: OpenProject = {folder: absolute, id: ProjectId.of(absolute)};
		return Result.succeed({projects: new OpenProjects([...this.projects, project]), project});
	}

	close(
		folder: string,
	): Result.Result<
		{readonly projects: OpenProjects; readonly project: OpenProject},
		ProjectNotOpen
	> {
		const project = this.find(folder);
		if (project === undefined) return Result.fail(new ProjectNotOpen({folder: resolve(folder)}));
		return Result.succeed({
			projects: new OpenProjects(this.projects.filter((open) => open !== project)),
			project,
		});
	}

	get record(): OpenProjectsRecord {
		return {version: 1, projects: this.projects.map(({folder}) => ({folder}))};
	}
}

/** The saved list: `<home>/.tuval/open-projects.json`. */
export const openProjectsFile = (home: string): string =>
	join(homeTuvalDir(home), "open-projects.json");

const RecordFile = Schema.fromJsonString(OpenProjectsRecord, {space: "\t"});
const encodeRecord = Schema.encodeSync(RecordFile);
const decodeRecord = Schema.decodeUnknownEffect(RecordFile);

/**
 * Write the list whole, through a sibling temp file and a rename, so a reader never sees half of
 * one and a crash mid-write leaves the previous list.
 */
export const saveOpenProjects = Effect.fn("Tuval.saveOpenProjects")(function* (
	home: string,
	projects: OpenProjects,
) {
	const fs = yield* FileSystem.FileSystem;
	const file = openProjectsFile(home);
	yield* fs.makeDirectory(homeTuvalDir(home), {recursive: true});
	const temp = `${file}.${process.pid}.tmp`;
	yield* fs.writeFileString(temp, `${encodeRecord(projects.record)}\n`);
	yield* fs.rename(temp, file);
});

/** The saved list, or `null` when none was ever written. */
export const readOpenProjects = Effect.fn("Tuval.readOpenProjects")(function* (home: string) {
	const fs = yield* FileSystem.FileSystem;
	const file = openProjectsFile(home);
	if (!(yield* fs.exists(file))) return null;
	return yield* decodeRecord(yield* fs.readFileString(file));
});
