/**
 * The GitHub Projects (v2) client: find or create a project, shape its fields and views, add items,
 * set and read field values, and post a status update.
 *
 * GraphQL, by the founder's ruling on the table's home (R4.1 on the issue below). That makes this
 * module the fourth carve from `./gh-api.ts`'s REST default, and the only one that writes project
 * state. It rests on the ruling, not on an absence of REST: GitHub publishes part of this domain
 * over REST, and whether those edges move there is still an open question.
 *
 * **A token without the `project` scope is its own answer, `MissingScope`, never a generic
 * failure.** It is the one refusal an operator can fix in a single command, so it carries that
 * command ({@link PROJECT_SCOPE_FIX}). It is read two ways because tokens differ: a classic or OAuth
 * token lists its scopes in `X-OAuth-Scopes` on every response, and any token GitHub refuses a
 * Projects field to answers an `INSUFFICIENT_SCOPES` error.
 *
 * Every connection read carries its completeness proof: a page cut short by `hasNextPage` is a
 * failure here, never a shorter list, because a reconcile over a truncated field list would create a
 * duplicate of a field it did not see.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {Effect} from "effect";
import {type Api, ambientToken, graphqlRead, onTransport, PAGE_CAP, type Rest} from "./gh-api.ts";
import {type Attempt, fail, ok, type Shell} from "./git.ts";
import {isRecord} from "./json.ts";

/** The exact command that grants the scope. A plain `gh auth refresh` fails in a non-interactive shell. */
export const PROJECT_SCOPE_FIX = "gh auth refresh -h github.com -s project";

export const PROJECT_SCOPE = "project";

export type ProjectsAnswer<A> =
	| {readonly _tag: "Ok"; readonly value: A}
	/** The token lacks the `project` scope; the reason already names {@link PROJECT_SCOPE_FIX}. */
	| {readonly _tag: "MissingScope"; readonly reason: string}
	/** GitHub was not reached, refused, or answered a shape nobody asked for. UNKNOWN. */
	| {readonly _tag: "Failed"; readonly reason: string};

const done = <A>(value: A): ProjectsAnswer<A> => ({_tag: "Ok", value});
const failed = <A>(reason: string): ProjectsAnswer<A> => ({_tag: "Failed", reason});

export const missingScope = <A>(detail: string): ProjectsAnswer<A> => ({
	_tag: "MissingScope",
	reason: `the GitHub token lacks the \`${PROJECT_SCOPE}\` scope the table needs (${detail}) — run \`${PROJECT_SCOPE_FIX}\` and re-run`,
});

export type ViewLayout = "TABLE_LAYOUT" | "BOARD_LAYOUT" | "ROADMAP_LAYOUT";

export type OptionColor =
	| "GRAY"
	| "BLUE"
	| "GREEN"
	| "YELLOW"
	| "ORANGE"
	| "RED"
	| "PINK"
	| "PURPLE";

export interface SelectOption {
	readonly id: string;
	readonly name: string;
	readonly color: OptionColor;
	readonly description: string;
}

export type ProjectField =
	| {
			readonly _tag: "SingleSelect";
			readonly id: string;
			readonly name: string;
			readonly options: ReadonlyArray<SelectOption>;
	  }
	| {
			readonly _tag: "Iteration";
			readonly id: string;
			readonly name: string;
			readonly duration: number;
			readonly startDay: number;
	  }
	/** Every other field, built-in or custom, by its `dataType` (`TEXT`, `NUMBER`, `TITLE`, …). */
	| {readonly _tag: "Plain"; readonly id: string; readonly name: string; readonly dataType: string};

export interface ProjectView {
	readonly id: string;
	readonly number: number;
	readonly name: string;
	readonly layout: ViewLayout;
	readonly filter: string | null;
	readonly visibleFieldIds: ReadonlyArray<string>;
}

export interface ProjectSnapshot {
	readonly id: string;
	readonly number: number;
	readonly url: string;
	readonly title: string;
	readonly shortDescription: string | null;
	readonly readme: string | null;
	readonly fields: ReadonlyArray<ProjectField>;
	readonly views: ReadonlyArray<ProjectView>;
}

/** A project as a list of the repository's linked projects names it. */
export interface ProjectRef {
	readonly id: string;
	readonly number: number;
	readonly title: string;
	readonly closed: boolean;
}

export interface RepositoryNode {
	readonly id: string;
	readonly owner: {readonly id: string; readonly login: string};
	readonly linkedProjects: ReadonlyArray<ProjectRef>;
}

/** What a new field is created as. Single-select options carry no id until GitHub mints one. */
export type FieldSpec =
	| {readonly _tag: "Text"; readonly name: string}
	| {readonly _tag: "Number"; readonly name: string}
	| {
			readonly _tag: "SingleSelect";
			readonly name: string;
			readonly options: ReadonlyArray<Omit<SelectOption, "id">>;
	  }
	| {
			readonly _tag: "Iteration";
			readonly name: string;
			readonly startDate: string;
			readonly duration: number;
			readonly firstTitle: string;
	  };

