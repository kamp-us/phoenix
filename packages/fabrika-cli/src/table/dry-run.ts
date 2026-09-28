/**
 * `--dry-run` for `table sync` and `table prep`: the verb runs over a board whose reads go through
 * and whose writes are recorded and never sent.
 *
 * **The recorder folds each write into its own view of the board**, so the verb's later phases read
 * the planned state exactly as they would read the landed one: an added issue reads back as a row
 * under a stand-in item id, a set cell reads back set, a removed item is gone, a posted status
 * update and a check comment read back among the rest. The decision core is the one a live run
 * uses; only the board differs.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10086
 */

import {Effect} from "effect";
import {type Attempt, ok} from "../io/git.ts";
import type {
	FieldValue,
	ItemFieldValue,
	ProjectItem,
	ProjectSnapshot,
	ProjectsAnswer,
	StatusUpdate,
	StatusUpdateInput,
	StatusUpdateStatus,
} from "../io/projects.ts";
import type {PrepBoard} from "./prep-verb.ts";
import type {SyncBoard} from "./sync-verb.ts";

/** One write a dry run planned and did not send. `project` is the project's number. */
export type PlannedWrite =
	| {readonly _tag: "Add"; readonly project: number | null; readonly issue: number}
	| {
			readonly _tag: "Set";
			readonly project: number | null;
			readonly issue: number | null;
			readonly field: string;
			readonly value: string | number;
	  }
	| {
			readonly _tag: "Clear";
			readonly project: number | null;
			readonly issue: number | null;
			readonly field: string;
	  }
	| {readonly _tag: "Delete"; readonly project: number | null; readonly issue: number | null}
	| {readonly _tag: "Comment"; readonly issue: number; readonly body: string}
	| {
			readonly _tag: "Post";
			readonly project: number | null;
			readonly status: StatusUpdateStatus;
			readonly body: string;
	  };

const where = (project: number | null): string =>
	project === null ? "the project" : `project #${project}`;
const on = (issue: number | null): string => (issue === null ? "an item" : `#${issue}`);

/** One line per planned write, read as what a live run would do. */
export const describePlanned = (write: PlannedWrite): string => {
	switch (write._tag) {
		case "Add":
			return `add #${write.issue} to ${where(write.project)}`;
		case "Set":
			return `set ${on(write.issue)} ${write.field} to ${JSON.stringify(write.value)}`;
		case "Clear":
			return `clear ${on(write.issue)} ${write.field}`;
		case "Delete":
			return `take ${on(write.issue)} off ${where(write.project)}`;
		case "Comment":
			return `comment on #${write.issue}`;
		case "Post":
			return `post the status update to ${where(write.project)}`;
	}
};

export interface DryRun<B> {
	readonly board: B;
	/** Every write the run planned, in the order it would have sent them. */
	readonly planned: () => ReadonlyArray<PlannedWrite>;
}

interface Added {
	readonly itemId: string;
	readonly repo: string;
}

type Target = Parameters<SyncBoard<never>["set"]>[0];

const done = <A>(value: A): Effect.Effect<ProjectsAnswer<A>> => Effect.succeed({_tag: "Ok", value});

