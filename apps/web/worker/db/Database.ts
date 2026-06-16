/**
 * `Database` service — the single seam holding the raw `D1Database` handle
 * (ADR 0040). Both `Drizzle` (via `createDrizzle`) and the better-auth adapter
 * derive from this same tag, so they are guaranteed to share one underlying
 * handle — the one-`sqlite` invariant is type-enforced by the layer graph, not
 * upheld by hand in tests.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {Context, Effect, Layer} from "effect";
import {PhoenixDb} from "./resources.ts";

/**
 * @example
 *   const raw = yield* Database;
 *   const db = createDrizzle(raw);
 */
export class Database extends Context.Service<Database, D1Database>()("@kampus/Database") {}

/**
 * Resolved once and provided as a worker-level layer (the binding is stable for
 * the isolate's life). No finalizer: a Cloudflare binding is not a resource the
 * worker owns or closes.
 */
export const DatabaseLive = Layer.effect(
	Database,
	Effect.gen(function* () {
		const connection = yield* Cloudflare.D1Connection.bind(PhoenixDb);
		return yield* connection.raw;
	}),
);
