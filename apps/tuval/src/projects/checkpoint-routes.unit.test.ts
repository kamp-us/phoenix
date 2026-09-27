import {assert, describe, it} from "@effect/vitest";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {memoryStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Context, Effect, Layer, Option} from "effect";
import {ProjectId} from "../project-id.ts";
import {checkpointRoutes, ownedView} from "./checkpoint-routes.ts";

const alpha = ProjectId.of("/work/alpha");

const store = () =>
	Effect.map(Layer.build(Checkpoints.layer(memoryStores())), (built) =>
		Context.get(built, Checkpoints),
	);

const target = (id: string, programId: string) => ({
	id: ProcessId.make(id),
	programId: ProgramId.make(programId),
	parentId: Option.none<ProcessId>(),
	version: "1.0.0",
});

const ids = (entries: ReadonlyArray<{readonly id: string}>) => entries.map((entry) => entry.id);

describe("checkpointRoutes", () => {
	it.effect(
		"checkpoints a project's process into its project's store and every other into the desk's",
		() =>
			Effect.gen(function* () {
				const desk = yield* store();
				const project = yield* store();
				const routes = checkpointRoutes(desk);
				yield* routes.route(alpha.key, project);
				yield* routes.checkpoints.open(target("shell", "shell"));
				yield* routes.checkpoints.open(target(alpha.scope("main"), alpha.scope("counter")));
				yield* routes.checkpoints.open(target("hub", "log"));
				assert.deepStrictEqual(ids(yield* desk.list), ["shell", "hub"]);
				assert.deepStrictEqual(ids(yield* project.list), [alpha.scope("main")]);
				assert.deepStrictEqual(ids(yield* routes.checkpoints.list), [
					"shell",
					"hub",
					alpha.scope("main"),
				]);
			}).pipe(Effect.scoped),
	);

	it.effect("sends an unrouted project's processes back to the desk's store", () =>
		Effect.gen(function* () {
			const desk = yield* store();
			const routes = checkpointRoutes(desk);
			yield* routes.route(alpha.key, yield* store());
			yield* routes.unroute(alpha.key);
			yield* routes.checkpoints.open(target(alpha.scope("main"), alpha.scope("counter")));
			assert.deepStrictEqual(ids(yield* desk.list), [alpha.scope("main")]);
		}).pipe(Effect.scoped),
	);

	it.effect("lists a store shared by the desk and a project once", () =>
		Effect.gen(function* () {
			const desk = yield* store();
			const routes = checkpointRoutes(desk);
			yield* routes.route(alpha.key, desk);
			yield* routes.checkpoints.open(target(alpha.scope("main"), alpha.scope("counter")));
			yield* routes.checkpoints.open(target("shell", "shell"));
			assert.deepStrictEqual(ids(yield* routes.checkpoints.list), [alpha.scope("main"), "shell"]);
			const owned = ownedView(desk, (entry) => alpha.owns(entry.programId));
			assert.deepStrictEqual(ids(yield* owned.list), [alpha.scope("main")]);
		}).pipe(Effect.scoped),
	);
});
