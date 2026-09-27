/**
 * The config generation a running desk registers spells and key bindings from, kept owner by owner
 * (#9685): the desk and global layers as one owner, then each open project. A project opens and
 * closes as a whole, and a binding source cannot say which project wrote it — every project's reads
 * `project .tuval/tuval.config.ts` — so the split is kept here rather than recovered from the merge.
 */

import type {BindingSource} from "@kampus/tuval-sdk/kernel/commands/bindings/index";
import type {AnyProgram} from "@kampus/tuval-sdk/kernel/registry/program";
import {AuthoredModules} from "./authored-modules.ts";
import type {ProjectLayer} from "./config.ts";
import type {ProgramGeneration} from "./reload.ts";

/** One owner's rows as the kernel runs them, with their flags applied, beside their keys. */
export interface OwnerRead {
	readonly programs: ReadonlyArray<AnyProgram>;
	readonly keys: ReadonlyArray<BindingSource>;
	/** The layer modules that existed. */
	readonly sources: ReadonlyArray<string>;
}

interface ProjectRead {
	readonly layer: ProjectLayer;
	readonly read: OwnerRead;
}

/** What one config load read of the author's code: the files a desk watches, and their source. */
export interface LoadRead {
	readonly files: ReadonlyArray<string>;
	readonly modules: AuthoredModules;
}

const noLoad: LoadRead = {files: [], modules: AuthoredModules.none};

export class ConfigGeneration implements ProgramGeneration {
	/** The desk's and global layers' rows. */
	readonly desk: OwnerRead;
	/** Every file the generation was read from, which is what a desk watches. */
	readonly files: ReadonlyArray<string>;
	/** The author's modules every owner's rows were built from, which a reload diffs code against. */
	readonly modules: AuthoredModules;
	private readonly byProject: ReadonlyMap<string, ProjectRead>;

	private constructor(
		desk: OwnerRead,
		byProject: ReadonlyMap<string, ProjectRead>,
		{files, modules}: LoadRead,
	) {
		this.desk = desk;
		this.byProject = byProject;
		this.files = files;
		this.modules = modules;
	}

	/** A generation with no project open. */
	static of(desk: OwnerRead, load: LoadRead = noLoad): ConfigGeneration {
		return new ConfigGeneration(desk, new Map(), load);
	}

	/** The open projects' layers, in the order they opened: what a reload reads again. */
	get projects(): ReadonlyArray<ProjectLayer> {
		return [...this.byProject.values()].map((project) => project.layer);
	}

	private get owners(): ReadonlyArray<OwnerRead> {
		return [this.desk, ...[...this.byProject.values()].map((project) => project.read)];
	}

	get programs(): ReadonlyArray<AnyProgram> {
		return this.owners.flatMap((owner) => owner.programs);
	}

	/** Global first, then each project's: a later source's binding wins, as a key router reads them. */
	get keys(): ReadonlyArray<BindingSource> {
		return this.owners.flatMap((owner) => owner.keys);
	}

	get sources(): ReadonlyArray<string> {
		return this.owners.flatMap((owner) => owner.sources);
	}

	/** This generation with `layer`'s project open, after every project already open. */
	withProject(layer: ProjectLayer, read: OwnerRead, load: LoadRead): ConfigGeneration {
		const byProject = new Map(this.byProject);
		byProject.delete(layer.id.key);
		byProject.set(layer.id.key, {layer, read});
		return new ConfigGeneration(this.desk, byProject, {
			files: [...new Set([...this.files, ...load.files])],
			modules: this.modules.union(load.modules),
		});
	}

	/**
	 * This generation with the project keyed `key` closed. Its files and modules stay until the next
	 * reload: a file two projects import cannot be told apart by which one read it.
	 */
	withoutProject(key: string): ConfigGeneration {
		const byProject = new Map(this.byProject);
		byProject.delete(key);
		return new ConfigGeneration(this.desk, byProject, this);
	}
}
