/**
 * `Flagship` service — the single seam holding the init-resolved
 * Effect-native `FlagshipClient` for the Cloudflare Flagship binding (epic #488).
 *
 * Mirrors `db/Database.ts`: the binding is resolved once per isolate via
 * `Cloudflare.FlagshipApp.bind(Flagship)` (the init-phase alias, like
 * `Cloudflare.D1Connection.bind(PhoenixDb)`) and wrapped behind a Tag so the
 * runtime never re-binds per request. This child wires the binding only; the flag
 * Effect service that consumes the client lands in #508.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {Context, Effect, Layer} from "effect";
import {Flagship as FlagshipApp} from "../../db/resources.ts";

export class Flagship extends Context.Service<Flagship, Cloudflare.FlagshipClient>()(
	"@kampus/Flagship",
) {}

/**
 * Resolved once and provided as a worker-level layer (the binding is stable for
 * the isolate's life). No finalizer: a Cloudflare binding is not a resource the
 * worker owns or closes.
 */
export const FlagshipLive = Layer.effect(
	Flagship,
	Effect.gen(function* () {
		return yield* Cloudflare.FlagshipApp.bind(FlagshipApp);
	}),
);
