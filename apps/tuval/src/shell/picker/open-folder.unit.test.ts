/**
 * The folder a picker open hands the process it spawns (#9694, rulings #9668 R3.1 and R6.3). A
 * session entry for a project runs in that project's folder, a home entry runs where the shell runs,
 * and a project's own row runs in its project's folder. The harness reads `WorkingFolder` back out
 * of the context the spawn was handed, because a folder that never reaches the child produces the
 * same process and the same bind Msg as one that did.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Option, Result} from "effect";
import {ProjectId} from "../../project-id.ts";
import type {OpenProject} from "../../projects/open-projects.ts";
import {Projects} from "../../projects/Projects.ts";
import {pickerHarness, programId, programRow, shellProcessId, windowId} from "./fixtures.ts";
import {openFolder} from "./folder.ts";
import {openProgram} from "./intent.ts";
import {runPickerIntent} from "./open.ts";
import {HOME_PLACE, type SessionPlace} from "./place.ts";

const window = windowId("window-1");

const project = (folder: string): OpenProject => ({folder, id: ProjectId.of(folder)});
const phoenix = project("/code/kamp-us/phoenix");
const demlik = project("/code/kamp-us/demlik");

const placeOf = (open: OpenProject, label: string): SessionPlace => ({
	_tag: "Project",
	key: open.id.key,
	label,
});

/** A desk with `open` projects open, as the kernel's `Projects` answers the picker. */
const desk = (open: ReadonlyArray<OpenProject>) =>
	Projects.of({...Projects.none, list: Effect.succeed(open)});

const counterRow = programRow(phoenix.id.scope("counter"), {label: "Counter"});
const rows = [programRow("claude-session", {label: "Claude", folderAtStart: true}), counterRow];

const open = (id: string, place: SessionPlace | undefined, projects: ReadonlyArray<OpenProject>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const harness = yield* pickerHarness(rows);
			const msgs = yield* runPickerIntent(openProgram(window, programId(id), undefined, place), {
				shellProcessId,
			}).pipe(Effect.provide(harness.layer), Effect.provideService(Projects, desk(projects)));
			return {msgs, spawns: harness.spawns()};
		}),
	);

describe("the folder a picker open hands its process", () => {
	it.effect("runs a session picked for a project in that project's folder", () =>
		Effect.gen(function* () {
			const {spawns} = yield* open("claude-session", placeOf(demlik, "demlik"), [phoenix, demlik]);
			assert.lengthOf(spawns, 1);
			assert.strictEqual(spawns[0]?.folder, "/code/kamp-us/demlik");
		}),
	);

	it.effect("hands a home session no folder, so it runs where the shell runs", () =>
		Effect.gen(function* () {
			const {spawns} = yield* open("claude-session", HOME_PLACE, []);
			assert.lengthOf(spawns, 1);
			assert.isUndefined(spawns[0]?.folder);
		}),
	);

	it.effect("runs a project's own row in its project's folder", () =>
		Effect.gen(function* () {
			const {spawns} = yield* open(counterRow.id, undefined, [phoenix]);
			assert.strictEqual(spawns[0]?.folder, "/code/kamp-us/phoenix");
		}),
	);

	it.effect("refuses a session for a project that closed, and spawns nothing", () =>
		Effect.gen(function* () {
			const {msgs, spawns} = yield* open("claude-session", placeOf(demlik, "demlik"), [phoenix]);
			assert.lengthOf(spawns, 0);
			const view = msgs[0]?.type === "window.setView" ? msgs[0].view : null;
			assert.deepStrictEqual((view as {readonly refusal: unknown} | null)?.refusal, {
				_tag: "ProjectClosed",
				programId: "claude-session",
				project: "demlik",
			});
		}),
	);
});

describe("openFolder", () => {
	it("leaves a global row with no place to inherit the shell's folder", () => {
		assert.deepStrictEqual(
			openFolder("claude-session", undefined, [phoenix]),
			Result.succeed(Option.none()),
		);
	});

	it("finds a project by its key, not by its label", () => {
		assert.deepStrictEqual(
			openFolder("claude-session", placeOf(phoenix, "a label nobody keys on"), [phoenix]),
			Result.succeed(Option.some("/code/kamp-us/phoenix")),
		);
	});
});