export interface ViewUpdate {
	readonly layout?: ViewLayout;
	readonly filter?: string;
	readonly visibleFieldIds?: ReadonlyArray<string>;
}

/** One value to write into an item's field. */
export type FieldValue =
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Number"; readonly number: number}
	| {readonly _tag: "Date"; readonly date: string}
	| {readonly _tag: "Option"; readonly optionId: string}
	| {readonly _tag: "Iteration"; readonly iterationId: string};

/** A field value as read back, with who last set it and when — what the decider check reads. */
export interface ItemFieldValue {
	readonly fieldId: string;
	readonly fieldName: string;
	readonly value:
		| {readonly _tag: "Text"; readonly text: string}
		| {readonly _tag: "Number"; readonly number: number}
		| {readonly _tag: "Date"; readonly date: string}
		| {readonly _tag: "Option"; readonly optionId: string; readonly name: string}
		| {readonly _tag: "Iteration"; readonly iterationId: string; readonly title: string};
	/** The login of whoever set the value, or `null` when GitHub names no actor (a deleted account). */
	readonly creator: string | null;
	readonly updatedAt: string;
}

export interface ItemValues {
	readonly itemId: string;
	/** The issue or pull request number the item stands for; `null` for a draft. */
	readonly contentNumber: number | null;
	readonly values: ReadonlyArray<ItemFieldValue>;
}

export type StatusUpdateStatus = "INACTIVE" | "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "COMPLETE";

export interface StatusUpdateInput {
	readonly body: string;
	readonly status: StatusUpdateStatus;
	readonly startDate?: string;
	readonly targetDate?: string;
}

const ERROR_CAP = 200;

const bounded = (text: string): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= ERROR_CAP ? flat : `${flat.slice(0, ERROR_CAP)}…truncated`;
};

/**
 * Whether the response's own scope list withholds `project`. `null` means the token declared no
 * list — a fine-grained or app token — and only an `INSUFFICIENT_SCOPES` error can say.
 */
export const scopeWithheld = (headers: Readonly<Record<string, string>>): boolean | null => {
	const declared = headers["x-oauth-scopes"];
	if (declared === undefined) return null;
	const scopes = declared
		.split(",")
		.map((scope) => scope.trim())
		.filter((scope) => scope !== "");
	return !scopes.includes(PROJECT_SCOPE);
};

interface GraphqlError {
	readonly type: string | null;
	readonly message: string;
	readonly path: ReadonlyArray<string | number>;
}

const errorsOf = (body: unknown): ReadonlyArray<GraphqlError> => {
	if (!isRecord(body) || !Array.isArray(body.errors)) return [];
	return body.errors.map((raw) => ({
		type: isRecord(raw) && typeof raw.type === "string" ? raw.type : null,
		message: isRecord(raw) && typeof raw.message === "string" ? raw.message : "",
		path: isRecord(raw) && Array.isArray(raw.path) ? (raw.path as Array<string | number>) : [],
	}));
};

/**
 * One GraphQL exchange, classified. `tolerate` names errors the caller reads as an answer rather
 * than a failure — a `NOT_FOUND` on a project number is a project proven absent.
 */
const exchange = <A>(
	token: string,
	query: string,
	variables: Readonly<Record<string, unknown>>,
	read: (data: Record<string, unknown>) => Attempt<A>,
	tolerate: (error: GraphqlError) => boolean = () => false,
): Api<ProjectsAnswer<A>> =>
	Effect.map(graphqlRead(token, query, variables), (outcome: Rest): ProjectsAnswer<A> => {
		if (outcome._tag === "Unreachable") return failed(outcome.reason);
		if (scopeWithheld(outcome.headers) === true) {
			return missingScope(`its scopes are: ${outcome.headers["x-oauth-scopes"] || "none"}`);
		}
		const errors = errorsOf(outcome.body);
		const scopeError = errors.find((error) => error.type === "INSUFFICIENT_SCOPES");
		if (scopeError !== undefined) return missingScope(bounded(scopeError.message));
		if (outcome.status < 200 || outcome.status >= 300) {
			const message =
				isRecord(outcome.body) && typeof outcome.body.message === "string"
					? `: ${bounded(outcome.body.message)}`
					: "";
			return failed(`GitHub answered HTTP ${outcome.status}${message}`);
		}
		const blocking = errors.filter((error) => !tolerate(error));
		const first = blocking[0];
		if (first !== undefined) {
			return failed(`GitHub answered the GraphQL request with an error: ${bounded(first.message)}`);
		}
		const data = isRecord(outcome.body) && isRecord(outcome.body.data) ? outcome.body.data : null;
		if (data === null) return failed("GitHub answered 200 but carried no GraphQL data");
		const value = read(data);
		return value._tag === "Failure" ? failed(value.reason) : done(value.value);
	});

