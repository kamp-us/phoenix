// SPIKE (throwaway): `GET /api/spike/whoami` — the runtime-wiring probe (Q2).
//
// This route runs THROUGH the spike `ManagedRuntime` (built in `worker/index.ts`
// init from the static `AppLayer` + the real captured ambient context). Running
// any effect on that runtime forces the lazy `AppLayer` to BUILD on first use —
// which is what forces `DrizzleLive` (eager `connection.raw`) and `PasaportLive`
// (deferred better-auth `auth` yield) to construct. So a successful response to
// this route proves Q2: the static-graph + worker-init-ManagedRuntime
// architecture resolves REAL data (a real session lookup / DB-backed auth).
//
// Q1 (plan-phase safety) is decided by WHERE this runtime is forced. Because a
// `ManagedRuntime` builds its layer LAZILY on first use, and the ONLY thing that
// forces it is this route at REQUEST time, the graph never builds at `alchemy
// deploy` PLAN time. That makes Q1 "safe by lazy construction" — see the SPIKE
// block in `worker/index.ts` for the lazy-vs-eager toggle and what each proves.

import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {Pasaport} from "../features/pasaport/Pasaport.ts";
import type {AppLayer} from "./graph.ts";

/**
 * Build the `GET /api/spike/whoami` route from the spike `ManagedRuntime`.
 *
 * The runtime is built in worker init (where the real ambient `RuntimeContext` /
 * `Providers` / `WorkerEnvironment` / `D1ConnectionPolicy` are in scope), so this
 * route only needs to RUN effects on it. It reads the raw `Request`, runs a
 * `Pasaport.validateSession` through the spike graph, and returns JSON. The graph
 * builds on the FIRST request (lazy) — that first request is what proves Q2.
 *
 * @param runtime the `ManagedRuntime` made from `AppLayer` with ambient context
 *                discharged (so its `R` is `Stats | Pasaport | Drizzle`).
 */
export const makeSpikeRoute = (
	runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof AppLayer>, never>,
) =>
	HttpRouter.add(
		"GET",
		"/api/spike/whoami",
		Effect.gen(function* () {
			const raw = yield* Cloudflare.Request;
			// Run the probe on the spike runtime. This is a deliberate Effect→Promise
			// boundary into a SEPARATE ManagedRuntime (the whole point of the spike:
			// the static graph runs on its own runtime, not the worker's request
			// fiber). `runPromiseExit` so a build/resolve failure surfaces as JSON,
			// not a thrown 500 — making Q1/Q2 observable from a `curl`.
			const exit = yield* Effect.promise(() =>
				runtime.runPromiseExit(
					Effect.gen(function* () {
						const pasaport = yield* Pasaport;
						const session = yield* pasaport.validateSession(raw.headers);
						return {
							ok: true as const,
							hasSession: session !== null,
							user: session?.user?.id ?? null,
						};
					}),
				),
			);

			if (Exit.isSuccess(exit)) {
				return HttpServerResponse.jsonUnsafe(exit.value);
			}
			// The graph failed to build or the probe died — report it so a plan-phase
			// or runtime failure is legible from the response body.
			return HttpServerResponse.jsonUnsafe(
				{ok: false as const, error: String(exit.cause)},
				{status: 500},
			);
		}),
	);
