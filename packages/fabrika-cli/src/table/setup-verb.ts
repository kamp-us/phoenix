/**
 * `table setup` — find or create the repository's table project and bring it to the table's shape.
 *
 * The run is three passes over one plan: create the missing fields, re-read, align views and the
 * README against the fields that now exist, re-read, and plan once more. **That last plan must be
 * empty**: it is the read-back, and it is also what makes a second run answer `unchanged` — the same
 * function that proves this run landed decides the next run has nothing to do.
 *
 * A conflict refuses before anything is written to the project. A project this run created or linked
 * is still named in that refusal, so a re-run after the conflict is fixed finds it rather than creating a
 * second one.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type AppetiteSizes, appetiteSizesKey} from "../config/keys/appetite-sizes.ts";
import {type TableSettings, tableKey} from "../config/keys/table.ts";
import {readKey} from "../config/read-key.ts";
import type {Api} from "../io/gh-api.ts";
import {resolveRepo} from "../io/issues.ts";
import {
	createField,
	createProject,
	createView,
	linkProject,
	type ProjectRef,
	type ProjectSnapshot,
	type ProjectsAnswer,
	type RepositoryNode,
	readOwnerProjects,
	readProject,
	readProjectByNumber,
	readRepository,
	updateProject,
	updateView,
	withProjects,
} from "../io/projects.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	AMBIGUOUS_PROJECT,
	CONFIG_MALFORMED,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SCOPE_MISSING,
	SHAPE_CONFLICT,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {describeDrift, describeStep, type Plan, plan, type Step} from "./reconcile.ts";
import {defaultTitle, type TableShape, tableShape} from "./shape.ts";

export interface SetupOptions {
	readonly repo: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

const VERB = "table setup";

/**
 * Where the project came from this run: made, already linked to the repository, or found under
 * the owner by its title and linked now.
 */
type Origin = "created" | "found" | "linked";

type Run =
	| {
			readonly _tag: "Done";
			readonly origin: Origin;
			readonly project: ProjectSnapshot;
			readonly changes: ReadonlyArray<string>;
			readonly drift: ReadonlyArray<string>;
			readonly manualSteps: ReadonlyArray<string>;
	  }
	| {readonly _tag: "Refused"; readonly code: number; readonly reason: string};

const refused = (code: number, reason: string): Run => ({_tag: "Refused", code, reason});

/** A non-`Ok` answer as the run's refusal; `onFailure` seats a read and a write differently. */
const stop = (
	answer: Exclude<ProjectsAnswer<unknown>, {_tag: "Ok"}>,
	onFailure: number,
	what: string,
): Run =>
	answer._tag === "MissingScope"
		? refused(SCOPE_MISSING, `${VERB}: ${answer.reason}.`)
		: refused(onFailure, `${VERB}: ${what}: ${answer.reason}.`);

type Located =
	| {readonly _tag: "Located"; readonly origin: Origin; readonly project: ProjectSnapshot}
	| {readonly _tag: "Refused"; readonly run: Run};

const locate = (
	token: string,
	repo: string,
	node: RepositoryNode,
	settings: TableSettings,
): Api<Located> =>
	Effect.gen(function* () {
		const owner = settings.project.owner ?? node.owner.login;
		const wanted = settings.project.number;
		if (wanted !== null) {
			const read = yield* readProjectByNumber(token, owner, wanted);
			if (read._tag !== "Ok") {
				return {
					_tag: "Refused",
					run: stop(read, PRECONDITION_UNKNOWN, `cannot read project ${owner}#${wanted}`),
				};
			}
			if (read.value === null) {
				return {
					_tag: "Refused",
					run: refused(
						NO_TARGET,
						`${VERB}: \`table.project\` names project ${wanted} under ${owner}, and ${owner} has no such project — fix the number, or remove it to have setup find or create the table. Nothing was written.`,
					),
				};
			}
			return {_tag: "Located", origin: "found", project: read.value};
		}

		const title = defaultTitle(repo);
		const titled = (refs: ReadonlyArray<ProjectRef>) =>
			refs.filter((ref) => ref.title === title && !ref.closed);
		const ambiguous = (refs: ReadonlyArray<ProjectRef>, where: string): Located => ({
			_tag: "Refused",
			run: refused(
				AMBIGUOUS_PROJECT,
				`${VERB}: ${refs.length} open projects ${where} are titled "${title}" (${refs.map((ref) => `#${ref.number}`).join(", ")}) — set \`table.project.number\` in .fabrika.jsonc to the one that is the table. Nothing was written.`,
			),
		});
		const readExisting = (ref: ProjectRef, origin: Origin): Api<Located> =>
			Effect.map(readProject(token, ref.id), (read) =>
				read._tag === "Ok"
					? {_tag: "Located", origin, project: read.value}
					: {
							_tag: "Refused",
							run: stop(read, PRECONDITION_UNKNOWN, `cannot read project #${ref.number}`),
						},
			);

		const linked = titled(node.linkedProjects);
		if (linked.length > 1) return ambiguous(linked, `linked to ${repo}`);
		const existing = linked[0];
		if (existing !== undefined) return yield* readExisting(existing, "found");

		const ownerNode = yield* readOwnerProjects(token, owner);
		if (ownerNode._tag !== "Ok") {
			return {
				_tag: "Refused",
				run: stop(ownerNode, PRECONDITION_UNKNOWN, `cannot read ${owner}'s projects`),
			};
		}
		const owned = titled(ownerNode.value.projects);
		if (owned.length > 1) return ambiguous(owned, `under ${owner}`);
		const unlinked = owned[0];
		if (unlinked !== undefined) {
			const link = yield* linkProject(token, unlinked.id, node.id);
			if (link._tag !== "Ok") {
				return {
					_tag: "Refused",
					run: stop(
						link,
						WRITE_UNKNOWN,
						`linking project #${unlinked.number} "${title}" to ${repo} did not answer — UNKNOWN whether it is linked; re-run setup, which finds it either way`,
					),
				};
			}
			return yield* readExisting(unlinked, "linked");
		}

		const created = yield* createProject(token, {
			ownerId: ownerNode.value.id,
			title,
			repositoryId: node.id,
		});
		if (created._tag !== "Ok") {
			return {
				_tag: "Refused",
				run: stop(
					created,
					WRITE_UNKNOWN,
					`creating project "${title}" under ${owner} did not answer — UNKNOWN whether it exists; re-run setup, which finds it by title if it does`,
				),
			};
		}
		const read = yield* readProject(token, created.value);
		if (read._tag !== "Ok") {
			return {
				_tag: "Refused",
				run: stop(
					read,
					READBACK_MISMATCH,
					`created project "${title}" under ${owner} and could not read it back`,
				),
			};
		}
		return {_tag: "Located", origin: "created", project: read.value};
	});