const str = (value: unknown): value is string => typeof value === "string";

const PROJECT_FRAGMENT = `
fragment TableProject on ProjectV2 {
  id number url title shortDescription readme
  fields(first: 100) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name color description } }
      ... on ProjectV2IterationField { configuration { duration startDay } }
    }
  }
  views(first: 100) {
    pageInfo { hasNextPage }
    nodes {
      id number name layout filter
      fields(first: 100) { pageInfo { hasNextPage } nodes { ... on ProjectV2FieldCommon { id } } }
    }
  }
}`;

const truncated = (connection: Record<string, unknown>): boolean =>
	isRecord(connection.pageInfo) && connection.pageInfo.hasNextPage === true;

const readField = (node: unknown): ProjectField | null => {
	if (!isRecord(node) || !str(node.id) || !str(node.name)) return null;
	if (node.__typename === "ProjectV2SingleSelectField") {
		if (!Array.isArray(node.options)) return null;
		const options: SelectOption[] = [];
		for (const option of node.options) {
			if (!isRecord(option) || !str(option.id) || !str(option.name)) return null;
			options.push({
				id: option.id,
				name: option.name,
				color: (str(option.color) ? option.color : "GRAY") as OptionColor,
				description: str(option.description) ? option.description : "",
			});
		}
		return {_tag: "SingleSelect", id: node.id, name: node.name, options};
	}
	if (node.__typename === "ProjectV2IterationField") {
		const config = isRecord(node.configuration) ? node.configuration : null;
		if (config === null || typeof config.duration !== "number") return null;
		return {
			_tag: "Iteration",
			id: node.id,
			name: node.name,
			duration: config.duration,
			startDay: typeof config.startDay === "number" ? config.startDay : 0,
		};
	}
	return {
		_tag: "Plain",
		id: node.id,
		name: node.name,
		dataType: str(node.dataType) ? node.dataType : "UNKNOWN",
	};
};

const LAYOUTS: ReadonlyArray<ViewLayout> = ["TABLE_LAYOUT", "BOARD_LAYOUT", "ROADMAP_LAYOUT"];

const readView = (node: unknown): Attempt<ProjectView> => {
	if (
		!isRecord(node) ||
		!str(node.id) ||
		!str(node.name) ||
		typeof node.number !== "number" ||
		!LAYOUTS.includes(node.layout as ViewLayout)
	) {
		return fail("GitHub answered 200 but one view is not a project view");
	}
	const fields = isRecord(node.fields) ? node.fields : null;
	if (fields === null || !Array.isArray(fields.nodes)) {
		return fail(`GitHub answered 200 but view "${node.name}" lists no fields`);
	}
	if (truncated(fields)) return fail(`view "${node.name}" shows more fields than one page holds`);
	return ok({
		id: node.id,
		number: node.number,
		name: node.name,
		layout: node.layout as ViewLayout,
		filter: str(node.filter) ? node.filter : null,
		visibleFieldIds: fields.nodes.flatMap((field) =>
			isRecord(field) && str(field.id) ? [field.id] : [],
		),
	});
};

export const readSnapshot = (node: unknown): Attempt<ProjectSnapshot> => {
	if (
		!isRecord(node) ||
		!str(node.id) ||
		typeof node.number !== "number" ||
		!str(node.url) ||
		!str(node.title)
	) {
		return fail("GitHub answered 200 but its output is not a project");
	}
	const fieldPage = isRecord(node.fields) ? node.fields : null;
	const viewPage = isRecord(node.views) ? node.views : null;
	if (fieldPage === null || !Array.isArray(fieldPage.nodes)) {
		return fail("GitHub answered 200 but the project lists no fields");
	}
	if (viewPage === null || !Array.isArray(viewPage.nodes)) {
		return fail("GitHub answered 200 but the project lists no views");
	}
	if (truncated(fieldPage)) return fail("the project has more fields than one page holds");
	if (truncated(viewPage)) return fail("the project has more views than one page holds");
	const fields: ProjectField[] = [];
	for (const raw of fieldPage.nodes) {
		const field = readField(raw);
		if (field === null) return fail("GitHub answered 200 but one field is not a project field");
		fields.push(field);
	}
	const views: ProjectView[] = [];
	for (const raw of viewPage.nodes) {
		const view = readView(raw);
		if (view._tag === "Failure") return view;
		views.push(view.value);
	}
	return ok({
		id: node.id,
		number: node.number,
		url: node.url,
		title: node.title,
		shortDescription: str(node.shortDescription) ? node.shortDescription : null,
		readme: str(node.readme) ? node.readme : null,
		fields,
		views,
	});
};

