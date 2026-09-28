/**
 * The GitHub Projects (v2) client: find or create a project, shape its fields and views, add items,
 * set and read field values, and post a status update.
 *
 * GraphQL, by the founder's ruling on the table's home (R4.1 on the issue below). That makes this
 * module the fourth carve from `./gh-api.ts`'s REST default, and the only one that writes project
 * state. It rests on the ruling, not on an absence of REST: GitHub publishes part of this domain
 * over REST, and whether those edges move there is still an open question. One edge already has:
 * {@link createView} is REST, because only REST groups a view as it creates it.
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
 * @ruling https://github.com/kamp-us/phoenix/issues/9989
 */

import {Effect} from "effect";
import {
	type Api,
	ambientToken,
	graphqlRead,
	onTransport,
	PAGE_CAP,
	type Rest,
	refusalText,
	restWrite,
} from "./gh-api.ts";
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

/** What every field carries: its node id, and the numeric id the REST API names it by. */
interface FieldIds {
	readonly id: string;
	readonly databaseId: number;
	readonly name: string;
}

export type ProjectField =
	| (FieldIds & {
			readonly _tag: "SingleSelect";
			readonly options: ReadonlyArray<SelectOption>;
	  })
	| (FieldIds & {
			readonly _tag: "Iteration";
			readonly duration: number;
			readonly startDay: number;
	  })
	/** Every other field, built-in or custom, by its `dataType` (`TEXT`, `NUMBER`, `DATE`, `TITLE`, …). */
	| (FieldIds & {readonly _tag: "Plain"; readonly dataType: string});

export interface ProjectView {
	readonly id: string;
	readonly number: number;
	readonly name: string;
	readonly layout: ViewLayout;
	readonly filter: string | null;
	readonly visibleFieldIds: ReadonlyArray<string>;
}

/**
 * Who owns a project, as the REST path for its views names them: `/orgs/{login}` or
 * `/users/{login}`. A user's path takes the login; its numeric id answers 404.
 */
export interface ProjectOwner {
	readonly kind: "Organization" | "User";
	readonly login: string;
}

export interface ProjectSnapshot {
	readonly id: string;
	readonly number: number;
	readonly owner: ProjectOwner;
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

/** A single-select option GitHub has not minted an id for yet. */
export type NewOption = Omit<SelectOption, "id">;

/** What a new field is created as. Single-select options carry no id until GitHub mints one. */
export type FieldSpec =
	| {readonly _tag: "Text"; readonly name: string}
	| {readonly _tag: "Number"; readonly name: string}
	| {
			readonly _tag: "SingleSelect";
			readonly name: string;
			readonly options: ReadonlyArray<NewOption>;
	  }
	| {readonly _tag: "Date"; readonly name: string};

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
  owner { __typename ... on Organization { login } ... on User { login } }
  fields(first: 100) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on ProjectV2FieldCommon { id databaseId name dataType }
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
	if (!isRecord(node) || !str(node.id) || !str(node.name) || typeof node.databaseId !== "number") {
		return null;
	}
	const ids = {id: node.id, databaseId: node.databaseId, name: node.name};
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
		return {_tag: "SingleSelect", ...ids, options};
	}
	if (node.__typename === "ProjectV2IterationField") {
		const config = isRecord(node.configuration) ? node.configuration : null;
		if (config === null || typeof config.duration !== "number") return null;
		return {
			_tag: "Iteration",
			...ids,
			duration: config.duration,
			startDay: typeof config.startDay === "number" ? config.startDay : 0,
		};
	}
	return {_tag: "Plain", ...ids, dataType: str(node.dataType) ? node.dataType : "UNKNOWN"};
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

