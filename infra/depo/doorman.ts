/**
 * The depo doorman stack — deploys the write-path upload worker (ADR 0144 decision
 * 4). Separate stack from the read path (`depo.ts`) and from `apps/web` (ADR 0057):
 * the doorman is decoupled infra with its own deploy cycle, reusing the account-
 * global alchemy state store + the CI Cloudflare secrets — no second bootstrap.
 *
 * Yielding the `Doorman` worker Tag deploys it; the worker's own init phase (its
 * binding calls: the `depo` R2 bucket for writes, `phoenix_db` D1 for apiKey
 * verification, both ADOPTED — `worker/resources.ts`) tells alchemy which bindings
 * to send. The stack provides the worker's `.make()` implementation Layer (its
 * `export default`) so the Tag resolves (ADR 0028), then clears the ambient
 * `RuntimeContext` requirement the R2/verify seams leak (the ADR 0124 phantom-Req
 * gap; alchemy really supplies it at runtime).
 *
 * Deploy is scripted/manual (`pnpm --filter @kampus/depo-infra deploy:doorman`),
 * NOT the `apps/` CI matrix — wiring it into CI deploy touches `.github/**`
 * (control-plane) and is a separate follow-up, out of scope (same as #1969).
 */
import * as Alchemy from "alchemy";
import {RuntimeContext} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import DoormanLive, {Doorman} from "./worker/index.ts";

export default Alchemy.Stack(
	"depo-doorman",
	{
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		const worker = yield* Doorman;
		return {url: worker.url};
	}).pipe(Effect.provide(DoormanLive), Effect.provide(RuntimeContext.phantom)),
);
