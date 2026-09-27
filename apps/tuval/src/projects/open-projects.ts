/**
 * Which projects a desk has open, and the one saved list of them under the home `.tuval` (#9685,
 * ruling #9668 R1.1 and R6.1). The list is one record per folder: labels, reopening and a project's
 * remembered "no" to its recommends are later fields on that same record, so nothing here is keyed
 * on anything but the folder. The folders the person has trusted ride beside it (#9693), because a
 * folder stays trusted after it closes.
 *
 * Two spellings of one folder are one project: the identity is the ADR 0402 path key, the name the
 * project's rows and state directory are already keyed by (`../project-id.ts`).
 *
 * A desk restarting over the list reopens what was open (#9688, ruling #9668 R5.1). Until it has
 * tried a folder, that folder stays in the list as pending, so a desk that dies mid-restart still
 * has it to reopen next time.
 */

import {join, resolve, sep} from "node:path";
import {homeTuvalDir} from "@kampus/tuval-sdk/kernel/state-dir";
import {Effect, FileSystem, Result, Schema} from "effect";
import {ProjectId} from "../project-id.ts";
import type {ProjectLabel} from "./labels.ts";
import {TrustedFolders} from "./trust.ts";

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

/** A folder the saved list had open that this restart did not reopen, and why. */
export class ProjectNotReopened extends Schema.TaggedError<ProjectNotReopened>()(
	"tuval/ProjectNotReopened",
	{folder: Schema.String, reason: Schema.String},
) {
	override get message(): string {
		return `did not reopen the project ${this.folder}: ${this.reason}`;
	}
}

/** One folder's record in the saved list. */
export const OpenProjectRecord = Schema.Struct({folder: Schema.String});

export const OpenProjectsRecord = Schema.Struct({
	version: Schema.Literal(1),
	projects: Schema.Array(OpenProjectRecord),
	/** Every folder the person answered yes for, open or not. A list written before #9693 has none. */
	trusted: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type OpenProjectsRecord = typeof OpenProjectsRecord.Type;

const keyOf = (folder: string): string => ProjectId.of(resolve(folder)).key;

/**
 * The desk's open projects, in the order they opened, the folders trusted so far, and the folders a
 * restart has still to reopen. A folder is never both open and pending: opening it or skipping it
 * takes it off the pending list.
 */
export class OpenProjects {
	static readonly none = new OpenProjects([], TrustedFolders.none, []);

	readonly projects: ReadonlyArray<OpenProject>;
	readonly trusted: TrustedFolders;
	/** The saved list's open folders this desk has not yet reopened or skipped, in saved order. */
	readonly pending: ReadonlyArray<string>;

	private constructor(
		projects: ReadonlyArray<OpenProject>,
		trusted: TrustedFolders,
		pending: ReadonlyArray<string>,
	) {
		this.projects = projects;
		this.trusted = trusted;
		this.pending = pending;
	}

	/**
	 * A desk starting over a saved list: every folder it trusted is still trusted, nothing is open
	 * yet, and every folder that was open is pending, a folder listed twice counted once.
	 */
	static restoring(record: OpenProjectsRecord | null): OpenProjects {
		const pending = new Map<string, string>();
		for (const {folder} of record?.projects ?? []) {
			const key = keyOf(folder);
			if (!pending.has(key)) pending.set(key, resolve(folder));
		}
		return new OpenProjects([], TrustedFolders.of(record?.trusted ?? []), [...pending.values()]);
	}

	/** The same projects, with `folder` trusted from now on. */
	trust(folder: string): OpenProjects {
		const trusted = this.trusted.trust(folder);
		return trusted === this.trusted ? this : new OpenProjects(this.projects, trusted, this.pending);
	}

	/** The same projects, with `folder` no longer waiting to be reopened. */
	skip(folder: string): OpenProjects {
		const pending = this.withoutPending(folder);
		return pending === this.pending ? this : new OpenProjects(this.projects, this.trusted, pending);
	}

	private withoutPending(folder: string): ReadonlyArray<string> {
		const key = keyOf(folder);
		return this.pending.some((waiting) => keyOf(waiting) === key)
			? this.pending.filter((waiting) => keyOf(waiting) !== key)
			: this.pending;
	}

	/** The open project at `folder`, under any spelling of it. */
	find(folder: string): OpenProject | undefined {
		const key = keyOf(folder);
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
		return Result.succeed({
			projects: new OpenProjects(
				[...this.projects, project],
				this.trusted,
				this.withoutPending(absolute),
			),
			project,
		});
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
			projects: new OpenProjects(
				this.projects.filter((open) => open !== project),
				this.trusted,
				this.pending,
			),
			project,
		});
	}

	/** The open folders, then the pending ones: both are what a restart reopens. */
	get record(): OpenProjectsRecord {
		return {
			version: 1,
			projects: [...this.projects.map(({folder}) => folder), ...this.pending].map((folder) => ({
				folder,
			})),
			trusted: this.trusted.folders,
		};
	}
}

const segmentsOf = (folder: string): ReadonlyArray<string> =>
	folder.split(sep).filter((segment) => segment !== "");

const endsWith = (segments: ReadonlyArray<string>, suffix: ReadonlyArray<string>): boolean =>
	suffix.length <= segments.length &&
	suffix.every((segment, at) => segments[segments.length - suffix.length + at] === segment);

/**
 * Each open project's label: the folder's name, which is what tiles, windows and picker entries
 * show (#9692, ruling #9668 R1.1). Two open folders with one name would read as one project, so a
 * clashing name takes on parent folders, the way VS Code tells two same-named tabs apart, until no
 * other open folder ends the same way: `kamp-us/phoenix` beside `usirin/phoenix`. A folder that runs
 * out of parents first (`/phoenix` beside `/work/phoenix`) is shown by its whole path.
 */
export const projectLabels = (
	projects: ReadonlyArray<OpenProject>,
): ReadonlyArray<ProjectLabel> => {
	const segments = projects.map((project) => segmentsOf(project.folder));
	return projects.map((project, at) => {
		const own = segments[at] ?? [];
		const name = own.at(-1);
		const clashes = segments.filter((other, index) => index !== at && other.at(-1) === name);
		const label = (): string => {
			if (name === undefined) return project.folder;
			if (clashes.length === 0) return name;
			for (let depth = 2; depth <= own.length; depth++) {
				const suffix = own.slice(-depth);
				if (clashes.every((other) => !endsWith(other, suffix))) return suffix.join(sep);
			}
			return project.folder;
		};
		return {key: project.id.key, label: label()};
	});
};

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
