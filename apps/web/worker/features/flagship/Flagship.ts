/**
 * `Flagship` service — the single seam holding the init-resolved Effect-native
 * `FlagshipClient` for the Cloudflare Flagship binding. Mirrors `db/Database.ts`: the binding
 * is resolved once per isolate and wrapped behind a Tag so the runtime never re-binds per
 * request.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {Context, Effect, Layer} from "effect";
import {Flagship as FlagshipApp} from "./resources.ts";

export class Flagship extends Context.Service<Flagship, Cloudflare.Flagship.ReadFlagsClient>()(
	"@kampus/Flagship",
) {}

// Resolved once and provided as a worker-level layer (the binding is stable for the
// isolate's life). No finalizer: a Cloudflare binding is not a resource the worker closes.
export const FlagshipLive = Layer.effect(
	Flagship,
	Effect.gen(function* () {
		return yield* Cloudflare.Flagship.ReadFlags(FlagshipApp);
	}),
);
