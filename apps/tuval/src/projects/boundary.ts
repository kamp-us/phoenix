/**
 * The subproject boundary (#9689, ruling #9668 R4.3): who may reach across it. Only the process that
 * opened a subproject crosses, down into it from the parent; a subproject's programs cannot reach up
 * to its parent, and the parent's other programs cannot reach down. A subproject nested further down
 * is behind its own opener, so the parent's opener stops at the first boundary.
 *
 * Everything else is left as it runs today: a global process, a process of an unrelated project,
 * and one reaching a global process are not this rule's to answer.
 */

import type {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import type {OpenProject} from "./open-projects.ts";

/** One end of a reach: the project it runs in, or none for the desk's and global processes. */
export interface Side {
	readonly project: OpenProject | undefined;
}

/** The reaching end, which is always a process. */
export interface From extends Side {
	readonly process: ProcessId;
}

export class SubprojectBoundary {
	private readonly byKey: ReadonlyMap<string, OpenProject>;

	private constructor(projects: ReadonlyArray<OpenProject>) {
		this.byKey = new Map(projects.map((project) => [project.id.key, project]));
	}

	static of(projects: ReadonlyArray<OpenProject>): SubprojectBoundary {
		return new SubprojectBoundary(projects);
	}

	/** Why `from` may not reach `to`, or `undefined` when it may. The caller names both ends. */
	refusal(from: From, to: Side): string | undefined {
		const source = from.project;
		const target = to.project;
		if (source === undefined || target === undefined) return undefined;
		if (source.id.key === target.id.key) return undefined;
		if (this.isNestedUnder(source, target)) {
			return "a subproject cannot reach up to the project it is nested under";
		}
		if (!this.isNestedUnder(target, source)) return undefined;
		const entry = this.entryBelow(source, target);
		if (entry.under?.parent.key === source.id.key && entry.under.opener === from.process) {
			return entry === target
				? undefined
				: "it runs in a subproject nested further down, which only that subproject's opener reaches into";
		}
		return "it runs in a subproject, and only the program that opened the subproject reaches into it";
	}

	/** Whether `inner` is nested under `outer` at any depth. */
	private isNestedUnder(inner: OpenProject, outer: OpenProject): boolean {
		for (let at = this.parentOf(inner); at !== undefined; at = this.parentOf(at)) {
			if (at.id.key === outer.id.key) return true;
		}
		return false;
	}

	/** The subproject directly under `outer` that `inner` is nested in, or `inner` itself. */
	private entryBelow(outer: OpenProject, inner: OpenProject): OpenProject {
		let at = inner;
		for (let parent = this.parentOf(at); parent !== undefined; parent = this.parentOf(at)) {
			if (parent.id.key === outer.id.key) return at;
			at = parent;
		}
		return at;
	}

	private parentOf(project: OpenProject): OpenProject | undefined {
		const key = project.under?.parent.key;
		return key === undefined ? undefined : this.byKey.get(key);
	}
}
