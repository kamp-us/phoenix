/**
 * The Analytics Engine read seam — the IO shell the `report` runner resolves its AE query through.
 * ADR 0153 mandates reads go through the external AE SQL API (never from the worker); this is the
 * operator-side client for exactly that. It rides the SAME ambient `Credentials | HttpClient` the
 * cf-utils Flagship clients do (ADR 0045: one shared scoped operator credential), so `report`
 * inherits the keychain-first least-privilege credential seam and rolls no second token store.
 *
 * The transport is the CF AE SQL endpoint `POST {apiBaseUrl}/accounts/{id}/analytics_engine/sql`
 * with the raw SQL as the request body, returning a ClickHouse-style JSON envelope `{ data: [...] }`
 * (Cloudflare AE SQL API: https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).
 * The query itself is rendered sampling-correct upstream in `report.ts`; this seam only executes it.
 */

import {Credentials, type ResolvedCredentials} from "@distilled.cloud/cloudflare/Credentials";
import {Config, Context, Effect, Layer, Redacted} from "effect";
import * as Schema from "effect/Schema";
import type {HttpClient as HttpClientService} from "effect/unstable/http/HttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type {ReportRow} from "./report.ts";

const accountId = Config.string("CLOUDFLARE_ACCOUNT_ID");

/**
 * Any failure of an AE read, collapsed to one typed `E`-channel fault carrying a human reason —
 * a missing account id, an unresolvable credential, a transport error, a non-2xx from AE, or an
 * unparseable body all surface here rather than a raw stack trace (rendered by `NodeRuntime.runMain`).
 */
export class AnalyticsReadError extends Schema.TaggedErrorClass<AnalyticsReadError>()(
	"@kampus/anka-ops/AnalyticsReadError",
	{reason: Schema.String},
) {
	override get message(): string {
		return `analytics engine read failed: ${this.reason}`;
	}
}

/** The `Authorization` header for the resolved credential — Bearer for token/oauth, X-Auth for API-key. */
const authHeaders = (credentials: ResolvedCredentials): Record<string, string> => {
	switch (credentials.type) {
		case "apiToken":
			return {authorization: `Bearer ${Redacted.value(credentials.apiToken)}`};
		case "oauth":
			return {authorization: `Bearer ${Redacted.value(credentials.accessToken)}`};
		case "apiKey":
			return {
				"x-auth-email": credentials.email,
				"x-auth-key": Redacted.value(credentials.apiKey),
			};
	}
};

/** Coerce AE's JSON `{ data: [row, …] }` envelope into typed rows, or fail if the shape is wrong. */
const parseRows = (json: unknown): Effect.Effect<ReadonlyArray<ReportRow>, AnalyticsReadError> => {
	if (
		typeof json !== "object" ||
		json === null ||
		!Array.isArray((json as {data?: unknown}).data)
	) {
		return Effect.fail(
			new AnalyticsReadError({
				reason: "AE response missing a `data` array (unexpected SQL API shape)",
			}),
		);
	}
	const rows = (json as {data: ReadonlyArray<Record<string, unknown>>}).data.map((row) => {
		const out: ReportRow = {};
		for (const [key, value] of Object.entries(row)) {
			out[key] =
				value === null || typeof value === "string" || typeof value === "number"
					? value
					: String(value);
		}
		return out;
	});
	return Effect.succeed(rows);
};

/** `AnalyticsRead` — the injectable AE read seam. `query` runs one SQL read and returns decoded rows. */
export class AnalyticsRead extends Context.Service<
	AnalyticsRead,
	{
		readonly query: (sql: string) => Effect.Effect<ReadonlyArray<ReportRow>, AnalyticsReadError>;
	}
>()("@kampus/anka-ops/AnalyticsRead") {}

export const AnalyticsReadLive: Layer.Layer<AnalyticsRead, never, Credentials | HttpClientService> =
	Layer.effect(AnalyticsRead)(
		Effect.gen(function* () {
			// Capture the ambient credential + transport ONCE and re-provide into each read, so the
			// public `query` carries `R = never` — the same shape FlagshipReadLive uses (ADR 0045).
			const context = yield* Effect.context<Credentials | HttpClientService>();

			const query = (sql: string) =>
				Effect.gen(function* () {
					const acct = yield* accountId;
					const resolveCredentials = yield* Credentials;
					const credentials = yield* resolveCredentials;
					const url = `${credentials.apiBaseUrl}/accounts/${acct}/analytics_engine/sql`;
					const request = HttpClientRequest.post(url).pipe(
						HttpClientRequest.setHeaders(authHeaders(credentials)),
						HttpClientRequest.bodyText(sql, "text/plain"),
					);
					const response = yield* HttpClient.execute(request);
					if (response.status < 200 || response.status >= 300) {
						const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
						return yield* new AnalyticsReadError({
							reason: `AE SQL API returned HTTP ${response.status}: ${body.slice(0, 300)}`,
						});
					}
					const json = yield* response.json;
					return yield* parseRows(json);
				}).pipe(
					Effect.provide(context),
					Effect.catch((error) =>
						error instanceof AnalyticsReadError
							? Effect.fail(error)
							: Effect.fail(new AnalyticsReadError({reason: String(error)})),
					),
				);

			return {query};
		}),
	);
