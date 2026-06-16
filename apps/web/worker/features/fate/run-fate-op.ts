/**
 * `runFateOp` — the test mirror of `route.ts`'s `handleFate`: drive one fate
 * operation through the same native serving path (ADR 0043) over a per-op
 * `ManagedRuntime` built from the caller's worker layer, recording the publishes
 * the operation's `live.*` fanned out to. Returns `{status, result, published}`.
 *
 * The caller rebuilds the `Database` handle per `it` (`beforeEach`/`afterEach`),
 * so each case runs against its own in-memory D1 with no row leakage.
 */
import {
	FateInterpreter,
	type FateRequestContext,
	FateServer,
	type ProtocolOperation,
	ProtocolResponse,
} from "@kampus/fate-effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {fateConfig} from "./config.ts";
import {makeFateRuntime, type WorkerFateServices} from "./layers.ts";

/**
 * Typed off the package codecs (minus the `id` this harness stamps) so an
 * operation a suite can write IS one the protocol gate can decode, and the
 * harness cannot drift from the wire shape.
 */
export type FateOperationBody = Omit<Schema.Codec.Encoded<typeof ProtocolOperation>, "id">;

export type FateResult = Schema.Schema.Type<typeof ProtocolResponse>["results"][number];

export interface FateOpResult {
	readonly status: number;
	readonly result: FateResult;
	readonly published: ReadonlyArray<string>;
}

export interface FateOpAuth {
	readonly id: string;
	readonly name: string;
	readonly email: string;
}

/**
 * Run `operation` against `workerLayer` (a fully-resolved worker layer,
 * `Database`/`BetterAuth` already discharged) through the native interpreter.
 */
export async function runFateOp(
	workerLayer: Layer.Layer<WorkerFateServices>,
	operation: FateOperationBody,
	opts: {auth?: FateOpAuth} = {},
): Promise<FateOpResult> {
	const request = new Request("https://test.local/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({version: 1, operations: [{id: "1", ...operation}]}),
	});

	// The single runtime-build / `provide` boundary: the interpreter program
	// resolves `FateServer` from this runtime when run, so there is no second
	// `Effect.provide` (which would trip the `multipleEffectProvide` lint).
	// Disposed in `finally` — the harness has a shutdown point, so every op runs
	// cold (it does not exercise production's cross-request layer memoization).
	const {runtime} = makeFateRuntime(
		FateServer.layer(fateConfig).pipe(Layer.provideMerge(workerLayer)),
	);

	const published: Array<string> = [];

	const scheduled: Array<Promise<unknown>> = [];
	const livePublisher = livePublisherFor({
		publish: (topicKey) =>
			Effect.sync(() => {
				published.push(topicKey);
			}),
		waitUntil: (promise) => {
			scheduled.push(promise);
		},
	});

	const ctx: FateRequestContext = {
		currentUser: {user: opts.auth},
		livePublisher,
	};

	try {
		const res = await runtime.runPromise(FateInterpreter.handleRequest(request, ctx));
		const body = Schema.decodeUnknownSync(ProtocolResponse)(await res.json());
		const [result] = body.results;
		if (result === undefined) {
			throw new Error(`fate response carried no result: ${JSON.stringify(body)}`);
		}
		// Flush the detached `waitUntil` publishes so `published` is complete when
		// the caller reads it (a Node harness has no execution context to drain).
		await Promise.all(scheduled);
		return {status: res.status, result, published};
	} finally {
		await runtime.dispose();
	}
}
