/**
 * The `depo` CLI run boundary. This is the ONE place the real network layer is
 * provided, so `command.ts` stays transport-agnostic.
 *
 * `bin.ts` reaches this through a dynamic `import()` so an unlinked `catalog:` dep on
 * a fresh checkout surfaces as an actionable message, not a raw module-not-found.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect, Layer} from "effect";
import {Command} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {depoCommand} from "./command.ts";
import {DoormanClientLive} from "./live.ts";
import {VERSION} from "./version.ts";

const AppLayer = DoormanClientLive.pipe(
	Layer.provideMerge(Layer.merge(FetchHttpClient.layer, NodeServices.layer)),
);

depoCommand.pipe(Command.run({version: VERSION}), Effect.provide(AppLayer), NodeRuntime.runMain);