const readRefs = (nodes: ReadonlyArray<unknown>, what: string): Attempt<ProjectRef[]> => {
	const refs: ProjectRef[] = [];
	for (const node of nodes) {
		if (!isRecord(node) || !str(node.id) || typeof node.number !== "number" || !str(node.title)) {
			return fail(`GitHub answered 200 but one ${what} is not a project`);
		}
		refs.push({id: node.id, number: node.number, title: node.title, closed: node.closed === true});
	}
	return ok(refs);
};

const nextCursor = (connection: Record<string, unknown>): string | null => {
	const info = isRecord(connection.pageInfo) ? connection.pageInfo : null;
	return info !== null && info.hasNextPage === true && str(info.endCursor) ? info.endCursor : null;
};

const REPOSITORY_QUERY = `
query TableRepository($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    id
    owner { id login }
    projectsV2(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id number title closed }
    }
  }
}`;

/** The repository's node, its owner, and every project linked to it. */
export const readRepository = (token: string, repo: string): Api<ProjectsAnswer<RepositoryNode>> =>
	Effect.gen(function* () {
		const [owner, name] = repo.split("/");
		if (owner === undefined || name === undefined) return failed(`\`${repo}\` is not owner/name`);
		const linked: ProjectRef[] = [];
		let head: {id: string; owner: {id: string; login: string}} | null = null;
		let cursor: string | null = null;
		for (let page = 0; page < PAGE_CAP; page++) {
			const answer: ProjectsAnswer<{
				readonly id: string;
				readonly owner: {readonly id: string; readonly login: string};
				readonly refs: ReadonlyArray<ProjectRef>;
				readonly next: string | null;
			}> = yield* exchange(token, REPOSITORY_QUERY, {owner, name, cursor}, (data) => {
				const repository = isRecord(data.repository) ? data.repository : null;
				if (repository === null) return fail(`GitHub knows no repository ${repo}`);
				const ownerNode = isRecord(repository.owner) ? repository.owner : null;
				const projects = isRecord(repository.projectsV2) ? repository.projectsV2 : null;
				if (
					!str(repository.id) ||
					ownerNode === null ||
					!str(ownerNode.id) ||
					!str(ownerNode.login) ||
					projects === null ||
					!Array.isArray(projects.nodes)
				) {
					return fail("GitHub answered 200 but its output is not a repository");
				}
				const refs = readRefs(projects.nodes, "linked project");
				if (refs._tag === "Failure") return refs;
				return ok({
					id: repository.id,
					owner: {id: ownerNode.id, login: ownerNode.login},
					refs: refs.value,
					next: nextCursor(projects),
				});
			});
			if (answer._tag !== "Ok") return answer;
			head = {id: answer.value.id, owner: answer.value.owner};
			linked.push(...answer.value.refs);
			if (answer.value.next === null) {
				return done({id: head.id, owner: head.owner, linkedProjects: linked});
			}
			cursor = answer.value.next;
		}
		return failed(`${repo} links more projects than ${PAGE_CAP} pages hold`);
	});

const OWNER_PROJECTS_QUERY = `
query TableOwnerProjects($login: String!, $cursor: String) {
  repositoryOwner(login: $login) {
    id
    ... on ProjectV2Owner {
      projectsV2(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id number title closed }
      }
    }
  }
}`;

export interface OwnerNode {
	/** What a new project is created under. */
	readonly id: string;
	/** Every project the owner holds, linked to a repository or not. */
	readonly projects: ReadonlyArray<ProjectRef>;
}

/** A user or organization's node id and every project it owns, read to the last page. */
export const readOwnerProjects = (token: string, login: string): Api<ProjectsAnswer<OwnerNode>> =>
	Effect.gen(function* () {
		const projects: ProjectRef[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < PAGE_CAP; page++) {
			const answer: ProjectsAnswer<{
				readonly id: string;
				readonly refs: ReadonlyArray<ProjectRef>;
				readonly next: string | null;
			}> = yield* exchange(token, OWNER_PROJECTS_QUERY, {login, cursor}, (data) => {
				const owner = isRecord(data.repositoryOwner) ? data.repositoryOwner : null;
				if (owner === null) return fail(`GitHub knows no user or organization named ${login}`);
				const connection = isRecord(owner.projectsV2) ? owner.projectsV2 : null;
				if (!str(owner.id) || connection === null || !Array.isArray(connection.nodes)) {
					return fail("GitHub answered 200 but its output is not a project owner");
				}
				const refs = readRefs(connection.nodes, "owned project");
				return refs._tag === "Failure"
					? refs
					: ok({id: owner.id, refs: refs.value, next: nextCursor(connection)});
			});
			if (answer._tag !== "Ok") return answer;
			projects.push(...answer.value.refs);
			if (answer.value.next === null) return done({id: answer.value.id, projects});
			cursor = answer.value.next;
		}
		return failed(`${login} owns more projects than ${PAGE_CAP} pages hold`);
	});

