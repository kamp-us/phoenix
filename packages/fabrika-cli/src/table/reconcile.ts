/**
 * What it takes to bring a project to the table's shape, as data: the steps to take and the
 * conflicts that refuse. Pure, so idempotence is a property of this function — a project already
 * in shape plans no step — rather than of a live run.
 *
 * **Setup only adds and fills; it never deletes, renames or recolors.** A field, view or option a
 * person added stays. A field whose name the table needs but whose type differs is a conflict,
 * because changing its type would drop every value it holds. A single-select field missing some of
 * the table's options gets them added, and an option of the table's whose description is blank gets
 * the table's text; a description a person wrote stays as written, whatever the table says. A field
 * an older shape used — the Week iteration — is legacy: left exactly as it is, and named so a person
 * knows it no longer drives the table.
 *
 * **Setup owns only its marked section of the README.** A person's README text before and after
 * fabrika's markers stays byte for byte, and a README with no markers keeps its text with the
 * section appended below it. The short description is written only when it is empty; one a person
 * wrote is drift, reported for them to change by hand, never overwritten.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 * @ruling https://github.com/kamp-us/phoenix/issues/9989
 * @ruling https://github.com/kamp-us/phoenix/issues/10083
 * @ruling https://github.com/kamp-us/phoenix/issues/10084
 * @ruling https://github.com/kamp-us/phoenix/issues/10089
 */

import type {
	FieldSpec,
	NewOption,
	ProjectField,
	ProjectSnapshot,
	SelectOption,
	ViewLayout,
} from "../io/projects.ts";
import {mergeReadme, type ReadmeCase} from "./readme-section.ts";
import type {TableShape, ViewShape} from "./shape.ts";

export type Step =
	| {readonly _tag: "CreateField"; readonly spec: FieldSpec}
	| {
			readonly _tag: "UpdateOptions";
			readonly fieldId: string;
			readonly field: string;
			/** Every option the field holds, in its order, a blank description filled where the table has one. */
			readonly kept: ReadonlyArray<SelectOption>;
			readonly added: ReadonlyArray<NewOption>;
			/** The kept options whose blank description this step fills. */
			readonly filled: ReadonlyArray<string>;
	  }
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
			readonly readme: {readonly case: ReadmeCase; readonly text: string} | null;
			/** Only ever written over an empty short description. */
			readonly shortDescription: string | null;
	  };

/** Something a person wrote that differs from the table's, left as it is for them to change by hand. */
export type Drift =
	| {readonly _tag: "ShortDescription"; readonly found: string; readonly wanted: string}
	| {readonly _tag: "BrokenReadmeMarkers"; readonly section: string};

export interface Conflict {
	readonly field: string;
	readonly wanted: FieldSpec["_tag"];
	readonly found: string;
}

/** A field an older shape used, found on the project and left in place. */
export interface Legacy {
	readonly field: string;
	/** Its type as the project reads it: `ITERATION` for the Week field. */
	readonly kind: string;
}

export interface Plan {
	readonly steps: ReadonlyArray<Step>;
	readonly drift: ReadonlyArray<Drift>;
	readonly conflicts: ReadonlyArray<Conflict>;
	readonly legacy: ReadonlyArray<Legacy>;
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
		case "Date":
			return field._tag === "Plain" && field.dataType === "DATE";
	}
};

const optionStep = (
	spec: Extract<FieldSpec, {_tag: "SingleSelect"}>,
	field: Extract<ProjectField, {_tag: "SingleSelect"}>,
): Step | null => {
	const wanted = new Map(spec.options.map((option) => [option.name, option] as const));
	const filled: string[] = [];
	const kept = field.options.map((option): SelectOption => {
		const description = wanted.get(option.name)?.description ?? "";
		if (option.description !== "" || description === "") return option;
		filled.push(option.name);
		return {...option, description};
	});
	const have = new Set(field.options.map((option) => option.name));
	const added = spec.options.filter((option) => !have.has(option.name));
	return added.length === 0 && filled.length === 0
		? null
		: {_tag: "UpdateOptions", fieldId: field.id, field: field.name, kept, added, filled};
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
		if (spec._tag === "SingleSelect" && found._tag === "SingleSelect") {
			const step = optionStep(spec, found);
			if (step !== null) steps.push(step);
		}
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

	const legacy = shape.legacy.flatMap((name): ReadonlyArray<Legacy> => {
		const found = project.fields.find((field) => field.name === name);
		return found === undefined ? [] : [{field: name, kind: kindOf(found)}];
	});

	const drift: Drift[] = [];
	const merged = mergeReadme(project.readme, shape.readme);
	if (merged._tag === "Broken") {
		drift.push({_tag: "BrokenReadmeMarkers", section: shape.readme.name});
	}
	const readme = merged._tag === "Write" ? {case: merged.case, text: merged.readme} : null;
	const shortDescription = project.shortDescription === null ? shape.shortDescription : null;
	if (project.shortDescription !== null && project.shortDescription !== shape.shortDescription) {
		drift.push({
			_tag: "ShortDescription",
			found: project.shortDescription,
			wanted: shape.shortDescription,
		});
	}
	if (readme !== null || shortDescription !== null) {
		steps.push({_tag: "UpdateProject", readme, shortDescription});
	}

	return {steps, drift, conflicts, legacy};
};

/** One line per step, as the verb reports what it changed. */
export const describeStep = (step: Step): string => {
	switch (step._tag) {
		case "CreateField":
			return `created field ${step.spec.name}`;
		case "UpdateOptions": {
			const quoted = (names: ReadonlyArray<string>) => names.map((name) => `"${name}"`).join(", ");
			const parts = [
				step.added.length > 0
					? `added the option(s) ${quoted(step.added.map((option) => option.name))}`
					: null,
				step.filled.length > 0 ? `filled the blank description(s) of ${quoted(step.filled)}` : null,
			].filter((part) => part !== null);
			return `field ${step.field}: ${parts.join("; ")}`;
		}
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
				step.readme !== null ? readmeWords[step.readme.case] : null,
				step.shortDescription !== null ? "wrote the empty project short description" : null,
			].filter((part) => part !== null);
			return parts.join("; ");
		}
	}
};

const readmeWords: Record<ReadmeCase, string> = {
	Fresh: "wrote fabrika's section as the empty project README",
	Marked: "marked the project README fabrika wrote earlier as fabrika's section",
	Appended: "kept the project README's own text and added fabrika's section below it",
	Rewrote: "rewrote fabrika's section of the project README, keeping the text around it",
};

/** One line per drift, telling a person what to change by hand. */
export const describeDrift = (drift: Drift): string => {
	switch (drift._tag) {
		case "ShortDescription":
			return `the project short description reads "${drift.found}", not the table's "${drift.wanted}" — setup leaves it as written; change it by hand in the project's settings if you want the table's`;
		case "BrokenReadmeMarkers":
			return `the project README's fabrika:${drift.section} markers are not one start marker followed by one end marker — setup left the README as it is; fix or remove the markers by hand, then re-run`;
	}
};

export const describeLegacy = (legacy: Legacy): string =>
	`field ${legacy.field} (${legacy.kind}) is legacy: the table no longer reads or writes it, and setup leaves it in place — \`fabrika table migrate-week\` copies its dates into Table day once`;
