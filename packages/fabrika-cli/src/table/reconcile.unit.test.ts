/**
 * `plan` over one standing single-select field: the options the table lacks are added, a blank
 * description is filled, and a description a person wrote is kept — none of it is drift.
 */
import {describe, expect, it} from "vitest";
import type {ProjectField, ProjectSnapshot, SelectOption} from "../io/projects.ts";
import {markedSection} from "./readme-section.ts";
import {describeStep, plan, type Step} from "./reconcile.ts";
import {ORIGINS, type TableShape} from "./shape.ts";

const originSpec = {
	_tag: "SingleSelect",
	name: "Origin",
	options: ORIGINS.map((origin) => ({...origin, color: "GRAY" as const})),
} as const;

const SHAPE: TableShape = {
	title: "widgets table",
	shortDescription: "",
	readme: {name: "table", body: "# How to use this table"},
	fields: [originSpec],
	views: [],
	legacy: [],
	manualSteps: [],
};

const described = (name: string): string =>
	ORIGINS.find((origin) => origin.name === name)?.description ?? "";

const option = (name: string, description = described(name)): SelectOption => ({
	id: `opt_${name}`,
	name,
	color: "BLUE",
	description,
});

const projectWith = (options: ReadonlyArray<SelectOption>): ProjectSnapshot => ({
	id: "PVT_20",
	number: 20,
	owner: {kind: "Organization", login: "acme"},
	url: "https://github.com/orgs/acme/projects/20",
	title: "widgets table",
	shortDescription: "",
	readme: markedSection(SHAPE.readme),
	fields: [{_tag: "SingleSelect", id: "F_origin", databaseId: 1, name: "Origin", options}],
	views: [],
});

/** The project as GitHub would read it after `step` landed: kept options, then the added ones minted. */
const applied = (project: ProjectSnapshot, step: Step): ProjectSnapshot => {
	if (step._tag !== "UpdateOptions") throw new Error(`unexpected step ${step._tag}`);
	const field: ProjectField = {
		_tag: "SingleSelect",
		id: step.fieldId,
		databaseId: 1,
		name: step.field,
		options: [...step.kept, ...step.added.map((added) => ({...added, id: `minted_${added.name}`}))],
	};
	return {...project, fields: [field]};
};

const optionSteps = (project: ProjectSnapshot) =>
	plan(SHAPE, project).steps.filter((step) => step._tag === "UpdateOptions");

describe("plan over a standing single-select field", () => {
	const allButHandStart = ORIGINS.filter((origin) => origin.name !== "hand-start").map((origin) =>
		option(origin.name),
	);

	it("adds the one option the field lacks, keeping every option it has, and reports no drift", () => {
		const project = projectWith([option("founder idea", ""), ...allButHandStart]);

		const result = plan(SHAPE, project);

		expect(result.drift).toEqual([]);
		expect(result.steps).toEqual([
			{
				_tag: "UpdateOptions",
				fieldId: "F_origin",
				field: "Origin",
				kept: project.fields[0]?._tag === "SingleSelect" ? project.fields[0].options : [],
				added: [{name: "hand-start", color: "GRAY", description: described("hand-start")}],
				filled: [],
			},
		]);
		expect(describeStep(result.steps[0] as Step)).toBe(
			'field Origin: added the option(s) "hand-start"',
		);
	});

	it("never deletes, renames or recolors an option, and plans nothing once the update landed", () => {
		const project = projectWith([
			option("founder idea", "An idea from the founder."),
			...allButHandStart,
		]);
		const [step] = optionSteps(project);
		if (step?._tag !== "UpdateOptions") throw new Error("no option step");

		expect(step.kept.map((kept) => [kept.id, kept.name, kept.color, kept.description])).toEqual(
			[option("founder idea", "An idea from the founder."), ...allButHandStart].map((kept) => [
				kept.id,
				kept.name,
				kept.color,
				kept.description,
			]),
		);
		expect(plan(SHAPE, applied(project, step)).steps).toEqual([]);
	});

	it("fills every blank description of the table's options, leaving a blank on an option it does not name", () => {
		const blank = [option("founder idea", ""), ...ORIGINS.map((origin) => option(origin.name, ""))];
		const project = projectWith(blank);

		const [step] = optionSteps(project);
		if (step?._tag !== "UpdateOptions") throw new Error("no option step");

		expect(step.added).toEqual([]);
		expect(step.filled).toEqual(ORIGINS.map((origin) => origin.name));
		expect(step.kept).toEqual([
			option("founder idea", ""),
			...ORIGINS.map((origin) => option(origin.name)),
		]);
		expect(describeStep(step)).toBe(
			`field Origin: filled the blank description(s) of ${ORIGINS.map((origin) => `"${origin.name}"`).join(", ")}`,
		);
		expect(plan(SHAPE, applied(project, step)).steps).toEqual([]);
	});

	it("keeps a description a person wrote differently, planning no step for it", () => {
		const project = projectWith(
			ORIGINS.map((origin) =>
				origin.name === "customer"
					? option(origin.name, "Someone looks within 4 hours")
					: option(origin.name),
			),
		);

		expect(plan(SHAPE, project).steps).toEqual([]);
	});
});