const LINK_PROJECT = `
mutation TableLinkProject($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(input: {projectId: $projectId, repositoryId: $repositoryId}) {
    repository { id }
  }
}`;

/** Link a project to a repository, so it shows in that repository's Projects tab. */
export const linkProject = (
	token: string,
	projectId: string,
	repositoryId: string,
): Api<ProjectsAnswer<string>> =>
	exchange(token, LINK_PROJECT, {projectId, repositoryId}, (data) => {
		const payload = isRecord(data.linkProjectV2ToRepository)
			? data.linkProjectV2ToRepository
			: null;
		const repository = payload !== null && isRecord(payload.repository) ? payload.repository : null;
		return repository !== null && str(repository.id)
			? ok(repository.id)
			: fail("GitHub answered 200 but linked no repository");
	});

const BY_NUMBER_QUERY = `
query TableProjectByNumber($login: String!, $number: Int!) {
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner { projectV2(number: $number) { ...TableProject } }
  }
}
${PROJECT_FRAGMENT}`;

/** The project `number` under `login`, or `null` when that owner has no such project. */
export const readProjectByNumber = (
	token: string,
	login: string,
	number: number,
): Api<ProjectsAnswer<ProjectSnapshot | null>> =>
	exchange(
		token,
		BY_NUMBER_QUERY,
		{login, number},
		(data) => {
			const owner = isRecord(data.repositoryOwner) ? data.repositoryOwner : null;
			if (owner === null) return fail(`GitHub knows no user or organization named ${login}`);
			if (owner.projectV2 === null || owner.projectV2 === undefined) return ok(null);
			return readSnapshot(owner.projectV2);
		},
		(error) => error.type === "NOT_FOUND" && error.path.at(-1) === "projectV2",
	);

const BY_ID_QUERY = `
query TableProjectById($id: ID!) {
  node(id: $id) { ... on ProjectV2 { ...TableProject } }
}
${PROJECT_FRAGMENT}`;

export const readProject = (token: string, id: string): Api<ProjectsAnswer<ProjectSnapshot>> =>
	exchange(token, BY_ID_QUERY, {id}, (data) => readSnapshot(data.node));

const CREATE_PROJECT = `
mutation TableCreateProject($ownerId: ID!, $title: String!, $repositoryId: ID) {
  createProjectV2(input: {ownerId: $ownerId, title: $title, repositoryId: $repositoryId}) {
    projectV2 { id number url }
  }
}`;

/** A new project under `ownerId`, linked to `repositoryId` when one is given. Answers its node id. */
export const createProject = (
	token: string,
	input: {readonly ownerId: string; readonly title: string; readonly repositoryId: string | null},
): Api<ProjectsAnswer<string>> =>
	exchange(token, CREATE_PROJECT, input, (data) => {
		const payload = isRecord(data.createProjectV2) ? data.createProjectV2 : null;
		const project = payload !== null && isRecord(payload.projectV2) ? payload.projectV2 : null;
		return project !== null && str(project.id)
			? ok(project.id)
			: fail("GitHub answered 200 but created no project");
	});

const UPDATE_PROJECT = `
mutation TableUpdateProject($projectId: ID!, $readme: String, $shortDescription: String) {
  updateProjectV2(input: {projectId: $projectId, readme: $readme, shortDescription: $shortDescription}) {
    projectV2 { id }
  }
}`;

export const updateProject = (
	token: string,
	projectId: string,
	change: {readonly readme?: string; readonly shortDescription?: string},
): Api<ProjectsAnswer<string>> =>
	exchange(token, UPDATE_PROJECT, {projectId, ...change}, (data) => {
		const payload = isRecord(data.updateProjectV2) ? data.updateProjectV2 : null;
		const project = payload !== null && isRecord(payload.projectV2) ? payload.projectV2 : null;
		return project !== null && str(project.id)
			? ok(project.id)
			: fail("GitHub answered 200 but updated no project");
	});

const fieldIdOf =
	(key: string) =>
	(data: Record<string, unknown>): Attempt<string> => {
		const payload = isRecord(data[key]) ? (data[key] as Record<string, unknown>) : null;
		const field =
			payload !== null && isRecord(payload.projectV2Field) ? payload.projectV2Field : null;
		return field !== null && str(field.id)
			? ok(field.id)
			: fail("GitHub answered 200 but named no field");
	};

const CREATE_FIELD = `
mutation TableCreateField($input: CreateProjectV2FieldInput!) {
  createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id } } }
}`;

