/**
 * The Projects client against recorded GitHub answers. Each reply body below is a live response's
 * shape, trimmed and with its identifiers anonymised: the project read off an example table project,
 * an item's values, GitHub's `NOT_FOUND` for a missing project number and its `INSUFFICIENT_SCOPES`
 * refusal.
 */

import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {describe, expect, it} from "vitest";
import {fakeHttp, type HttpReply} from "../fakes.test-support.ts";
import {
	addItem,
	clearFieldValue,
	createField,
	PROJECT_SCOPE_FIX,
	postStatusUpdate,
	readItems,
	readItemValues,
	readIterationHistory,
	readProjectByNumber,
	readRepository,
	readWeekField,
	scopeWithheld,
	setFieldValue,
	updateView,
} from "./projects.ts";

const GRAPHQL = /^POST https:\/\/api\.github\.com\/graphql$/;
const TOKEN = "ghp_scripted";

const reply = (body: unknown, headers: Record<string, string> = {}): HttpReply => ({
	status: 200,
	body: JSON.stringify(body),
	headers: {"x-oauth-scopes": "gist, project, read:org, repo", ...headers},
});

/** One call, one recorded reply: every GraphQL request goes to one URL, so a script row is a reply. */
const runWith = async <A>(
	replies: readonly [HttpReply],
	use: () => Effect.Effect<A, never, HttpClient.HttpClient>,
) => {
	const http = fakeHttp([[GRAPHQL, replies[0]]]);
	const result = await Effect.runPromise(Effect.provide(use(), http.layer));
	return {result, http};
};

const RECORDED_PROJECT = {
	id: "PVT_example",
	number: 20,
	url: "https://github.com/orgs/acme/projects/20",
	title: "Example table",
	shortDescription: "Example weekly betting table",
	readme: "# How to use this table",
	fields: {
		pageInfo: {hasNextPage: false},
		nodes: [
			{__typename: "ProjectV2Field", id: "F_title", name: "Title", dataType: "TITLE"},
			{
				__typename: "ProjectV2SingleSelectField",
				id: "F_stage",
				name: "Stage",
				dataType: "SINGLE_SELECT",
				options: [
					{id: "o_proposed", name: "proposed", color: "GRAY", description: ""},
					{id: "o_bet", name: "bet", color: "GRAY", description: ""},
				],
			},
			{__typename: "ProjectV2Field", id: "F_spent", name: "Spent $", dataType: "NUMBER"},
			{
				__typename: "ProjectV2IterationField",
				id: "F_week",
				name: "Week",
				dataType: "ITERATION",
				configuration: {duration: 7, startDay: 6},
			},
		],
	},
	views: {
		pageInfo: {hasNextPage: false},
		nodes: [
			{
				id: "V_inbox",
				number: 6,
				name: "Inbox",
				layout: "TABLE_LAYOUT",
				filter: "is:open no:label",
				fields: {pageInfo: {hasNextPage: false}, nodes: [{id: "F_title"}]},
			},
		],
	},
};

describe("reading a project", () => {
	it("reads fields by kind, views with their filters and visible fields", async () => {
		const {result} = await runWith(
			[reply({data: {repositoryOwner: {projectV2: RECORDED_PROJECT}}})],
			() => readProjectByNumber(TOKEN, "acme", 20),
		);

		expect(result._tag).toBe("Ok");
		if (result._tag !== "Ok" || result.value === null) return;
		expect(result.value.fields.map((field) => [field.name, field._tag])).toEqual([
			["Title", "Plain"],
			["Stage", "SingleSelect"],
			["Spent $", "Plain"],
			["Week", "Iteration"],
		]);
		expect(result.value.fields[3]).toMatchObject({duration: 7, startDay: 6});
		expect(result.value.views[0]).toEqual({
			id: "V_inbox",
			number: 6,
			name: "Inbox",
			layout: "TABLE_LAYOUT",
			filter: "is:open no:label",
			visibleFieldIds: ["F_title"],
		});
	});

	it("reads GitHub's NOT_FOUND on a project number as a project proven absent", async () => {
		const {result} = await runWith(
			[
				reply({
					data: {repositoryOwner: {projectV2: null}},
					errors: [
						{
							type: "NOT_FOUND",
							path: ["repositoryOwner", "projectV2"],
							locations: [{line: 1, column: 34}],
							message: "Could not resolve to a ProjectV2 with the number 9999.",
						},
					],
				}),
			],
			() => readProjectByNumber(TOKEN, "acme", 9999),
		);

		expect(result).toEqual({_tag: "Ok", value: null});
	});

	it("refuses a field page GitHub cut short, rather than answering a shorter list", async () => {
		const cut = {
			...RECORDED_PROJECT,
			fields: {...RECORDED_PROJECT.fields, pageInfo: {hasNextPage: true}},
		};
		const {result} = await runWith([reply({data: {repositoryOwner: {projectV2: cut}}})], () =>
			readProjectByNumber(TOKEN, "acme", 20),
		);

		expect(result._tag).toBe("Failed");
	});

	it("reads the repository, its owner and its linked projects", async () => {
		const {result} = await runWith(
			[
				reply({
					data: {
						repository: {
							id: "R_1",
							owner: {id: "O_1", login: "acme"},
							projectsV2: {
								pageInfo: {hasNextPage: false, endCursor: null},
								nodes: [{id: "PVT_1", number: 3, title: "widgets table", closed: false}],
							},
						},
					},
				}),
			],
			() => readRepository(TOKEN, "acme/widgets"),
		);

		expect(result).toEqual({
			_tag: "Ok",
			value: {
				id: "R_1",
				owner: {id: "O_1", login: "acme"},
				linkedProjects: [{id: "PVT_1", number: 3, title: "widgets table", closed: false}],
			},
		});
	});
});