/** Apply one step against the project as it now reads; `null` is success. */
const apply = (
	token: string,
	project: ProjectSnapshot,
	step: Step,
): Api<Exclude<ProjectsAnswer<unknown>, {_tag: "Ok"}> | null> =>
	Effect.gen(function* () {
		const idOf = new Map(project.fields.map((field) => [field.name, field.id] as const));
		const visible = (names: ReadonlyArray<string>) =>
			names.flatMap((name) => {
				const id = idOf.get(name);
				return id === undefined ? [] : [id];
			});
		switch (step._tag) {
			case "CreateField": {
				const done = yield* createField(token, project.id, step.spec);
				return done._tag === "Ok" ? null : done;
			}
			case "CreateView": {
				const visibleFieldIds = visible(step.view.fields);
				const made = yield* createView(token, project.id, {
					name: step.view.name,
					layout: step.view.layout,
					visibleFieldIds,
				});
				if (made._tag !== "Ok") return made;
				const aligned = yield* updateView(token, made.value, {
					filter: step.view.filter,
					visibleFieldIds,
				});
				return aligned._tag === "Ok" ? null : aligned;
			}
			case "UpdateView": {
				const done = yield* updateView(token, step.viewId, {
					...(step.layout !== null ? {layout: step.layout} : {}),
					...(step.filter !== null ? {filter: step.filter} : {}),
					...(step.visibleFieldIds !== null ? {visibleFieldIds: step.visibleFieldIds} : {}),
				});
				return done._tag === "Ok" ? null : done;
			}
			case "UpdateProject": {
				const done = yield* updateProject(token, project.id, {
					...(step.readme !== null ? {readme: step.readme} : {}),
					...(step.shortDescription !== null ? {shortDescription: step.shortDescription} : {}),
				});
				return done._tag === "Ok" ? null : done;
			}
		}
	});

/** What locating the project wrote, if anything. */
const locateWrote = (origin: Origin, project: ProjectSnapshot, repo: string): string | null => {
	switch (origin) {
		case "created":
			return `created project #${project.number} "${project.title}" (${project.url})`;
		case "linked":
			return `linked project #${project.number} "${project.title}" (${project.url}) to ${repo}`;
		case "found":
			return null;
	}
};

const conflictReason = (plan: Plan, wrote: string | null): string => {
	const listed = plan.conflicts
		.map((conflict) => `${conflict.field} is ${conflict.found}, the table needs ${conflict.wanted}`)
		.join("; ");
	const made = wrote === null ? "" : `${wrote}, then `;
	return `${VERB}: ${made}found fields the table needs under another type: ${listed} — rename or delete them in the project, then re-run. Nothing was changed for them.`;
};

/** Apply every step in `steps`, recording each that lands. */
const applyAll = (
	token: string,
	project: ProjectSnapshot,
	steps: ReadonlyArray<Step>,
	landed: string[],
): Api<Run | null> =>
	Effect.gen(function* () {
		for (const step of steps) {
			const failure = yield* apply(token, project, step);
			if (failure !== null) {
				const so = landed.length > 0 ? ` after: ${landed.join("; ")}` : "";
				return stop(
					failure,
					WRITE_UNKNOWN,
					`${describeStep(step)} did not land — UNKNOWN${so}; re-run setup to finish`,
				);
			}
			landed.push(describeStep(step));
		}
		return null;
	});

