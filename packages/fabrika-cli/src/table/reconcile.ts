/**
 * What it takes to bring a project to the table's shape, as data: the steps to take, the drift to
 * report, and the conflicts that refuse. Pure, so idempotence is a property of this function —
 * a project already in shape plans no step — rather than of a live run.
 *
 * **Setup only adds and aligns; it never deletes or renames.** A field, view or option a person added
 * stays. A field whose name the table needs but whose type differs is a conflict, because changing
 * its type would drop every value it holds. A single-select field missing some of the table's
 * options is drift, reported for a person to add: the API that edits options replaces the whole
 * list, and a replace is one mistake away from deleting options that carry values.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import type {FieldSpec, ProjectField, ProjectSnapshot, ViewLayout} from "../io/projects.ts";
import type {TableShape, ViewShape} from "./shape.ts";

export type Step =
	| {readonly _tag: "CreateField"; readonly spec: FieldSpec}
	| {readonly _tag: "CreateView"; readonly view: ViewShape}
	| {
			readonly _tag: "UpdateView";
			readonly viewId: string;
			readonly view: ViewShape;
			readonly layout: ViewLayout | null;
			readonly filter: string | null;
			/** The whole visible list to write, or `null` when every table field already shows. */
			readonly visibleFieldIds: ReadonlyArray<string> | null;
	  }
	| {
			readonly _tag: "UpdateProject";
			readonly readme: string | null;
			readonly shortDescription: string | null;
	  };

export type Drift =
	| {
			readonly _tag: "MissingOptions";
			readonly field: string;
			readonly options: ReadonlyArray<string>;
	  }
	| {
			readonly _tag: "IterationLength";
			readonly field: string;
			readonly days: number;
			readonly wanted: number;
	  };

export interface Conflict {
	readonly field: string;
	readonly wanted: FieldSpec["_tag"];
	readonly found: string;
}

export interface Plan {
	readonly steps: ReadonlyArray<Step>;
	readonly drift: ReadonlyArray<Drift>;
	readonly conflicts: ReadonlyArray<Conflict>;
}

const kindOf = (field: ProjectField): string =>
	field._tag === "Plain"
		? field.dataType
		: field._tag === "SingleSelect"
			? "SINGLE_SELECT"
			: "ITERATION";

const matches = (spec: FieldSpec, field: ProjectField): boolean => {
	switch (spec._tag) {
		case "Text":
			return field._tag === "Plain" && field.dataType === "TEXT";
		case "Number":
			return field._tag === "Plain" && field.dataType === "NUMBER";
		case "SingleSelect":
			return field._tag === "SingleSelect";
		case "Iteration":
			return field._tag === "Iteration";
	}
};

const fieldDrift = (spec: FieldSpec, field: ProjectField): Drift | null => {
	if (spec._tag === "SingleSelect" && field._tag === "SingleSelect") {
		const have = new Set(field.options.map((option) => option.name));
		const missing = spec.options.map((option) => option.name).filter((name) => !have.has(name));
		return missing.length > 0 ? {_tag: "MissingOptions", field: spec.name, options: missing} : null;
	}
	if (spec._tag === "Iteration" && field._tag === "Iteration" && field.duration !== spec.duration) {
		return {_tag: "IterationLength", field: spec.name, days: field.duration, wanted: spec.duration};
	}
	return null;
};

/**
 * The visible list a view should carry, or `null` when it already shows every table field. The
 * table's fields lead in their order; any field a person made visible stays after them. A table field
 * the project does not have yet is left out — the next plan, after it exists, adds it.
 */
const visibleList = (
	view: ViewShape,
	current: ReadonlyArray<string>,
	idOf: ReadonlyMap<string, string>,
): ReadonlyArray<string> | null => {
	const wanted = view.fields.flatMap((name) => {
		const id = idOf.get(name);
		return id === undefined ? [] : [id];
	});
	if (wanted.every((id) => current.includes(id))) return null;
	return [...wanted, ...current.filter((id) => !wanted.includes(id))];
};

export const plan = (shape: TableShape, project: ProjectSnapshot): Plan => {
	const steps: Step[] = [];
	const drift: Drift[] = [];
	const conflicts: Conflict[] = [];

	for (const spec of shape.fields) {
		const found = project.fields.find((field) => field.name === spec.name);
		if (found === undefined) {
			steps.push({_tag: "CreateField", spec});
			continue;
		}
		if (!matches(spec, found)) {
			conflicts.push({field: spec.name, wanted: spec._tag, found: kindOf(found)});
			continue;
		}
		const off = fieldDrift(spec, found);
		if (off !== null) drift.push(off);
	}

	const idOf = new Map(project.fields.map((field) => [field.name, field.id] as const));
	for (const view of shape.views) {
		const found = project.views.find((candidate) => candidate.name === view.name);
		if (found === undefined) {
			steps.push({_tag: "CreateView", view});
			continue;
		}
		const layout = found.layout === view.layout ? null : view.layout;
		const filter = found.filter === view.filter ? null : view.filter;
		const visibleFieldIds = visibleList(view, found.visibleFieldIds, idOf);
		if (layout !== null || filter !== null || visibleFieldIds !== null) {
			steps.push({_tag: "UpdateView", viewId: found.id, view, layout, filter, visibleFieldIds});
		}
	}

	const readme = project.readme === shape.readme ? null : shape.readme;
	const shortDescription =
		project.shortDescription === shape.shortDescription ? null : shape.shortDescription;
	if (readme !== null || shortDescription !== null) {
		steps.push({_tag: "UpdateProject", readme, shortDescription});
	}

	return {steps, drift, conflicts};
};

/** One line per step, as the verb reports what it changed. */
export const describeStep = (step: Step): string => {
	switch (step._tag) {
		case "CreateField":
			return `created field ${step.spec.name}`;
		case "CreateView":
			return `created view ${step.view.name}`;
		case "UpdateView": {
			const parts = [
				step.layout !== null ? "layout" : null,
				step.filter !== null ? "filter" : null,
				step.visibleFieldIds !== null ? "visible fields" : null,
			].filter((part) => part !== null);
			return `aligned view ${step.view.name} (${parts.join(", ")})`;
		}
		case "UpdateProject": {
			const parts = [
				step.readme !== null ? "README" : null,
				step.shortDescription !== null ? "short description" : null,
			].filter((part) => part !== null);
			return `wrote the project ${parts.join(" and ")}`;
		}
	}
};

export const describeDrift = (drift: Drift): string =>
	drift._tag === "MissingOptions"
		? `field ${drift.field} lacks the option(s) ${drift.options.map((name) => `"${name}"`).join(", ")} — add them by hand in the field's settings; setup never rewrites an existing field's options`
		: `field ${drift.field} runs ${drift.days}-day iterations, the table's cadence wants ${drift.wanted} — change it by hand in the field's settings if that is not deliberate`;
