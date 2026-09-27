/**
 * An in-memory GitHub Projects (v2) GraphQL endpoint, substituted at the `HttpClient` service the
 * production path runs on — the same seam `fakeHttp` replaces — so a test drives the real client.
 *
 * It answers the operations `./projects.ts` sends, by operation name, in the response shapes GitHub
 * answers them with (recorded off a live project; see `./projects.unit.test.ts`), and it keeps state:
 * a mutation changes what the next read returns. That is what lets a test prove a second `table
 * setup` writes nothing, which a fixed script of replies cannot.
 */

import {Effect, Layer} from "effect";
import type * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {isRecord} from "./json.ts";

export interface FakeOption {
	id: string;
	name: string;
	color: string;
	description: string;
}

export interface FakeField {
	id: string;
	name: string;
	dataType: string;
	options?: FakeOption[];
	iteration?: {duration: number; startDay: number};
}

export interface FakeView {
	id: string;
	number: number;
	name: string;
	layout: string;
	filter: string | null;
	fieldIds: string[];
}

export interface FakeProject {
	id: string;
	number: number;
	owner: string;
	title: string;
	closed: boolean;
	linked: boolean;
	shortDescription: string | null;
	readme: string | null;
	fields: FakeField[];
	views: FakeView[];
	items: Array<{id: string; contentId: string; values: Record<string, unknown>}>;
	statusUpdates: Array<Record<string, unknown>>;
}

export interface FakeProjectsOptions {
	/** The repository the fake serves, as owner/name. */
	readonly repo?: string;
	/** Projects that exist before the test runs. */
	readonly projects?: ReadonlyArray<FakeProject>;
	/** Scopes to declare in `X-OAuth-Scopes`; absent declares none, as a fine-grained token does. */
	readonly scopes?: string;
	/** Answer every Projects read with GitHub's `INSUFFICIENT_SCOPES` error. */
	readonly insufficientScopes?: boolean;
}

export interface FakeProjects {
	readonly layer: Layer.Layer<HttpClient.HttpClient>;
	/** Every operation name received, in order. */
	readonly operations: ReadonlyArray<string>;
	/** The variables each operation carried, aligned with {@link FakeProjects.operations}. */
	readonly variables: ReadonlyArray<Record<string, unknown>>;
	readonly projects: ReadonlyArray<FakeProject>;
}

const MUTATION = /^\s*mutation\b/;

export const isMutation = (query: string): boolean => MUTATION.test(query);

/** The built-in fields and first view GitHub gives every new project. */
const freshProject = (
	id: string,
	number: number,
	owner: string,
	title: string,
	linked: boolean,
): FakeProject => ({
	id,
	number,
	owner,
	title,
	closed: false,
	linked,
	shortDescription: null,
	readme: null,
	fields: [
		{id: `${id}_F_title`, name: "Title", dataType: "TITLE"},
		{id: `${id}_F_assignees`, name: "Assignees", dataType: "ASSIGNEES"},
		{
			id: `${id}_F_status`,
			name: "Status",
			dataType: "SINGLE_SELECT",
			options: [
				{id: "s1", name: "Todo", color: "GREEN", description: "This item hasn't been started"},
				{
					id: "s2",
					name: "In Progress",
					color: "YELLOW",
					description: "This is actively being worked on",
				},
				{id: "s3", name: "Done", color: "PURPLE", description: "This has been completed"},
			],
		},
		{id: `${id}_F_labels`, name: "Labels", dataType: "LABELS"},
	],
	views: [
		{
			id: `${id}_V_1`,
			number: 1,
			name: "View 1",
			layout: "TABLE_LAYOUT",
			filter: null,
			fieldIds: [`${id}_F_title`, `${id}_F_assignees`, `${id}_F_status`],
		},
	],
	items: [],
	statusUpdates: [],
});

export const blankProject = (
	overrides: Partial<FakeProject> & {number: number; title: string},
): FakeProject => ({
	...freshProject(
		`PVT_${overrides.number}`,
		overrides.number,
		overrides.owner ?? "acme",
		overrides.title,
		true,
	),
	...overrides,
});

const fieldJson = (field: FakeField): Record<string, unknown> => {
	if (field.dataType === "SINGLE_SELECT") {
		return {
			__typename: "ProjectV2SingleSelectField",
			id: field.id,
			name: field.name,
			dataType: field.dataType,
			options: field.options ?? [],
		};
	}
	if (field.dataType === "ITERATION") {
		return {
			__typename: "ProjectV2IterationField",
			id: field.id,
			name: field.name,
			dataType: field.dataType,
			configuration: field.iteration,
		};
	}
	return {__typename: "ProjectV2Field", id: field.id, name: field.name, dataType: field.dataType};
};

