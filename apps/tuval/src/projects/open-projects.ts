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
 *
 * A subproject is open beside the others and never saved (#9689, ruling #9668 R4.3 and #9673 R2):
 * the program that opened it is the one that restores it, so a restart has nothing of it to reopen.
 * Closing a project closes every subproject nested under it.
 *
 * The folders opened most recently ride beside it too, newest first, because the picker's "Open
 * project…" lists them and a folder stays recent after it closes (#9697, ruling #9668 R6.1).
 */

import {join, resolve, sep} from "node:path";
import type {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {homeTuvalDir} from "@kampus/tuval-sdk/kernel/state-dir";
import {Effect, FileSystem, Result, Schema} from "effect";
import {ProjectId} from "../project-id.ts";
import type {ProjectLabel} from "./labels.ts";
import {TrustedFolders} from "./trust.ts";

/** Where a subproject sits: the project it is nested under, and the process that opened it. */
export interface Nesting {
	readonly parent: ProjectId;
	readonly opener: ProcessId;
}

export interface OpenProject {
	/** The folder as the desk opened it: absolute, with no trailing separator. */
	readonly folder: string;
	readonly id: ProjectId;
	/** Present on a subproject, and only there. */
	readonly under?: Nesting;
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

/** How many recently opened folders the saved list keeps. */
export const RECENT_LIMIT = 20;

/** One recently opened folder, and whether it is open in this desk now. */
export interface RecentProject {
	readonly folder: string;
	readonly id: ProjectId;
	readonly open: boolean;
}

export const OpenProjectsRecord = Schema.Struct({
	version: Schema.Literal(1),
	projects: Schema.Array(OpenProjectRecord),
	/** Every folder the person answered yes for, open or not. A list written before #9693 has none. */
	trusted: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
	/** The folders opened most recently, newest first. A list written before #9697 has none. */
	recent: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type OpenProjectsRecord = typeof OpenProjectsRecord.Type;

const keyOf = (folder: string): string => ProjectId.of(resolve(folder)).key;

/** `folders` resolved, a folder listed twice kept at its first place, and at most `RECENT_LIMIT`. */
const distinctRecent = (folders: ReadonlyArray<string>): ReadonlyArray<string> => {
	const byKey = new Map<string, string>();
	for (const folder of folders) {
		const key = keyOf(folder);
		if (!byKey.has(key)) byKey.set(key, resolve(folder));
	}
	return [...byKey.values()].slice(0, RECENT_LIMIT);
};

/**
 * The desk's open projects, in the order they opened, the folders trusted so far, the folders a
 * restart has still to reopen, and the folders opened most recently. A folder is never both open
 * and pending: opening it or skipping it takes it off the pending list.
 */
export class OpenProjects {
	static readonly none = new OpenProjects([], TrustedFolders.none, [], []);

	readonly projects: ReadonlyArray<OpenProject>;
	readonly trusted: TrustedFolders;
	/** The saved list's open folders this desk has not yet reopened or skipped, in saved order. */
	readonly pending: ReadonlyArray<string>;
	/** The top-level folders opened most recently, newest first, open or not. */
	readonly recent: ReadonlyArray<string>;

	private constructor(
		projects: ReadonlyArray<OpenProject>,
		trusted: TrustedFolders,
		pending: ReadonlyArray<string>,
		recent: ReadonlyArray<string>,
	) {
		this.projects = projects;
		this.trusted = trusted;
		this.pending = pending;
		this.recent = recent;
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
		return new OpenProjects(
			[],
			TrustedFolders.of(record?.trusted ?? []),
			[...pending.values()],
			distinctRecent(record?.recent ?? []),
		);
	}

	/** The same projects, with `folder` trusted from now on. */
	trust(folder: string): OpenProjects {
		const trusted = this.trusted.trust(folder);
		return trusted === this.trusted
			? this
			: new OpenProjects(this.projects, trusted, this.pending, this.recent);
	}

	/** The same projects, with `folder` no longer waiting to be reopened. */
	skip(folder: string): OpenProjects {
		const pending = this.withoutPending(folder);
		return pending === this.pending
			? this
			: new OpenProjects(this.projects, this.trusted, pending, this.recent);
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

	/** The recently opened folders, newest first, each saying whether it is open now. */
	get recentProjects(): ReadonlyArray<RecentProject> {
		return this.recent.map((folder) => ({
			folder,
			id: ProjectId.of(folder),
			open: this.find(folder) !== undefined,
		}));
	}

	open(
		folder: string,
	): Result.Result<
		{readonly projects: OpenProjects; readonly project: OpenProject},
		ProjectAlreadyOpen
	> {
		return this.adding(resolve(folder), undefined);
	}

	/** `folder` opened as a subproject of the open project at `parent`, by `opener`. */
	openUnder(
		folder: string,
		parent: string,
		opener: ProcessId,
	): Result.Result<
		{readonly projects: OpenProjects; readonly project: OpenProject},
		ProjectAlreadyOpen | ProjectNotOpen
	> {
		const nest = this.find(parent);
		if (nest === undefined) return Result.fail(new ProjectNotOpen({folder: resolve(parent)}));
		return this.adding(resolve(folder), {parent: nest.id, opener});
	}

	private adding(
		absolute: string,
		under: Nesting | undefined,
	): Result.Result<
		{readonly projects: OpenProjects; readonly project: OpenProject},
		ProjectAlreadyOpen
	> {
		if (this.find(absolute) !== undefined) {
			return Result.fail(new ProjectAlreadyOpen({folder: absolute}));
		}
		const project: OpenProject = {
			folder: absolute,
			id: ProjectId.of(absolute),
			...(under === undefined ? {} : {under}),
		};
		return Result.succeed({
			projects: new OpenProjects(
				[...this.projects, project],
				this.trusted,
				this.withoutPending(absolute),
				// A subproject is its opener's to bring back, so it is never offered as recent.
				under === undefined ? distinctRecent([absolute, ...this.recent]) : this.recent,
			),
			project,
		});
	}

	/**
	 * The open project at `folder` closed, with every subproject nested under it. `closed` is all of
	 * them, each subproject before the project it is nested under, so `project` comes last.
	 */
	close(folder: string): Result.Result<
		{
			readonly projects: OpenProjects;
			readonly project: OpenProject;
			readonly closed: ReadonlyArray<OpenProject>;
		},
		ProjectNotOpen
	> {
		const project = this.find(folder);
		if (project === undefined) return Result.fail(new ProjectNotOpen({folder: resolve(folder)}));
		const closed = [...this.nestedUnder(project), project];
		return Result.succeed({
			projects: new OpenProjects(
				this.projects.filter((open) => !closed.includes(open)),
				this.trusted,
				this.pending,
				this.recent,
			),
			project,
			closed,
		});
	}

	/** Every open subproject nested under `project` at any depth, the deepest first. */
	private nestedUnder(project: OpenProject): ReadonlyArray<OpenProject> {
		const children = this.projects.filter((open) => open.under?.parent.key === project.id.key);
		return children.flatMap((child) => [...this.nestedUnder(child), child]);
	}

	/**
	 * The open folders, then the pending ones: both are what a restart reopens. A subproject is left
	 * out, because only its opener brings it back.
	 */
	get record(): OpenProjectsRecord {
		const reopened = this.projects.filter((project) => project.under === undefined);
		return {
			version: 1,
			projects: [...reopened.map(({folder}) => folder), ...this.pending].map((folder) => ({
				folder,
			})),
			trusted: this.trusted.folders,
			recent: this.recent,
		};
	}
}

const segmentsOf = (folder: string): ReadonlyArray<string> =>
	folder.split(sep).filter((segment) => segment !== "");

const endsWith = (segments: ReadonlyArray<string>, suffix: ReadonlyArray<string>): boolean =>
	suffix.length <= segments.length &&
	suffix.every((segment, at) => segments[segments.length - suffix.length + at] === segment);

/**
 * Distinct names for one group of folders: each folder's name, and where two share a name, as many
 * parent folders as tell them apart, the way VS Code tells two same-named tabs apart. A folder that
 * runs out of parents first (`/phoenix` beside `/work/phoenix`) is named by its whole path.
 */
const distinctNames = (folders: ReadonlyArray<string>): ReadonlyArray<string> => {
	const segments = folders.map(segmentsOf);
	return folders.map((folder, at) => {
		const own = segments[at] ?? [];
		const name = own.at(-1);
		const clashes = segments.filter((other, index) => index !== at && other.at(-1) === name);
		if (name === undefined) return folder;
		if (clashes.length === 0) return name;
		for (let depth = 2; depth <= own.length; depth++) {
			const suffix = own.slice(-depth);
			if (clashes.every((other) => !endsWith(other, suffix))) return suffix.join(sep);
		}
		return folder;
	});
};

/** What separates a subproject's name from its parent's label: `phoenix › lane-9650`. */
export const NESTING_SEPARATOR = " › ";

/**
 * Each open project's label: the folder's name, which is what tiles, windows and picker entries
 * show (#9692, ruling #9668 R1.1). Two open folders with one name would read as one project, so a
 * clashing name takes on parent folders until no other open folder ends the same way:
 * `kamp-us/phoenix` beside `usirin/phoenix`. A subproject reads under its parent's label,
 * `phoenix › lane-9650`, its own name told apart only from its siblings' (#9689, ruling #9668 R4.3).
 */
export const projectLabels = (
	projects: ReadonlyArray<OpenProject>,
): ReadonlyArray<ProjectLabel> => {
	const groups = new Map<string | undefined, Array<OpenProject>>();
	for (const project of projects) {
		const parent = project.under?.parent.key;
		groups.set(parent, [...(groups.get(parent) ?? []), project]);
	}
	const labels = new Map<string, string>();
	const labelGroup = (parent: string | undefined, prefix: string) => {
		const group = groups.get(parent) ?? [];
		const names = distinctNames(group.map((project) => project.folder));
		group.forEach((project, at) => {
			const label = `${prefix}${names[at] ?? project.folder}`;
			labels.set(project.id.key, label);
			labelGroup(project.id.key, `${label}${NESTING_SEPARATOR}`);
		});
	};
	labelGroup(undefined, "");
	return projects.flatMap((project) => {
		const label = labels.get(project.id.key);
		return label === undefined ? [] : [{key: project.id.key, label}];
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