const fieldInput = (projectId: string, spec: FieldSpec): Record<string, unknown> => {
	switch (spec._tag) {
		case "Text":
			return {projectId, name: spec.name, dataType: "TEXT"};
		case "Number":
			return {projectId, name: spec.name, dataType: "NUMBER"};
		case "SingleSelect":
			return {
				projectId,
				name: spec.name,
				dataType: "SINGLE_SELECT",
				singleSelectOptions: spec.options,
			};
		case "Iteration":
			return {
				projectId,
				name: spec.name,
				dataType: "ITERATION",
				iterationConfiguration: {
					startDate: spec.startDate,
					duration: spec.duration,
					iterations: [
						{startDate: spec.startDate, duration: spec.duration, title: spec.firstTitle},
					],
				},
			};
	}
};

/** A new field on the project. Answers its node id. */
export const createField = (
	token: string,
	projectId: string,
	spec: FieldSpec,
): Api<ProjectsAnswer<string>> =>
	exchange(
		token,
		CREATE_FIELD,
		{input: fieldInput(projectId, spec)},
		fieldIdOf("createProjectV2Field"),
	);

const viewOf =
	(key: string) =>
	(data: Record<string, unknown>): Attempt<string> => {
		const payload = isRecord(data[key]) ? (data[key] as Record<string, unknown>) : null;
		const view = payload !== null && isRecord(payload.projectV2View) ? payload.projectV2View : null;
		return view !== null && str(view.id)
			? ok(view.id)
			: fail("GitHub answered 200 but named no view");
	};

const CREATE_VIEW = `
mutation TableCreateView($input: CreateProjectV2ViewInput!) {
  createProjectV2View(input: $input) { projectV2View { id } }
}`;

/** A new view. Its filter is set by {@link updateView}: the create input takes none. */
export const createView = (
	token: string,
	projectId: string,
	view: {
		readonly name: string;
		readonly layout: ViewLayout;
		readonly visibleFieldIds: ReadonlyArray<string>;
	},
): Api<ProjectsAnswer<string>> =>
	exchange(
		token,
		CREATE_VIEW,
		{
			input: {
				projectId,
				name: view.name,
				layout: view.layout,
				configuration: {visibleFieldIds: view.visibleFieldIds},
			},
		},
		viewOf("createProjectV2View"),
	);

const UPDATE_VIEW = `
mutation TableUpdateView($input: UpdateProjectV2ViewInput!) {
  updateProjectV2View(input: $input) { projectV2View { id } }
}`;

/** Change a view's layout, filter or visible fields. Grouping and sort are not settable here. */
export const updateView = (
	token: string,
	viewId: string,
	change: ViewUpdate,
): Api<ProjectsAnswer<string>> =>
	exchange(
		token,
		UPDATE_VIEW,
		{
			input: {
				viewId,
				...(change.layout !== undefined ? {layout: change.layout} : {}),
				...(change.filter !== undefined ? {filter: change.filter} : {}),
				...(change.visibleFieldIds !== undefined
					? {configuration: {visibleFieldIds: change.visibleFieldIds}}
					: {}),
			},
		},
		viewOf("updateProjectV2View"),
	);

const ADD_ITEM = `
mutation TableAddItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } }
}`;

/** Add an issue or pull request (by node id) to the project. Answers the item id; re-adding answers the same item. */
export const addItem = (
	token: string,
	projectId: string,
	contentId: string,
): Api<ProjectsAnswer<string>> =>
	exchange(token, ADD_ITEM, {projectId, contentId}, (data) => {
		const payload = isRecord(data.addProjectV2ItemById) ? data.addProjectV2ItemById : null;
		const item = payload !== null && isRecord(payload.item) ? payload.item : null;
		return item !== null && str(item.id)
			? ok(item.id)
			: fail("GitHub answered 200 but added no item");
	});

const SET_VALUE = `
mutation TableSetValue($input: UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
}`;

const valueInput = (value: FieldValue): Record<string, unknown> => {
	switch (value._tag) {
		case "Text":
			return {text: value.text};
		case "Number":
			return {number: value.number};
		case "Date":
			return {date: value.date};
		case "Option":
			return {singleSelectOptionId: value.optionId};
		case "Iteration":
			return {iterationId: value.iterationId};
	}
};

export const setFieldValue = (
	token: string,
	target: {readonly projectId: string; readonly itemId: string; readonly fieldId: string},
	value: FieldValue,
): Api<ProjectsAnswer<string>> =>
	exchange(token, SET_VALUE, {input: {...target, value: valueInput(value)}}, (data) => {
		const payload = isRecord(data.updateProjectV2ItemFieldValue)
			? data.updateProjectV2ItemFieldValue
			: null;
		const item = payload !== null && isRecord(payload.projectV2Item) ? payload.projectV2Item : null;
		return item !== null && str(item.id)
			? ok(item.id)
			: fail("GitHub answered 200 but set no value");
	});