describe("the project scope", () => {
	it("is read off X-OAuth-Scopes when the token declares its scopes", () => {
		expect(scopeWithheld({"x-oauth-scopes": "gist, project, read:org, repo"})).toBe(false);
		expect(scopeWithheld({"x-oauth-scopes": "repo, read:project"})).toBe(true);
		expect(scopeWithheld({"x-oauth-scopes": ""})).toBe(true);
		expect(scopeWithheld({})).toBeNull();
	});

	it("refuses with the exact fix when the header withholds it", async () => {
		const {result} = await runWith(
			[reply({data: {repository: null}}, {"x-oauth-scopes": "repo"})],
			() => readRepository(TOKEN, "acme/widgets"),
		);

		expect(result._tag).toBe("MissingScope");
		if (result._tag !== "MissingScope") return;
		expect(result.reason).toContain(PROJECT_SCOPE_FIX);
	});

	it("refuses with the exact fix on GitHub's INSUFFICIENT_SCOPES error from a token that lists no scopes", async () => {
		const {result} = await runWith(
			[
				{
					status: 200,
					body: JSON.stringify({
						data: null,
						errors: [
							{
								type: "INSUFFICIENT_SCOPES",
								locations: [{line: 5, column: 5}],
								message:
									"Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes.",
							},
						],
					}),
				},
			],
			() => readRepository(TOKEN, "acme/widgets"),
		);

		expect(result._tag).toBe("MissingScope");
		if (result._tag !== "MissingScope") return;
		expect(result.reason).toContain("gh auth refresh -h github.com -s project");
	});
});

describe("writing to a project", () => {
	it("creates an iteration field with its first iteration", async () => {
		const {result, http} = await runWith(
			[reply({data: {createProjectV2Field: {projectV2Field: {id: "F_new"}}}})],
			() =>
				createField(TOKEN, "PVT_1", {
					_tag: "Iteration",
					name: "Week",
					startDate: "2026-09-28",
					duration: 7,
					firstTitle: "Sep 28",
				}),
		);

		expect(result).toEqual({_tag: "Ok", value: "F_new"});
		const sent = JSON.parse(http.bodies[0] ?? "{}");
		expect(sent.variables.input).toEqual({
			projectId: "PVT_1",
			name: "Week",
			dataType: "ITERATION",
			iterationConfiguration: {
				startDate: "2026-09-28",
				duration: 7,
				iterations: [{startDate: "2026-09-28", duration: 7, title: "Sep 28"}],
			},
		});
	});

	it("sends only the view settings it was asked to change", async () => {
		const {http} = await runWith(
			[reply({data: {updateProjectV2View: {projectV2View: {id: "V_1"}}}})],
			() => updateView(TOKEN, "V_1", {filter: "is:open no:label"}),
		);

		expect(JSON.parse(http.bodies[0] ?? "{}").variables.input).toEqual({
			viewId: "V_1",
			filter: "is:open no:label",
		});
	});

	it("adds an item and sets a single-select value by option id", async () => {
		const added = await runWith(
			[reply({data: {addProjectV2ItemById: {item: {id: "PVTI_1"}}}})],
			() => addItem(TOKEN, "PVT_1", "I_issue"),
		);
		expect(added.result).toEqual({_tag: "Ok", value: "PVTI_1"});

		const set = await runWith(
			[reply({data: {updateProjectV2ItemFieldValue: {projectV2Item: {id: "PVTI_1"}}}})],
			() =>
				setFieldValue(
					TOKEN,
					{projectId: "PVT_1", itemId: "PVTI_1", fieldId: "F_stage"},
					{_tag: "Option", optionId: "o_bet"},
				),
		);
		expect(set.result).toEqual({_tag: "Ok", value: "PVTI_1"});
		expect(JSON.parse(set.http.bodies[0] ?? "{}").variables.input.value).toEqual({
			singleSelectOptionId: "o_bet",
		});
	});

	it("posts a status update", async () => {
		const {result, http} = await runWith(
			[reply({data: {createProjectV2StatusUpdate: {statusUpdate: {id: "PVTSU_1"}}}})],
			() => postStatusUpdate(TOKEN, "PVT_1", {body: "4 bets continuing", status: "ON_TRACK"}),
		);

		expect(result).toEqual({_tag: "Ok", value: "PVTSU_1"});
		expect(JSON.parse(http.bodies[0] ?? "{}").variables.input).toEqual({
			projectId: "PVT_1",
			body: "4 bets continuing",
			status: "ON_TRACK",
		});
	});
});