const reread = (token: string, project: ProjectSnapshot, landed: ReadonlyArray<string>) =>
	Effect.map(readProject(token, project.id), (read) =>
		read._tag === "Ok"
			? ({_tag: "Read", project: read.value} as const)
			: ({
					_tag: "Refused",
					run: stop(
						read,
						READBACK_MISMATCH,
						`wrote ${landed.join("; ")} and could not read project #${project.number} back`,
					),
				} as const),
	);

const converge = (
	token: string,
	repo: string,
	settings: TableSettings,
	sizes: AppetiteSizes,
	now: Date,
): Api<Run> =>
	Effect.gen(function* () {
		const node = yield* readRepository(token, repo);
		if (node._tag !== "Ok") return stop(node, PRECONDITION_UNKNOWN, `cannot read ${repo}`);

		const located = yield* locate(token, repo, node.value, settings);
		if (located._tag === "Refused") return located.run;
		const {origin} = located;
		const shape: TableShape = tableShape(settings, sizes, repo, located.project.title, now);

		const wrote = locateWrote(origin, located.project, repo);
		const first = plan(shape, located.project);
		if (first.conflicts.length > 0) {
			return refused(SHAPE_CONFLICT, conflictReason(first, wrote));
		}

		const landed: string[] = wrote === null ? [] : [wrote];
		const fieldSteps = first.steps.filter((step) => step._tag === "CreateField");
		const fieldsFailed = yield* applyAll(token, located.project, fieldSteps, landed);
		if (fieldsFailed !== null) return fieldsFailed;

		const withFields = yield* reread(token, located.project, landed);
		if (withFields._tag === "Refused") return withFields.run;
		const second = plan(shape, withFields.project);
		const rest = second.steps.filter((step) => step._tag !== "CreateField");
		const restFailed = yield* applyAll(token, withFields.project, rest, landed);
		if (restFailed !== null) return restFailed;

		const final = yield* reread(token, withFields.project, landed);
		if (final._tag === "Refused") return final.run;
		const settled = plan(shape, final.project);
		if (settled.steps.length > 0 || settled.conflicts.length > 0) {
			const open = settled.steps.map(describeStep).join("; ");
			return refused(
				READBACK_MISMATCH,
				`${VERB}: wrote ${landed.join("; ") || "nothing"} and project #${final.project.number} still does not read as the table: ${open} — re-read it before retrying.`,
			);
		}

		return {
			_tag: "Done",
			origin,
			project: final.project,
			changes: landed,
			drift: settled.drift.map(describeDrift),
			manualSteps: shape.manualSteps,
		};
	});

export const runSetup = (
	options: SetupOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const settings = yield* readKey(options.cwd, tableKey);
		if (settings._tag === "Refused") {
			return refuse(CONFIG_MALFORMED, `${VERB}: ${settings.reason}. Nothing was read from GitHub.`);
		}
		const sizes = yield* readKey(options.cwd, appetiteSizesKey);
		if (sizes._tag === "Refused") {
			return refuse(CONFIG_MALFORMED, `${VERB}: ${sizes.reason}. Nothing was read from GitHub.`);
		}

		const resolved = yield* resolveRepo(options.repo, options.env);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: no --repo, no CLAUDE_PIPELINE_REPO, no GITHUB_REPOSITORY and no readable origin remote — no repository to set the table up for.`,
			);
		}
		const repo = resolved.value;

		const run = yield* withProjects<Run>((token) =>
			Effect.map(converge(token, repo, settings.value, sizes.value, options.now()), (value) => ({
				_tag: "Ok" as const,
				value,
			})),
		);
		if (run._tag === "MissingScope") return refuse(SCOPE_MISSING, `${VERB}: ${run.reason}.`);
		if (run._tag === "Failed") return refuse(PRECONDITION_UNKNOWN, `${VERB}: ${run.reason}.`);
		const outcome = run.value;
		if (outcome._tag === "Refused") return refuse(outcome.code, outcome.reason);

		const verdict =
			outcome.origin === "created"
				? "created"
				: outcome.changes.length > 0
					? "reconciled"
					: "unchanged";
		const {project} = outcome;
		const notes = [
			`${VERB}: read ${settings.note}.`,
			`${VERB}: read ${sizes.note}.`,
			`${VERB}: ${outcome.origin} project #${project.number} "${project.title}" (${project.url}) for ${repo}.`,
			...(outcome.changes.length > 0
				? outcome.changes.map((change) => `${VERB}: ${change}.`)
				: [`${VERB}: the project already has the table's shape; nothing was written.`]),
			...outcome.drift.map((drift) => `${VERB}: drift: ${drift}.`),
			...outcome.manualSteps.map((step, index) => `${VERB}: manual step ${index + 1}: ${step}`),
		];
		return answer(
			`${JSON.stringify({
				answer: verdict,
				repo,
				project: {number: project.number, title: project.title, url: project.url},
				changes: outcome.changes,
				drift: outcome.drift,
				manualSteps: outcome.manualSteps,
			})}\n`,
			notes,
		);
	});
