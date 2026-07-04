/**
 * The depo doorman — the write path for depo (ADR 0144 decision 4), a standalone
 * alchemy-effect worker (ADRs 0026–0031) on its own stack (`doorman.ts`), separate
 * from `apps/web` (ADR 0057). DUMB BY MANDATE: it authenticates, guards, content-
 * addresses, writes once, and returns the URL — no transforms, no gallery, no read
 * path (reads stay zero-compute off R2 at `depo.kamp.us`, #1969).
 *
 * The single surface is `PUT /` on `up.depo.kamp.us`: raw image bytes in, a
 * `{key,url}` JSON out. The domain rules and both seams (auth, storage) live in
 * their own modules so this file is thin — bind resources, wire the seams, map the
 * one operation's typed failures to HTTP status.
 */

import {RuntimeContext} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {type PayloadTooLarge, StorageError, type UnsupportedMediaType} from "./errors.ts";
import {DepoBucket, PasaportDb} from "./resources.ts";
import {Storage} from "./storage.ts";
import {upload} from "./upload.ts";
import {ApiKeyVerifier, makeApiKeyVerifier} from "./verifier.ts";

/** The apiKey is presented as an `Authorization: Bearer <key>` or `x-api-key` header. */
const apiKeyOf = (headers: Headers): string | null =>
	headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;

/** Map a doorman failure to its HTTP response. Domain refusals are 4xx; infra is 500. */
const toResponse = (error: {readonly _tag: string}): HttpServerResponse.HttpServerResponse => {
	switch (error._tag) {
		case "depo/Unauthorized":
			return HttpServerResponse.text("unauthorized", {status: 401});
		case "depo/UnsupportedMediaType":
			return HttpServerResponse.text(
				`unsupported media type: ${(error as UnsupportedMediaType).contentType}`,
				{status: 415},
			);
		case "depo/PayloadTooLarge":
			return HttpServerResponse.text(
				`payload too large (cap ${(error as PayloadTooLarge).cap} bytes)`,
				{status: 413},
			);
		case "depo/ContentAddressConflict":
			return HttpServerResponse.text("content-address conflict", {status: 409});
		default:
			// StorageError and anything unexpected: never leak detail.
			return HttpServerResponse.text("internal error", {status: 500});
	}
};

export class Doorman extends Cloudflare.Worker<
	Doorman,
	// biome-ignore lint/complexity/noBannedTypes: alchemy's empty-RPC-shape sentinel
	{}
>()("depo-doorman") {}

export default Doorman.make(
	{
		main: import.meta.filename,
		// better-auth's apiKey verify (drizzle adapter) needs Node built-ins.
		compatibility: {flags: ["nodejs_compat"]},
		observability: {enabled: true},
		// The write endpoint. depo's read domain is `depo.kamp.us` (owned by the read
		// stack); the doorman is the separate write host.
		domain: "up.depo.kamp.us",
		env: {
			// The session-signing secret, shared with pasaport so any secret-dependent
			// apiKey path matches its issuer. `secret_text` (a redacted value).
			BETTER_AUTH_SECRET: Redacted.make(process.env.BETTER_AUTH_SECRET ?? ""),
		},
	},
	Effect.gen(function* () {
		// ── INIT PHASE ── bind the two adopted resources once per isolate.
		const rwBucket = yield* Cloudflare.R2.ReadWriteBucket(DepoBucket);
		const rawDb = yield* (yield* Cloudflare.D1.QueryDatabase(PasaportDb)).raw;
		// The ambient RuntimeContext R2 ops carry in their `R` (ADR 0124), resolved once.
		const runtimeContext = yield* RuntimeContext;
		const secret = yield* Config.redacted("BETTER_AUTH_SECRET");

		// Wire the storage seam over the bound bucket. `head`/`put` carry RuntimeContext
		// in their `R`; discharge it here so the seam's methods are `R = never`.
		const StorageLive = Layer.succeed(Storage)(
			Storage.of({
				head: (key) =>
					rwBucket.head(key).pipe(
						Effect.map((obj) => (obj === null ? null : {size: obj.size})),
						Effect.provideService(RuntimeContext, runtimeContext),
						Effect.mapError((cause) => new StorageError({op: "head", cause})),
					),
				put: (key, bytes, contentType) =>
					rwBucket
						.put(key, bytes, {
							httpMetadata: {contentType},
						})
						.pipe(
							Effect.asVoid,
							Effect.provideService(RuntimeContext, runtimeContext),
							Effect.mapError((cause) => new StorageError({op: "put", cause})),
						),
			}),
		);

		const VerifierLive = Layer.succeed(ApiKeyVerifier)(
			ApiKeyVerifier.of(makeApiKeyVerifier(rawDb, Redacted.value(secret))),
		);

		// ── RUNTIME PHASE ── the one route: PUT / (write-once upload).
		const routes = HttpRouter.add(
			"PUT",
			"/",
			Effect.gen(function* () {
				const raw = yield* Cloudflare.Request;
				const body = new Uint8Array(yield* Effect.promise(() => raw.arrayBuffer()));
				return yield* upload({
					apiKey: apiKeyOf(raw.headers),
					contentType: raw.headers.get("content-type"),
					body,
				}).pipe(
					Effect.map((result) =>
						// `text` returns a plain response (unlike `json`, an Effect); set the
						// JSON content type explicitly. 201 on first write, 200 on a benign
						// idempotent re-PUT.
						HttpServerResponse.text(JSON.stringify({key: result.key, url: result.url}), {
							status: result.created ? 201 : 200,
							contentType: "application/json",
						}),
					),
					// Every typed failure maps to its HTTP status here (the one place).
					Effect.catch((error) => Effect.succeed(toResponse(error))),
				);
			}),
		).pipe(Layer.provide([StorageLive, VerifierLive]));

		return {fetch: routes.pipe(HttpRouter.toHttpEffect)};
	}).pipe(
		Effect.provide(
			Layer.mergeAll(Cloudflare.R2.ReadWriteBucketBinding, Cloudflare.D1.QueryDatabaseBinding),
		),
	),
);
