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
	createView,
	deleteItem,
	PROJECT_SCOPE_FIX,
	postStatusUpdate,
	readItems,
	readItemValues,
	readIterationHistory,
	readProjectByNumber,
	readRepository,
	readStatusUpdates,
	readStatusUpdatesPage,
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
	owner: {__typename: "Organization", login: "acme"},
	shortDescription: "Example weekly betting table",
	readme: "# How to use this table",
	fields: {
		pageInfo: {hasNextPage: false},
		nodes: [
			{
				__typename: "ProjectV2Field",
				id: "F_title",
				databaseId: 417848925,
				name: "Title",
				dataType: "TITLE",
			},
			{
				__typename: "ProjectV2SingleSelectField",
				id: "F_stage",
				databaseId: 417848939,
				name: "Stage",
				dataType: "SINGLE_SELECT",
				options: [
					{id: "o_proposed", name: "proposed", color: "GRAY", description: ""},
					{id: "o_bet", name: "bet", color: "GRAY", description: ""},
				],
			},
			{
				__typename: "ProjectV2Field",
				id: "F_spent",
				databaseId: 417848940,
				name: "Spent $",
				dataType: "NUMBER",
			},
			{
				__typename: "ProjectV2Field",
				id: "F_day",
				databaseId: 417848941,
				name: "Table day",
				dataType: "DATE",
			},
			{
				__typename: "ProjectV2IterationField",
				id: "F_week",
				databaseId: 417848942,
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
	it("reads its owner, fields by kind with their numeric ids, and views with their filters", async () => {
		const {result} = await runWith(
			[reply({data: {repositoryOwner: {projectV2: RECORDED_PROJECT}}})],
			() => readProjectByNumber(TOKEN, "acme", 20),
		);

		expect(result._tag).toBe("Ok");
		if (result._tag !== "Ok" || result.value === null) return;
		expect(result.value.owner).toEqual({kind: "Organization", login: "acme"});
		expect(result.value.fields.map((field) => [field.name, field._tag, field.databaseId])).toEqual([
			["Title", "Plain", 417848925],
			["Stage", "SingleSelect", 417848939],
			["Spent $", "Plain", 417848940],
			["Table day", "Plain", 417848941],
			["Week", "Iteration", 417848942],
		]);
		expect(result.value.fields[3]).toMatchObject({dataType: "DATE"});
		expect(result.value.fields[4]).toMatchObject({duration: 7, startDay: 6});
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
	it("creates a date field with nothing but its name and type", async () => {
		const {result, http} = await runWith(
			[reply({data: {createProjectV2Field: {projectV2Field: {id: "F_new"}}}})],
			() => createField(TOKEN, "PVT_1", {_tag: "Date", name: "Table day"}),
		);

		expect(result).toEqual({_tag: "Ok", value: "F_new"});
		expect(JSON.parse(http.bodies[0] ?? "{}").variables.input).toEqual({
			projectId: "PVT_1",
			name: "Table day",
			dataType: "DATE",
		});
	});

	it("creates a view over REST under the owner's login, grouped as it is made", async () => {
		const created = {
			id: 49581678,
			node_id: "PVTV_new",
			number: 2,
			name: "Agenda",
			layout: "table",
			filter: "has:section",
			visible_fields: [417848925, 417848939],
			group_by: [417848939],
			vertical_group_by: [],
		};
		const orgs = fakeHttp([
			[
				/^POST https:\/\/api\.github\.com\/orgs\/acme\/projectsV2\/20\/views$/,
				{status: 201, body: JSON.stringify(created)},
			],
		]);
		const table = await Effect.runPromise(
			Effect.provide(
				createView(
					TOKEN,
					{owner: {kind: "Organization", login: "acme"}, number: 20},
					{
						name: "Agenda",
						layout: "TABLE_LAYOUT",
						filter: "has:section",
						visibleFields: [417848925, 417848939],
						grouping: {_tag: "Rows", fieldId: 417848939},
					},
				),
				orgs.layer,
			),
		);
		expect(table).toEqual({_tag: "Ok", value: "PVTV_new"});
		expect(JSON.parse(orgs.bodies[0] ?? "{}")).toEqual({
			name: "Agenda",
			layout: "table",
			filter: "has:section",
			visible_fields: [417848925, 417848939],
			group_by: [417848939],
		});

		const users = fakeHttp([
			[
				/^POST https:\/\/api\.github\.com\/users\/octo\/projectsV2\/3\/views$/,
				{status: 201, body: JSON.stringify({...created, layout: "board"})},
			],
		]);
		const board = await Effect.runPromise(
			Effect.provide(
				createView(
					TOKEN,
					{owner: {kind: "User", login: "octo"}, number: 3},
					{
						name: "Lanes",
						layout: "BOARD_LAYOUT",
						filter: "has:section",
						visibleFields: [417848925],
						grouping: {_tag: "Columns", fieldId: 417848939},
					},
				),
				users.layer,
			),
		);
		expect(board._tag).toBe("Ok");
		expect(JSON.parse(users.bodies[0] ?? "{}")).toMatchObject({
			layout: "board",
			vertical_group_by: [417848939],
		});
		expect(JSON.parse(users.bodies[0] ?? "{}")).not.toHaveProperty("group_by");
	});

	it("answers a REST refusal to create a view as a failure naming GitHub's message", async () => {
		const http = fakeHttp([
			[
				/^POST https:\/\/api\.github\.com\/orgs\/acme\/projectsV2\/20\/views$/,
				{status: 422, body: JSON.stringify({message: "Validation Failed"})},
			],
		]);
		const result = await Effect.runPromise(
			Effect.provide(
				createView(
					TOKEN,
					{owner: {kind: "Organization", login: "acme"}, number: 20},
					{
						name: "Inbox",
						layout: "TABLE_LAYOUT",
						filter: "is:open",
						visibleFields: [],
						grouping: {_tag: "None"},
					},
				),
				http.layer,
			),
		);
		expect(result).toEqual({_tag: "Failed", reason: "GitHub answered HTTP 422: Validation Failed"});
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

	const itemsPage = (nodes: ReadonlyArray<unknown>, pageInfo: Record<string, unknown>) =>
		reply({data: {node: {items: {pageInfo, nodes}}}});

	it("reads an item GitHub answers with no content as redacted, never as a draft", async () => {
		const {result} = await runWith(
			[
				itemsPage(
					[
						{
							id: "PVTI_hidden",
							content: null,
							fieldValues: {pageInfo: {hasNextPage: false}, nodes: []},
						},
					],
					{hasNextPage: false, endCursor: null},
				),
			],
			() => readItems(TOKEN, "PVT_example"),
		);

		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{
					itemId: "PVTI_hidden",
					contentNumber: null,
					contentType: "Redacted",
					repository: null,
					values: [],
				},
			],
		});
	});

	it("fails an item whose content is no issue, pull request or draft", async () => {
		const {result} = await runWith(
			[
				itemsPage(
					[
						{
							id: "PVTI_odd",
							content: {__typename: "Discussion"},
							fieldValues: {pageInfo: {hasNextPage: false}, nodes: []},
						},
					],
					{hasNextPage: false, endCursor: null},
				),
			],
			() => readItems(TOKEN, "PVT_example"),
		);

		expect(result._tag).toBe("Failed");
	});

	it("fails a page that says more follow but names no cursor, never answering it as the last", async () => {
		const {result} = await runWith([itemsPage([], {hasNextPage: true, endCursor: null})], () =>
			readItems(TOKEN, "PVT_example"),
		);

		expect(result._tag).toBe("Failed");
		if (result._tag !== "Failed") return;
		expect(result.reason).toContain("next page but no cursor");
	});

	it("fails a repository's project list cut the same way", async () => {
		const {result} = await runWith(
			[
				reply({
					data: {
						repository: {
							id: "R_1",
							owner: {id: "O_1", login: "acme"},
							projectsV2: {pageInfo: {hasNextPage: true}, nodes: []},
						},
					},
				}),
			],
			() => readRepository(TOKEN, "acme/widgets"),
		);

		expect(result._tag).toBe("Failed");
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

describe("status updates and item removal", () => {
	it("reads every status update with its body and start date", async () => {
		const {result} = await runWith(
			[
				reply({
					data: {
						node: {
							statusUpdates: {
								pageInfo: {hasNextPage: false, endCursor: "MQ"},
								nodes: [{id: "PVTSU_1", body: "**Table notes**", startDate: "2026-09-26"}],
							},
						},
					},
				}),
			],
			() => readStatusUpdates(TOKEN, "PVT_1"),
		);

		expect(result).toEqual({
			_tag: "Ok",
			value: [{id: "PVTSU_1", body: "**Table notes**", startDate: "2026-09-26"}],
		});
	});

	it("fails rather than read a malformed update as none", () => {
		expect(
			readStatusUpdatesPage({node: {statusUpdates: {pageInfo: {}, nodes: [{id: "PVTSU_1"}]}}})._tag,
		).toBe("Failure");
	});

	it("answers the deleted item's id", async () => {
		const {result} = await runWith(
			[reply({data: {deleteProjectV2Item: {deletedItemId: "PVTI_1"}}})],
			() => deleteItem(TOKEN, "PVT_1", "PVTI_1"),
		);

		expect(result).toEqual({_tag: "Ok", value: "PVTI_1"});
	});
});