const VALUE_META = "creator { login } updatedAt field { ... on ProjectV2FieldCommon { id name } }";

const ITEM_VALUES = `
query TableItemValues($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      id
      content { ... on Issue { number } ... on PullRequest { number } }
      fieldValues(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on ProjectV2ItemFieldTextValue { text ${VALUE_META} }
          ... on ProjectV2ItemFieldNumberValue { number ${VALUE_META} }
          ... on ProjectV2ItemFieldDateValue { date ${VALUE_META} }
          ... on ProjectV2ItemFieldSingleSelectValue { name optionId ${VALUE_META} }
          ... on ProjectV2ItemFieldIterationValue { title iterationId ${VALUE_META} }
        }
      }
    }
  }
}`;

/** The value types the table reads; every other `__typename` is the issue's own and is skipped. */
const TABLE_VALUE_TYPES: ReadonlySet<unknown> = new Set([
	"ProjectV2ItemFieldTextValue",
	"ProjectV2ItemFieldNumberValue",
	"ProjectV2ItemFieldDateValue",
	"ProjectV2ItemFieldSingleSelectValue",
	"ProjectV2ItemFieldIterationValue",
]);

const readValue = (node: Record<string, unknown>): ItemFieldValue["value"] | null => {
	switch (node.__typename) {
		case "ProjectV2ItemFieldTextValue":
			return str(node.text) ? {_tag: "Text", text: node.text} : null;
		case "ProjectV2ItemFieldNumberValue":
			return typeof node.number === "number" ? {_tag: "Number", number: node.number} : null;
		case "ProjectV2ItemFieldDateValue":
			return str(node.date) ? {_tag: "Date", date: node.date} : null;
		case "ProjectV2ItemFieldSingleSelectValue":
			return str(node.optionId) && str(node.name)
				? {_tag: "Option", optionId: node.optionId, name: node.name}
				: null;
		case "ProjectV2ItemFieldIterationValue":
			return str(node.iterationId) && str(node.title)
				? {_tag: "Iteration", iterationId: node.iterationId, title: node.title}
				: null;
		default:
			return null;
	}
};

/**
 * An item's text, number, date, single-select and iteration values, each with its `creator` and
 * `updatedAt`. Values GitHub keeps for the issue itself (labels, milestone, repository, linked pull
 * requests) are skipped: they are the issue's, not the table's. A malformed value of a table type
 * fails the read instead of leaving the list short, so an absent value always means unset.
 */
export const readItemValues = (token: string, itemId: string): Api<ProjectsAnswer<ItemValues>> =>
	exchange(token, ITEM_VALUES, {id: itemId}, (data) => {
		const item = isRecord(data.node) ? data.node : null;
		if (item === null || !str(item.id) || !isRecord(item.fieldValues)) {
			return fail(`GitHub knows no project item ${itemId}`);
		}
		const read = readItemNode(item);
		if (read._tag === "Failure") return read;
		const {itemId: id, contentNumber, values} = read.value;
		return ok({itemId: id, contentNumber, values});
	});

const CLEAR_VALUE = `
mutation TableClearValue($input: ClearProjectV2ItemFieldValueInput!) {
  clearProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
}`;

/** Unset one field on one item. */
export const clearFieldValue = (
	token: string,
	target: {readonly projectId: string; readonly itemId: string; readonly fieldId: string},
): Api<ProjectsAnswer<string>> =>
	exchange(token, CLEAR_VALUE, {input: target}, (data) => {
		const payload = isRecord(data.clearProjectV2ItemFieldValue)
			? data.clearProjectV2ItemFieldValue
			: null;
		const item = payload !== null && isRecord(payload.projectV2Item) ? payload.projectV2Item : null;
		return item !== null && str(item.id)
			? ok(item.id)
			: fail("GitHub answered 200 but cleared no value");
	});

/** One project item as the table reads it: what it stands for, and its table values. */
export interface ProjectItem extends ItemValues {
	/** `Issue`, `PullRequest` or `DraftIssue`. */
	readonly contentType: string;
	/** The `owner/name` the issue or pull request lives in; `null` for a draft. */
	readonly repository: string | null;
}

const ITEMS_QUERY = `
query TableItems($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            __typename
            ... on Issue { number repository { nameWithOwner } }
            ... on PullRequest { number repository { nameWithOwner } }
          }
          fieldValues(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on ProjectV2ItemFieldTextValue { text ${VALUE_META} }
              ... on ProjectV2ItemFieldNumberValue { number ${VALUE_META} }
              ... on ProjectV2ItemFieldDateValue { date ${VALUE_META} }
              ... on ProjectV2ItemFieldSingleSelectValue { name optionId ${VALUE_META} }
              ... on ProjectV2ItemFieldIterationValue { title iterationId ${VALUE_META} }
            }
          }
        }
      }
    }
  }
}`;

