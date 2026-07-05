/**
 * Unit coverage for the `/api/health` readiness contract (ADR 0156). Drives the
 * real `healthApiLayer` router over `HttpRouter.toWebHandler` — no workerd, no
 * binding — with a stubbed `Flagship` client, and asserts the two typed outcomes:
 *
 *   - REACHABLE → 200 `{status:"ok", flagshipReachable:true}`;
 *   - a `FlagshipError` (unreachable/misconfigured binding) → 503
 *     `{status:"degraded", flagshipReachable:false}`, NOT an `orDie`→500.
 *
 * The 503 path is the ADR 0156 decision: flags fail-closed, so Flagship-unreachable
 * is a representable degraded-readiness state (not-ready-but-alive), not a handler
 * defect. The full black-box HTTP path is the CI-only integration tier
 * (`flagship-binding.test.ts`, ADR 0154); this is the local-runnable unit tier.
 */
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Flagship as CfFlagship} from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {describe, expect, it} from "vitest";
import {Flagship} from "../features/flagship/Flagship.ts";
import {healthApiLayer} from "./health.ts";

/**
 * The health read the handler exercises: the boolean probe evaluation, either
 * reachable (`succeed`) or a `FlagshipError` (unreachable/misconfigured binding).
 */
type ProbeRead = Effect.Effect<boolean, CfFlagship.FlagshipError>;

// `RuntimeContext` is the alchemy binding's intrinsic ambient requirement
// (discharged at worker scope in production, #507); the stub satisfies it here.
const runtimeContext: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const unexercised = (method: string) => () =>
	Effect.die(`Flagship.${method} not exercised in health.unit.test`);

/**
 * A `Flagship` stub whose `getBooleanValue` runs the supplied probe read; every
 * other method dies so an accidental call is loud (the `Flags.unit.test` idiom).
 */
const stubFlagship = (probe: ProbeRead): Layer.Layer<Flagship> =>
	Layer.succeed(Flagship)(
		Flagship.of({
			raw: Effect.die("Flagship.raw not exercised in health.unit.test"),
			get: unexercised("get"),
			getBooleanValue: () => probe,
			getStringValue: unexercised("getStringValue"),
			getNumberValue: unexercised("getNumberValue"),
			getObjectValue: unexercised("getObjectValue"),
			getBooleanDetails: unexercised("getBooleanDetails"),
			getStringDetails: unexercised("getStringDetails"),
			getNumberDetails: unexercised("getNumberDetails"),
			getObjectDetails: unexercised("getObjectDetails"),
		} as Flagship["Service"]),
	);

/**
 * Compile the real health router over a stub client into a `Request → Response`.
 * `provideRequest` discharges the group's per-request `Flagship` + `RuntimeContext`
 * markers (plain `Layer.provide` does not lift them — same seam as `app.ts`).
 */
const healthHandler = (probe: ProbeRead) =>
	HttpRouter.toWebHandler(
		healthApiLayer.pipe(
			HttpRouter.provideRequest(
				Layer.mergeAll(stubFlagship(probe), Layer.succeed(RuntimeContext)(runtimeContext)),
			),
		),
		{disableLogger: true},
	);

const GET = new Request("http://health.test/api/health");

describe("/api/health readiness contract (ADR 0156)", () => {
	it("a reachable Flagship binding returns 200 {status:ok, flagshipReachable:true}", async () => {
		const {handler, dispose} = healthHandler(Effect.succeed(false));
		try {
			const res = await handler(GET);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {status: string; flagshipReachable: boolean};
			expect(body.status).toBe("ok");
			expect(body.flagshipReachable).toBe(true);
		} finally {
			await dispose();
		}
	});

	it("a FlagshipError returns a typed 503 {status:degraded, flagshipReachable:false}", async () => {
		const {handler, dispose} = healthHandler(
			Effect.fail(new CfFlagship.FlagshipError({message: "binding unavailable", cause: undefined})),
		);
		try {
			const res = await handler(GET);
			// 503 (not-ready-but-alive), NOT the pre-ADR-0156 orDie→500 defect.
			expect(res.status).toBe(503);
			const body = (await res.json()) as {status: string; flagshipReachable: boolean};
			expect(body.status).toBe("degraded");
			expect(body.flagshipReachable).toBe(false);
		} finally {
			await dispose();
		}
	});
});