const readOwner = (node: unknown): ProjectOwner | null =>
	isRecord(node) &&
	(node.__typename === "Organization" || node.__typename === "User") &&
	str(node.login)
		? {kind: node.__typename, login: node.login}
		: null;

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
	const owner = readOwner(node.owner);
	if (owner === null) {
		return fail("GitHub answered 200 but the project names no user or organization owner");
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
		owner,
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

/** The cursor of the next page, `null` on the last; a next page with no cursor to reach it is a cut read. */
const nextCursor = (connection: Record<string, unknown>): Attempt<string | null> => {
	const info = isRecord(connection.pageInfo) ? connection.pageInfo : null;
	if (info === null || info.hasNextPage !== true) return ok(null);
	return str(info.endCursor)
		? ok(info.endCursor)
		: fail("GitHub answered 200 with a next page but no cursor to read it by");
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
				const next = nextCursor(projects);
				if (next._tag === "Failure") return next;
				return ok({
					id: repository.id,
					owner: {id: ownerNode.id, login: ownerNode.login},
					refs: refs.value,
					next: next.value,
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
				if (refs._tag === "Failure") return refs;
				const next = nextCursor(connection);
				return next._tag === "Failure"
					? next
					: ok({id: owner.id, refs: refs.value, next: next.value});
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
		case "Date":
			return {projectId, name: spec.name, dataType: "DATE"};
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

const UPDATE_FIELD = `
mutation TableUpdateField($input: UpdateProjectV2FieldInput!) {
  updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id } } }
}`;

/** A single-select field's whole option list: every option it holds, then the ones to add. */
export interface OptionList {
	readonly kept: ReadonlyArray<SelectOption>;
	readonly added: ReadonlyArray<NewOption>;
}

/**
 * Rewrite a single-select field's options. GitHub replaces the whole list, and an option sent
 * without its id is minted anew, which clears every item's value on the old one — so each kept
 * option goes back with its own id, name, color and description, ahead of the added ones.
 */
export const updateFieldOptions = (
	token: string,
	fieldId: string,
	list: OptionList,
): Api<ProjectsAnswer<string>> =>
	exchange(
		token,
		UPDATE_FIELD,
		{
			input: {
				fieldId,
				singleSelectOptions: [
					...list.kept.map(({id, name, color, description}) => ({id, name, color, description})),
					...list.added.map(({name, color, description}) => ({name, color, description})),
				],
			},
		},
		fieldIdOf("updateProjectV2Field"),
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

/**
 * How a new view groups its rows, by the grouped field's numeric id. A table groups rows; a board's
 * columns are its grouping, so a board never takes `Rows`.
 */
export type NewViewGrouping =
	| {readonly _tag: "None"}
	| {readonly _tag: "Rows"; readonly fieldId: number}
	| {readonly _tag: "Columns"; readonly fieldId: number};

/** A view to create, every field named by its numeric id as the REST API takes it. */
export interface NewView {
	readonly name: string;
	readonly layout: Exclude<ViewLayout, "ROADMAP_LAYOUT">;
	readonly filter: string;
	readonly visibleFields: ReadonlyArray<number>;
	readonly grouping: NewViewGrouping;
}

const REST_LAYOUT: Readonly<Record<NewView["layout"], string>> = {
	TABLE_LAYOUT: "table",
	BOARD_LAYOUT: "board",
};

/** The path a project's views are created under, by who owns it. */
export const viewsPath = (owner: ProjectOwner, number: number): string =>
	`${owner.kind === "Organization" ? "orgs" : "users"}/${owner.login}/projectsV2/${number}/views`;

/** The REST body that creates `view`, grouped on create — GraphQL's view input takes no grouping. */
export const newViewBody = (view: NewView): Record<string, unknown> => ({
	name: view.name,
	layout: REST_LAYOUT[view.layout],
	filter: view.filter,
	visible_fields: view.visibleFields,
	...(view.grouping._tag === "Rows" ? {group_by: [view.grouping.fieldId]} : {}),
	...(view.grouping._tag === "Columns" ? {vertical_group_by: [view.grouping.fieldId]} : {}),
});

/**
 * A new view, created over REST so it is grouped from the start. Answers its node id, which is what
 * {@link updateView} and every GraphQL read name it by.
 */
export const createView = (
	token: string,
	project: {readonly owner: ProjectOwner; readonly number: number},
	view: NewView,
): Api<ProjectsAnswer<string>> =>
	Effect.map(
		restWrite(token, "POST", viewsPath(project.owner, project.number), newViewBody(view)),
		(outcome): ProjectsAnswer<string> => {
			if (outcome._tag === "Unreachable") return failed(outcome.reason);
			if (scopeWithheld(outcome.headers) === true) {
				return missingScope(`its scopes are: ${outcome.headers["x-oauth-scopes"] || "none"}`);
			}
			if (outcome.status < 200 || outcome.status >= 300) return failed(refusalText(outcome));
			return isRecord(outcome.body) && str(outcome.body.node_id)
				? done(outcome.body.node_id)
				: failed("GitHub answered 2xx but created no view");
		},
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
		return readItemValuesNode(item);
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

/**
 * What a project item stands for. `Redacted` is an item GitHub answers with no content: its issue or
 * pull request lives where the token cannot see, so what it is stays unknown.
 */
export type ItemContentType = "Issue" | "PullRequest" | "DraftIssue" | "Redacted";

const CONTENT_TYPES: ReadonlySet<unknown> = new Set(["Issue", "PullRequest", "DraftIssue"]);

const isContentType = (typename: unknown): typename is Exclude<ItemContentType, "Redacted"> =>
	CONTENT_TYPES.has(typename);

/** One project item as the table reads it: what it stands for, and its table values. */
export interface ProjectItem extends ItemValues {
	readonly contentType: ItemContentType;
	/** The `owner/name` the issue or pull request lives in; `null` for a draft or a redacted item. */
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
const readItemValuesNode = (item: Record<string, unknown>): Attempt<ItemValues> => {
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
	return ok({
		itemId: item.id,
		contentNumber: content !== null && typeof content.number === "number" ? content.number : null,
		values,
	});
};

/** One item node with what it stands for, or why the node is not an item. */
const readItemNode = (item: Record<string, unknown>): Attempt<ProjectItem> => {
	const read = readItemValuesNode(item);
	if (read._tag === "Failure") return read;
	const content = isRecord(item.content) ? item.content : null;
	if (content === null) return ok({...read.value, contentType: "Redacted", repository: null});
	if (!isContentType(content.__typename)) {
		return fail(
			`GitHub answered 200 but item ${read.value.itemId} stands for no issue, pull request or draft`,
		);
	}
	const repository =
		isRecord(content.repository) && str(content.repository.nameWithOwner)
			? content.repository.nameWithOwner
			: null;
	return ok({...read.value, contentType: content.__typename, repository});
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
	const next = nextCursor(connection);
	return next._tag === "Failure" ? next : ok({items, next: next.value});
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

/** One project item as the bet order reads it: which issue, and the three cells that place it. */
export interface BoardItem {
	/** The issue the item stands for; `null` for a draft or a pull request, which is never a bet. */
	readonly issue: number | null;
	readonly archived: boolean;
	/** The option name set in each single-select, or `null` when the cell is empty. */
	readonly stage: string | null;
	readonly section: string | null;
	/** The `YYYY-MM-DD` in the item's table-day cell, or `null` when it is empty. */
	readonly tableDay: string | null;
}

export interface Board {
	readonly items: ReadonlyArray<BoardItem>;
}

/** The field names a board read places items by — the table's fixed vocabulary, passed in. */
export interface BoardFields {
	readonly stage: string;
	readonly section: string;
	readonly tableDay: string;
}

const BOARD_QUERY = `
query TableBoard($id: ID!, $stage: String!, $section: String!, $tableDay: String!, $cursor: String) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isArchived
          content { __typename ... on Issue { number } }
          stage: fieldValueByName(name: $stage) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          section: fieldValueByName(name: $section) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          tableDay: fieldValueByName(name: $tableDay) { ... on ProjectV2ItemFieldDateValue { date } }
        }
      }
    }
  }
}`;

const optionName = (cell: unknown): string | null =>
	isRecord(cell) && str(cell.name) ? cell.name : null;

const readBoardItem = (node: unknown): Attempt<BoardItem> => {
	if (!isRecord(node) || typeof node.isArchived !== "boolean") {
		return fail("GitHub answered 200 but one item is not a project item");
	}
	const content = isRecord(node.content) ? node.content : null;
	const tableDay = isRecord(node.tableDay) ? node.tableDay : null;
	return ok({
		issue:
			content !== null && content.__typename === "Issue" && typeof content.number === "number"
				? content.number
				: null,
		archived: node.isArchived,
		stage: optionName(node.stage),
		section: optionName(node.section),
		tableDay: tableDay !== null && str(tableDay.date) ? tableDay.date : null,
	});
};

/**
 * Every item on the project with its stage, section and table-day cells — read to the last page, so
 * a bet on page two is never left out.
 */
export const readBoard = (
	token: string,
	projectId: string,
	fields: BoardFields,
): Api<ProjectsAnswer<Board>> =>
	Effect.gen(function* () {
		const items: BoardItem[] = [];
		let cursor: string | null = null;
		const variables = {
			id: projectId,
			stage: fields.stage,
			section: fields.section,
			tableDay: fields.tableDay,
		};
		for (let page = 0; page < PAGE_CAP; page++) {
			const answer: ProjectsAnswer<{
				readonly items: ReadonlyArray<BoardItem>;
				readonly next: string | null;
			}> = yield* exchange(token, BOARD_QUERY, {...variables, cursor}, (data) => {
				const project = isRecord(data.node) ? data.node : null;
				const connection = project !== null && isRecord(project.items) ? project.items : null;
				if (project === null || connection === null || !Array.isArray(connection.nodes)) {
					return fail(`GitHub knows no project ${projectId}`);
				}
				const pageItems: BoardItem[] = [];
				for (const node of connection.nodes) {
					const item = readBoardItem(node);
					if (item._tag === "Failure") return item;
					pageItems.push(item.value);
				}
				const next = nextCursor(connection);
				if (next._tag === "Failure") return next;
				return ok({items: pageItems, next: next.value});
			});
			if (answer._tag !== "Ok") return answer;
			items.push(...answer.value.items);
			if (answer.value.next === null) return done({items});
			cursor = answer.value.next;
		}
		return failed(`project ${projectId} holds more items than ${PAGE_CAP} pages hold`);
	});

/** One iteration of a legacy iteration field, as the one-time migration reads it. */
export interface BoardIteration {
	readonly id: string;
	readonly title: string;
	/** `YYYY-MM-DD`, the day the iteration starts. */
	readonly startDate: string;
	/** In days. */
	readonly duration: number;
}

/**
 * An iteration field's whole history: the iterations it still runs and those it has finished. Read
 * only, by the migration off the legacy Week field — nothing here ever writes an iteration field.
 */
export interface IterationHistory {
	readonly running: ReadonlyArray<BoardIteration>;
	readonly completed: ReadonlyArray<BoardIteration>;
}

const WEEK_QUERY = `
query TableWeek($id: ID!, $week: String!) {
  node(id: $id) {
    ... on ProjectV2 {
      field(name: $week) {
        __typename
        ... on ProjectV2IterationField {
          configuration {
            iterations { id title startDate duration }
            completedIterations { id title startDate duration }
          }
        }
      }
    }
  }
}`;

const iterationList = (nodes: unknown): Attempt<ReadonlyArray<BoardIteration>> => {
	if (!Array.isArray(nodes)) return fail("GitHub answered 200 but an iteration list is missing");
	const iterations: BoardIteration[] = [];
	for (const node of nodes) {
		if (
			!isRecord(node) ||
			!str(node.id) ||
			!str(node.title) ||
			!str(node.startDate) ||
			typeof node.duration !== "number"
		) {
			return fail("GitHub answered 200 but one iteration is malformed");
		}
		iterations.push({
			id: node.id,
			title: node.title,
			startDate: node.startDate,
			duration: node.duration,
		});
	}
	return ok(iterations);
};

/**
 * One iteration field's history off a `TableWeek` answer; `null` when the project has no iteration
 * field under that name. Exported so a recorded answer can prove the parse.
 */
export const readWeekField = (data: Record<string, unknown>): Attempt<IterationHistory | null> => {
	const project = isRecord(data.node) ? data.node : null;
	if (project === null) return fail("GitHub answered 200 but names no project");
	const field = isRecord(project.field) ? project.field : null;
	if (field === null || field.__typename !== "ProjectV2IterationField") return ok(null);
	const config = isRecord(field.configuration) ? field.configuration : null;
	if (config === null)
		return fail("GitHub answered 200 but the iteration field has no configuration");
	const running = iterationList(config.iterations);
	if (running._tag === "Failure") return running;
	const completed = iterationList(config.completedIterations);
	if (completed._tag === "Failure") return completed;
	return ok({running: running.value, completed: completed.value});
};

/** The iteration field `week` names, read only: every iteration it runs, and every one it has finished. */
export const readIterationHistory = (
	token: string,
	projectId: string,
	week: string,
): Api<ProjectsAnswer<IterationHistory | null>> =>
	exchange(token, WEEK_QUERY, {id: projectId, week}, readWeekField);

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

/** One status update as the table reads it back. */
export interface StatusUpdate {
	readonly id: string;
	readonly body: string;
	/** `YYYY-MM-DD`, or `null` when the update names no start. */
	readonly startDate: string | null;
}

const STATUS_UPDATES_QUERY = `
query TableStatusUpdates($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on ProjectV2 {
      statusUpdates(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id body startDate }
      }
    }
  }
}`;

/** One page of a project's status updates, parsed; exported so a recorded page can prove the parse. */
export const readStatusUpdatesPage = (
	data: Record<string, unknown>,
): Attempt<{readonly updates: ReadonlyArray<StatusUpdate>; readonly next: string | null}> => {
	const project = isRecord(data.node) ? data.node : null;
	const connection =
		project !== null && isRecord(project.statusUpdates) ? project.statusUpdates : null;
	if (connection === null || !Array.isArray(connection.nodes)) {
		return fail("GitHub answered 200 but the project lists no status updates");
	}
	const updates: StatusUpdate[] = [];
	for (const node of connection.nodes) {
		if (!isRecord(node) || !str(node.id) || typeof node.body !== "string") {
			return fail("GitHub answered 200 but one status update is malformed");
		}
		updates.push({
			id: node.id,
			body: node.body,
			startDate: str(node.startDate) ? node.startDate : null,
		});
	}
	const next = nextCursor(connection);
	return next._tag === "Failure" ? next : ok({updates, next: next.value});
};

/** Every status update posted on the project, read to the last page. */
export const readStatusUpdates = (
	token: string,
	projectId: string,
): Api<ProjectsAnswer<ReadonlyArray<StatusUpdate>>> =>
	Effect.gen(function* () {
		const updates: StatusUpdate[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < PAGE_CAP; page++) {
			const answer: ProjectsAnswer<{
				readonly updates: ReadonlyArray<StatusUpdate>;
				readonly next: string | null;
			}> = yield* exchange(
				token,
				STATUS_UPDATES_QUERY,
				{id: projectId, cursor},
				readStatusUpdatesPage,
			);
			if (answer._tag !== "Ok") return answer;
			updates.push(...answer.value.updates);
			if (answer.value.next === null) return done(updates);
			cursor = answer.value.next;
		}
		return failed(`project ${projectId} holds more status updates than ${PAGE_CAP} pages hold`);
	});

const DELETE_ITEM = `
mutation TableDeleteItem($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: {projectId: $projectId, itemId: $itemId}) { deletedItemId }
}`;

/** Take one item off the project. The issue it stood for is untouched. Answers the deleted id. */
export const deleteItem = (
	token: string,
	projectId: string,
	itemId: string,
): Api<ProjectsAnswer<string>> =>
	exchange(token, DELETE_ITEM, {projectId, itemId}, (data) => {
		const payload = isRecord(data.deleteProjectV2Item) ? data.deleteProjectV2Item : null;
		return payload !== null && str(payload.deletedItemId)
			? ok(payload.deletedItemId)
			: fail("GitHub answered 200 but deleted no item");
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