/** The table values on one item node, or why the node is not an item. */
const readItemNode = (item: Record<string, unknown>): Attempt<ProjectItem> => {
	const page = isRecord(item.fieldValues) ? item.fieldValues : null;
	if (!str(item.id) || page === null || !Array.isArray(page.nodes)) {
		return fail("GitHub answered 200 but one item is not a project item");
	}
	if (truncated(page)) return fail(`item ${item.id} carries more values than one page holds`);
	const content = isRecord(item.content) ? item.content : null;
	const values: ItemFieldValue[] = [];
	for (const node of page.nodes) {
		if (!isRecord(node) || !TABLE_VALUE_TYPES.has(node.__typename)) continue;
		const value = readValue(node);
		const field = isRecord(node.field) ? node.field : null;
		if (value === null || field === null || !str(field.id) || !str(field.name)) {
			return fail(`GitHub answered 200 but one ${String(node.__typename)} is malformed`);
		}
		if (!str(node.updatedAt)) return fail("GitHub answered 200 but one value carries no updatedAt");
		const creator = isRecord(node.creator) && str(node.creator.login) ? node.creator.login : null;
		values.push({
			fieldId: field.id,
			fieldName: field.name,
			value,
			creator,
			updatedAt: node.updatedAt,
		});
	}
	const repository =
		content !== null && isRecord(content.repository) && str(content.repository.nameWithOwner)
			? content.repository.nameWithOwner
			: null;
	return ok({
		itemId: item.id,
		contentNumber: content !== null && typeof content.number === "number" ? content.number : null,
		contentType: content !== null && str(content.__typename) ? content.__typename : "DraftIssue",
		repository,
		values,
	});
};

/** One page of a project's items, parsed; exported so a recorded page can prove the parse. */
export const readItemsPage = (
	data: Record<string, unknown>,
): Attempt<{readonly items: ReadonlyArray<ProjectItem>; readonly next: string | null}> => {
	const project = isRecord(data.node) ? data.node : null;
	const connection = project !== null && isRecord(project.items) ? project.items : null;
	if (connection === null || !Array.isArray(connection.nodes)) {
		return fail("GitHub answered 200 but the project lists no items");
	}
	const items: ProjectItem[] = [];
	for (const node of connection.nodes) {
		if (!isRecord(node)) return fail("GitHub answered 200 but one item is not a project item");
		const item = readItemNode(node);
		if (item._tag === "Failure") return item;
		items.push(item.value);
	}
	return ok({items, next: nextCursor(connection)});
};

/** Every item on the project with its table values, read to the last page. */
export const readItems = (
	token: string,
	projectId: string,
): Api<ProjectsAnswer<ReadonlyArray<ProjectItem>>> =>
	Effect.gen(function* () {
		const items: ProjectItem[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < PAGE_CAP; page++) {
			const answer: ProjectsAnswer<{
				readonly items: ReadonlyArray<ProjectItem>;
				readonly next: string | null;
			}> = yield* exchange(token, ITEMS_QUERY, {id: projectId, cursor}, readItemsPage);
			if (answer._tag !== "Ok") return answer;
			items.push(...answer.value.items);
			if (answer.value.next === null) return done(items);
			cursor = answer.value.next;
		}
		return failed(`the project holds more items than ${PAGE_CAP} pages hold`);
	});

const STATUS_UPDATE = `
mutation TableStatusUpdate($input: CreateProjectV2StatusUpdateInput!) {
  createProjectV2StatusUpdate(input: $input) { statusUpdate { id } }
}`;

/** Post the project's native status update. Answers its node id. */
export const postStatusUpdate = (
	token: string,
	projectId: string,
	update: StatusUpdateInput,
): Api<ProjectsAnswer<string>> =>
	exchange(token, STATUS_UPDATE, {input: {projectId, ...update}}, (data) => {
		const payload = isRecord(data.createProjectV2StatusUpdate)
			? data.createProjectV2StatusUpdate
			: null;
		const status = payload !== null && isRecord(payload.statusUpdate) ? payload.statusUpdate : null;
		return status !== null && str(status.id)
			? ok(status.id)
			: fail("GitHub answered 200 but posted no status update");
	});

/**
 * Run `use` under the ambient credential and transport. No credential is `Failed`: it is not a
 * scope problem, and naming the scope fix for a token that does not exist sends the operator to the
 * wrong command.
 */
export const withProjects = <A>(
	use: (token: string) => Api<ProjectsAnswer<A>>,
): Shell<ProjectsAnswer<A>> =>
	Effect.gen(function* () {
		const token = yield* ambientToken;
		return token._tag === "Failure"
			? failed<A>(token.reason)
			: yield* onTransport(use(token.value));
	});