describe("reading an item's values", () => {
	it("carries each value's creator and updatedAt, and skips the issue's own values", async () => {
		const {result} = await runWith(
			[
				reply({
					data: {
						node: {
							id: "PVTI_1",
							content: {number: 12},
							fieldValues: {
								pageInfo: {hasNextPage: false},
								nodes: [
									{__typename: "ProjectV2ItemFieldRepositoryValue"},
									{__typename: "ProjectV2ItemFieldLabelValue"},
									{
										__typename: "ProjectV2ItemFieldIterationValue",
										title: "Sep 26",
										iterationId: "c11f1bd7",
										creator: {login: "octo-owner"},
										updatedAt: "2026-09-26T23:09:24Z",
										field: {id: "F_week", name: "Week"},
									},
									{
										__typename: "ProjectV2ItemFieldSingleSelectValue",
										name: "bet",
										optionId: "o_bet",
										creator: {login: "octo-owner"},
										updatedAt: "2026-09-27T04:38:33Z",
										field: {id: "F_stage", name: "Stage"},
									},
									{
										__typename: "ProjectV2ItemFieldNumberValue",
										number: 12.5,
										creator: null,
										updatedAt: "2026-09-27T05:00:00Z",
										field: {id: "F_spent", name: "Spent $"},
									},
								],
							},
						},
					},
				}),
			],
			() => readItemValues(TOKEN, "PVTI_1"),
		);

		expect(result).toEqual({
			_tag: "Ok",
			value: {
				itemId: "PVTI_1",
				contentNumber: 12,
				values: [
					{
						fieldId: "F_week",
						fieldName: "Week",
						value: {_tag: "Iteration", iterationId: "c11f1bd7", title: "Sep 26"},
						creator: "octo-owner",
						updatedAt: "2026-09-26T23:09:24Z",
					},
					{
						fieldId: "F_stage",
						fieldName: "Stage",
						value: {_tag: "Option", optionId: "o_bet", name: "bet"},
						creator: "octo-owner",
						updatedAt: "2026-09-27T04:38:33Z",
					},
					{
						fieldId: "F_spent",
						fieldName: "Spent $",
						value: {_tag: "Number", number: 12.5},
						creator: null,
						updatedAt: "2026-09-27T05:00:00Z",
					},
				],
			},
		});
	});

	const META = {creator: {login: "octo-owner"}, updatedAt: "2026-09-27T05:00:00Z"};
	const FIELD = {field: {id: "F_x", name: "X"}};

	it.each([
		["a text value with no text", {__typename: "ProjectV2ItemFieldTextValue", ...META, ...FIELD}],
		[
			"a number value whose number is a string",
			{__typename: "ProjectV2ItemFieldNumberValue", number: "3", ...META, ...FIELD},
		],
		["a date value with no date", {__typename: "ProjectV2ItemFieldDateValue", ...META, ...FIELD}],
		[
			"a single-select value with no option id",
			{__typename: "ProjectV2ItemFieldSingleSelectValue", name: "bet", ...META, ...FIELD},
		],
		[
			"an iteration value with no title",
			{__typename: "ProjectV2ItemFieldIterationValue", iterationId: "c11f1bd7", ...META, ...FIELD},
		],
		[
			"a well-formed value whose field names no id",
			{__typename: "ProjectV2ItemFieldTextValue", text: "hi", ...META, field: {name: "X"}},
		],
		[
			"a well-formed value with no field",
			{__typename: "ProjectV2ItemFieldTextValue", text: "hi", ...META},
		],
	])("refuses %s rather than answering a shorter list", async (_, malformed) => {
		const {result} = await runWith(
			[
				reply({
					data: {
						node: {
							id: "PVTI_1",
							content: {number: 12},
							fieldValues: {pageInfo: {hasNextPage: false}, nodes: [malformed]},
						},
					},
				}),
			],
			() => readItemValues(TOKEN, "PVTI_1"),
		);

		expect(result._tag).toBe("Failed");
		expect(result._tag === "Failed" && result.reason).toContain(malformed.__typename);
	});
});

