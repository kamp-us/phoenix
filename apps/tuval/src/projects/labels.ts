/**
 * The label a tile or window of a project's process carries (#9692, ruling #9668 R1.1). The label
 * itself is made once, over the open-projects record (`projectLabels` in `./open-projects.ts`), and
 * reaches the page as data; this half only reads which label a program id is under. It imports
 * nothing from Node, because the page imports it.
 */

import {scopedId, scopedIdParts} from "@kampus/tuval-sdk/kernel/registry/scoped-id";

/** One open project's label, beside the key its program ids are scoped by (`../project-id.ts`). */
export interface ProjectLabel {
	readonly key: string;
	readonly label: string;
}

export class ProjectLabels {
	/** No project open, or a page the kernel has not told yet: every program id reads unlabelled. */
	static readonly none = new ProjectLabels(new Map());

	private readonly byKey: ReadonlyMap<string, string>;

	private constructor(byKey: ReadonlyMap<string, string>) {
		this.byKey = byKey;
	}

	static of(labels: Iterable<ProjectLabel>): ProjectLabels {
		return new ProjectLabels(new Map([...labels].map(({key, label}) => [key, label])));
	}

	/** Every open project's label, in the order the projects opened: what the picker offers (#9694). */
	get all(): ReadonlyArray<ProjectLabel> {
		return [...this.byKey].map(([key, label]) => ({key, label}));
	}

	/**
	 * The label of the open project that owns `programId`. `null` for a global program, whose id is
	 * bare, and for a project that has already closed while one of its processes is still stopping.
	 */
	labelOf(programId: string): string | null {
		const {scope} = scopedIdParts(programId);
		return scope === undefined ? null : (this.byKey.get(scope) ?? null);
	}

	/**
	 * What a person reads as the program's name. Under a labelled project that is the id its config
	 * declared, since the label beside it already says which project; anywhere else it is the id as
	 * it stands, because a scope with no label is the only thing telling two such rows apart.
	 */
	programName(programId: string): string {
		return this.labelOf(programId) === null ? programId : scopedIdParts(programId).local;
	}

	/**
	 * A program or process id as a person reads it (#9987): `<label>/<local>` under a labelled
	 * project, so the path key its storage is keyed by never reaches a row. `local` maps the local
	 * part only, which is how a short form shortens the id's own name and never the scope in front.
	 * A bare id, and a scope with no label (`programName`), keep the id as it stands.
	 */
	displayId(id: string, local: (part: string) => string = (part) => part): string {
		const parts = scopedIdParts(id);
		if (parts.scope === undefined) return local(parts.local);
		return scopedId(this.byKey.get(parts.scope) ?? parts.scope, local(parts.local));
	}
}