const projectJson = (project: FakeProject): Record<string, unknown> => ({
	id: project.id,
	number: project.number,
	url: `https://github.com/orgs/${project.owner}/projects/${project.number}`,
	title: project.title,
	shortDescription: project.shortDescription,
	readme: project.readme,
	fields: {pageInfo: {hasNextPage: false}, nodes: project.fields.map(fieldJson)},
	views: {
		pageInfo: {hasNextPage: false},
		nodes: project.views.map((view) => ({
			id: view.id,
			number: view.number,
			name: view.name,
			layout: view.layout,
			filter: view.filter,
			fields: {pageInfo: {hasNextPage: false}, nodes: view.fieldIds.map((id) => ({id}))},
		})),
	},
});

const requestBody = (body: HttpBody.HttpBody): string => {
	if (body._tag === "Uint8Array") return new TextDecoder().decode(body.body);
	if (body._tag === "Raw") return typeof body.body === "string" ? body.body : "";
	return "";
};

const WEEKDAY_OF = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

export const fakeProjects = (options: FakeProjectsOptions = {}): FakeProjects => {
	const repo = options.repo ?? "acme/widgets";
	const [repoOwner = "acme"] = repo.split("/");
	const projects: FakeProject[] = (options.projects ?? []).map((project) =>
		structuredClone(project),
	);
	const operations: string[] = [];
	const variables: Array<Record<string, unknown>> = [];
	let minted = 0;
	const mint = (prefix: string): string => `${prefix}_${++minted}`;
	const byId = (id: unknown) => projects.find((project) => project.id === id);

	const answer = (
		operation: string,
		vars: Record<string, unknown>,
	): {data: unknown; errors?: unknown[]} => {
		const input = isRecord(vars.input) ? vars.input : {};
		switch (operation) {
			case "TableRepository":
				return {
					data: {
						repository: {
							id: "R_repo",
							owner: {id: `O_${repoOwner}`, login: repoOwner},
							projectsV2: {
								pageInfo: {hasNextPage: false, endCursor: null},
								nodes: projects
									.filter((project) => project.linked)
									.map((project) => ({
										id: project.id,
										number: project.number,
										title: project.title,
										closed: project.closed,
									})),
							},
						},
					},
				};
			case "TableOwnerProjects":
				return {
					data: {
						repositoryOwner: {
							id: `O_${String(vars.login)}`,
							projectsV2: {
								pageInfo: {hasNextPage: false, endCursor: null},
								nodes: projects
									.filter((project) => project.owner === vars.login)
									.map((project) => ({
										id: project.id,
										number: project.number,
										title: project.title,
										closed: project.closed,
									})),
							},
						},
					},
				};
			case "TableLinkProject": {
				const project = byId(vars.projectId);
				if (project === undefined)
					return {data: null, errors: [{type: "NOT_FOUND", message: "no project"}]};
				project.linked = true;
				return {data: {linkProjectV2ToRepository: {repository: {id: vars.repositoryId}}}};
			}
			case "TableProjectByNumber": {
				const found = projects.find(
					(project) => project.owner === vars.login && project.number === vars.number,
				);
				if (found !== undefined) return {data: {repositoryOwner: {projectV2: projectJson(found)}}};
				return {
					data: {repositoryOwner: {projectV2: null}},
					errors: [
						{
							type: "NOT_FOUND",
							path: ["repositoryOwner", "projectV2"],
							message: `Could not resolve to a ProjectV2 with the number ${String(vars.number)}.`,
						},
					],
				};
			}
			case "TableProjectById": {
				const found = byId(vars.id);
				return {data: {node: found === undefined ? null : projectJson(found)}};
			}
			case "TableCreateProject": {
				const number = Math.max(0, ...projects.map((project) => project.number)) + 1;
				const owner = String(vars.ownerId).replace(/^O_/, "");
				const project = freshProject(
					mint("PVT"),
					number,
					owner,
					String(vars.title),
					vars.repositoryId !== null,
				);
				projects.push(project);
				return {
					data: {
						createProjectV2: {projectV2: {id: project.id, number, url: projectJson(project).url}},
					},
				};
			}
			case "TableUpdateProject": {
				const project = byId(vars.projectId);
				if (project === undefined)
					return {data: null, errors: [{type: "NOT_FOUND", message: "no project"}]};
				if (typeof vars.readme === "string") project.readme = vars.readme;
				if (typeof vars.shortDescription === "string")
					project.shortDescription = vars.shortDescription;
				return {data: {updateProjectV2: {projectV2: {id: project.id}}}};
			}
			case "TableCreateField": {
				const project = byId(input.projectId);
				if (project === undefined)
					return {data: null, errors: [{type: "NOT_FOUND", message: "no project"}]};
				const field: FakeField = {
					id: mint("PVTF"),
					name: String(input.name),
					dataType: String(input.dataType),
				};
				if (Array.isArray(input.singleSelectOptions)) {
					field.options = input.singleSelectOptions.map((option) => ({
						id: mint("opt"),
						name: String((option as Record<string, unknown>).name),
						color: String((option as Record<string, unknown>).color),
						description: String((option as Record<string, unknown>).description),
					}));
				}
				if (isRecord(input.iterationConfiguration)) {
					field.iteration = {
						duration: Number(input.iterationConfiguration.duration),
						startDay: WEEKDAY_OF(String(input.iterationConfiguration.startDate)),
					};
				}
				project.fields.push(field);
				return {data: {createProjectV2Field: {projectV2Field: {id: field.id}}}};
			}
			case "TableCreateView": {
				const project = byId(input.projectId);
				if (project === undefined)
					return {data: null, errors: [{type: "NOT_FOUND", message: "no project"}]};
				const configuration = isRecord(input.configuration) ? input.configuration : {};
				const view: FakeView = {
					id: mint("PVTV"),
					number: Math.max(0, ...project.views.map((one) => one.number)) + 1,
					name: String(input.name),
					layout: String(input.layout),
					filter: null,
					fieldIds: Array.isArray(configuration.visibleFieldIds)
						? configuration.visibleFieldIds.map(String)
						: [project.fields[0]?.id ?? ""],
				};
				project.views.push(view);
				return {data: {createProjectV2View: {projectV2View: {id: view.id}}}};
			}
			case "TableUpdateView": {
				const view = projects
					.flatMap((project) => project.views)
					.find((one) => one.id === input.viewId);
				if (view === undefined)
					return {data: null, errors: [{type: "NOT_FOUND", message: "no view"}]};
				if (typeof input.layout === "string") view.layout = input.layout;
				if (typeof input.filter === "string") view.filter = input.filter;
				if (isRecord(input.configuration) && Array.isArray(input.configuration.visibleFieldIds)) {
					view.fieldIds = input.configuration.visibleFieldIds.map(String);
				}
				return {data: {updateProjectV2View: {projectV2View: {id: view.id}}}};
			}
			case "TableAddItem": {
				const project = byId(vars.projectId);
				if (project === undefined)
					return {data: null, errors: [{type: "NOT_FOUND", message: "no project"}]};
				const standing = project.items.find((item) => item.contentId === vars.contentId);
				const item = standing ?? {id: mint("PVTI"), contentId: String(vars.contentId), values: {}};
				if (standing === undefined) project.items.push(item);
				return {data: {addProjectV2ItemById: {item: {id: item.id}}}};
			}
			case "TableSetValue": {
				const project = byId(input.projectId);
				const item = project?.items.find((one) => one.id === input.itemId);
				if (item === undefined)
					return {data: null, errors: [{type: "NOT_FOUND", message: "no item"}]};
				item.values[String(input.fieldId)] = input.value;
				return {data: {updateProjectV2ItemFieldValue: {projectV2Item: {id: item.id}}}};
			}
			case "TableStatusUpdate": {
				const project = byId(input.projectId);
				if (project === undefined)
					return {data: null, errors: [{type: "NOT_FOUND", message: "no project"}]};
				project.statusUpdates.push(input);
				return {data: {createProjectV2StatusUpdate: {statusUpdate: {id: mint("PVTSU")}}}};
			}
			default:
				return {data: null, errors: [{message: `the fake does not answer ${operation}`}]};
		}
	};

	const layer = Layer.succeed(HttpClient.HttpClient)(
		HttpClient.make((request) => {
			const parsed: unknown = JSON.parse(requestBody(request.body));
			const query = isRecord(parsed) && typeof parsed.query === "string" ? parsed.query : "";
			const vars = isRecord(parsed) && isRecord(parsed.variables) ? parsed.variables : {};
			const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
			operations.push(operation);
			variables.push(vars);
			const headers: Record<string, string> = {"content-type": "application/json"};
			if (options.scopes !== undefined) headers["x-oauth-scopes"] = options.scopes;
			const scopeRefusal =
				options.insufficientScopes === true ||
				(options.scopes !== undefined && !options.scopes.split(/,\s*/).includes("project"));
			const body = scopeRefusal
				? {
						data: null,
						errors: [
							{
								type: "INSUFFICIENT_SCOPES",
								message:
									"Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes. Please modify your token's scopes at: https://github.com/settings/tokens.",
							},
						],
					}
				: answer(operation, vars);
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new Response(JSON.stringify(body), {status: 200, headers}),
				),
			);
		}),
	);

	return {layer, operations, variables, projects};
};