describe("the table's sync reads", () => {
	it("reads every item with what it stands for, drafts and pull requests included", async () => {
		const {result} = await runWith(
			[
				reply({
					data: {
						node: {
							items: {
								pageInfo: {hasNextPage: false, endCursor: null},
								nodes: [
									{
										id: "PVTI_issue",
										content: {
											__typename: "Issue",
											number: 7665,
											repository: {nameWithOwner: "acme/widgets"},
										},
										fieldValues: {
											pageInfo: {hasNextPage: false},
											nodes: [
												{__typename: "ProjectV2ItemFieldRepositoryValue"},
												{
													__typename: "ProjectV2ItemFieldSingleSelectValue",
													name: "bet",
													optionId: "o_bet",
													creator: {login: "octo-owner"},
													updatedAt: "2026-09-27T04:38:33Z",
													field: {id: "F_stage", name: "Stage"},
												},
											],
										},
									},
									{
										id: "PVTI_draft",
										content: {__typename: "DraftIssue"},
										fieldValues: {pageInfo: {hasNextPage: false}, nodes: []},
									},
								],
							},
						},
					},
				}),
			],
			() => readItems(TOKEN, "PVT_example"),
		);

		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{
					itemId: "PVTI_issue",
					contentNumber: 7665,
					contentType: "Issue",
					repository: "acme/widgets",
					values: [
						{
							fieldId: "F_stage",
							fieldName: "Stage",
							value: {_tag: "Option", optionId: "o_bet", name: "bet"},
							creator: "octo-owner",
							updatedAt: "2026-09-27T04:38:33Z",
						},
					],
				},
				{
					itemId: "PVTI_draft",
					contentNumber: null,
					contentType: "DraftIssue",
					repository: null,
					values: [],
				},
			],
		});
	});

	it("clears one value", async () => {
		const {result, http} = await runWith(
			[reply({data: {clearProjectV2ItemFieldValue: {projectV2Item: {id: "PVTI_1"}}}})],
			() => clearFieldValue(TOKEN, {projectId: "PVT_1", itemId: "PVTI_1", fieldId: "F_section"}),
		);

		expect(result).toEqual({_tag: "Ok", value: "PVTI_1"});
		expect(JSON.parse(http.bodies[0] ?? "{}").variables.input).toEqual({
			projectId: "PVT_1",
			itemId: "PVTI_1",
			fieldId: "F_section",
		});
	});
});

describe("the Week field's history", () => {
	const week = {
		__typename: "ProjectV2IterationField",
		configuration: {
			iterations: [{id: "it_3", title: "Sep 28", startDate: "2026-09-28", duration: 7}],
			completedIterations: [
				{id: "it_1", title: "Sep 14", startDate: "2026-09-14", duration: 7},
				{id: "it_2", title: "Sep 21", startDate: "2026-09-21", duration: 7},
			],
		},
	};

	it("reads the running iterations apart from the finished ones", async () => {
		const {result} = await runWith([reply({data: {node: {field: week}}})], () =>
			readIterationHistory(TOKEN, "PVT_1", "Week"),
		);

		expect(result).toEqual({
			_tag: "Ok",
			value: {
				running: [{id: "it_3", title: "Sep 28", startDate: "2026-09-28", duration: 7}],
				completed: [
					{id: "it_1", title: "Sep 14", startDate: "2026-09-14", duration: 7},
					{id: "it_2", title: "Sep 21", startDate: "2026-09-21", duration: 7},
				],
			},
		});
	});

	it("answers null for a project with no iteration field under that name", () => {
		expect(readWeekField({node: {field: null}})).toEqual({_tag: "Ok", value: null});
	});

	it("fails rather than read a missing finished list as none", () => {
		const cut = {...week, configuration: {iterations: week.configuration.iterations}};

		expect(readWeekField({node: {field: cut}})._tag).toBe("Failure");
	});
});