/** The shared recorder: the project view every wrapped board method reads and writes. */
const recorder = <R>(base: Pick<SyncBoard<R>, "locate" | "items">, at: string) => {
	const projects = new Map<string, ProjectSnapshot>();
	const added = new Map<string, Map<number, Added>>();
	const cells = new Map<string, Map<string, ItemFieldValue | null>>();
	const removed = new Set<string>();
	const issueOf = new Map<string, number>();
	const comments = new Map<number, string[]>();
	const posts = new Map<string, StatusUpdate[]>();
	const planned: PlannedWrite[] = [];
	const numberOf = (projectId: string): number | null => projects.get(projectId)?.number ?? null;

	const readValue = (projectId: string, fieldId: string, value: FieldValue): ItemFieldValue => {
		const field = projects.get(projectId)?.fields.find((one) => one.id === fieldId);
		const fieldName = field?.name ?? fieldId;
		const stamp = {fieldId, fieldName, creator: null, updatedAt: at};
		switch (value._tag) {
			case "Option": {
				const option =
					field?._tag === "SingleSelect"
						? field.options.find((one) => one.id === value.optionId)
						: undefined;
				return {...stamp, value: {...value, name: option?.name ?? value.optionId}};
			}
			case "Iteration":
				return {...stamp, value: {...value, title: value.iterationId}};
			default:
				return {...stamp, value};
		}
	};
	const shown = (value: ItemFieldValue["value"]): string | number => {
		switch (value._tag) {
			case "Option":
				return value.name;
			case "Iteration":
				return value.title;
			case "Text":
				return value.text;
			case "Number":
				return value.number;
			case "Date":
				return value.date;
		}
	};
	const withCells = (item: ProjectItem): ProjectItem => {
		const over = cells.get(item.itemId);
		if (over === undefined) return item;
		const values = item.values.filter((one) => !over.has(one.fieldId));
		for (const value of over.values()) if (value !== null) values.push(value);
		return {...item, values};
	};
	const fold = (
		projectId: string,
		items: ReadonlyArray<ProjectItem>,
	): ReadonlyArray<ProjectItem> => {
		const live = items.filter((item) => !removed.has(item.itemId));
		for (const item of live) {
			if (item.contentNumber !== null) issueOf.set(item.itemId, item.contentNumber);
		}
		const standing = new Set(live.map((item) => item.contentNumber));
		const stand = [...(added.get(projectId) ?? [])]
			.filter(([issue, one]) => !standing.has(issue) && !removed.has(one.itemId))
			.map(
				([issue, one]): ProjectItem => ({
					itemId: one.itemId,
					contentNumber: issue,
					contentType: "Issue",
					repository: one.repo,
					values: [],
				}),
			);
		return [...live, ...stand].map(withCells);
	};
	const cellsOf = (itemId: string): Map<string, ItemFieldValue | null> => {
		const found = cells.get(itemId) ?? new Map<string, ItemFieldValue | null>();
		cells.set(itemId, found);
		return found;
	};

	return {
		planned: (): ReadonlyArray<PlannedWrite> => [...planned],
		locate: ((repo, target) =>
			Effect.tap(base.locate(repo, target), (answer) =>
				Effect.sync(() => {
					if (answer._tag === "Ok" && answer.value._tag === "Located") {
						projects.set(answer.value.project.id, answer.value.project);
					}
				}),
			)) satisfies SyncBoard<R>["locate"],
		items: ((projectId) =>
			Effect.map(
				base.items(projectId),
				(answer): ProjectsAnswer<ReadonlyArray<ProjectItem>> =>
					answer._tag === "Ok" ? {_tag: "Ok", value: fold(projectId, answer.value)} : answer,
			)) satisfies SyncBoard<R>["items"],
		add: (projectId: string, repo: string, issue: number) =>
			Effect.suspend(() => {
				const onProject = added.get(projectId) ?? new Map<number, Added>();
				added.set(projectId, onProject);
				const itemId = onProject.get(issue)?.itemId ?? `dry-run:${projectId}:${issue}`;
				onProject.set(issue, {itemId, repo});
				issueOf.set(itemId, issue);
				planned.push({_tag: "Add", project: numberOf(projectId), issue});
				return done(itemId);
			}),
		set: (target: Target, value: FieldValue) =>
			Effect.suspend(() => {
				const read = readValue(target.projectId, target.fieldId, value);
				cellsOf(target.itemId).set(target.fieldId, read);
				planned.push({
					_tag: "Set",
					project: numberOf(target.projectId),
					issue: issueOf.get(target.itemId) ?? null,
					field: read.fieldName,
					value: shown(read.value),
				});
				return done(target.itemId);
			}),
		clear: (target: Target) =>
			Effect.suspend(() => {
				cellsOf(target.itemId).set(target.fieldId, null);
				const field = projects
					.get(target.projectId)
					?.fields.find((one) => one.id === target.fieldId);
				planned.push({
					_tag: "Clear",
					project: numberOf(target.projectId),
					issue: issueOf.get(target.itemId) ?? null,
					field: field?.name ?? target.fieldId,
				});
				return done(target.itemId);
			}),
		remove: (projectId: string, itemId: string) =>
			Effect.suspend(() => {
				removed.add(itemId);
				planned.push({
					_tag: "Delete",
					project: numberOf(projectId),
					issue: issueOf.get(itemId) ?? null,
				});
				return done(itemId);
			}),
		comment: (issue: number, body: string): Effect.Effect<Attempt<unknown>> =>
			Effect.sync(() => {
				comments.set(issue, [...(comments.get(issue) ?? []), body]);
				planned.push({_tag: "Comment", issue, body});
				return ok(undefined);
			}),
		commentsOn: (issue: number): ReadonlyArray<string> => comments.get(issue) ?? [],
		post: (projectId: string, update: StatusUpdateInput) =>
			Effect.suspend(() => {
				const standing = posts.get(projectId) ?? [];
				const id = `dry-run:${projectId}:update:${standing.length}`;
				posts.set(projectId, [
					...standing,
					{id, body: update.body, startDate: update.startDate ?? null},
				]);
				planned.push({
					_tag: "Post",
					project: numberOf(projectId),
					status: update.status,
					body: update.body,
				});
				return done(id);
			}),
		postsOn: (projectId: string): ReadonlyArray<StatusUpdate> => posts.get(projectId) ?? [],
	};
};

/** `board` with every write recorded and folded into what its reads answer; `at` stamps a set cell. */
export const dryRunSync = <R>(board: SyncBoard<R>, at: string): DryRun<SyncBoard<R>> => {
	const r = recorder(board, at);
	return {
		board: {...board, locate: r.locate, items: r.items, add: r.add, set: r.set, clear: r.clear},
		planned: r.planned,
	};
};

/** `board` with every write recorded and folded into what its reads answer; `at` stamps a set cell. */
export const dryRunPrep = <R>(board: PrepBoard<R>, at: string): DryRun<PrepBoard<R>> => {
	const r = recorder(board, at);
	return {
		board: {
			...board,
			locate: r.locate,
			items: r.items,
			add: r.add,
			set: r.set,
			clear: r.clear,
			remove: r.remove,
			comment: (_repo, issue, body) => r.comment(issue, body),
			comments: (repo, issue) =>
				Effect.map(board.comments(repo, issue), (read) =>
					read._tag === "Failure" ? read : ok([...read.value, ...r.commentsOn(issue)]),
				),
			post: r.post,
			statusUpdates: (projectId) =>
				Effect.map(board.statusUpdates(projectId), (read) =>
					read._tag === "Ok" ? {_tag: "Ok", value: [...read.value, ...r.postsOn(projectId)]} : read,
				),
		},
		planned: r.planned,
	};
};
