/**
 * The depo store/fetch boundary for golden bytes (ADR 0183 store + resolve). The
 * golden BYTES are content-addressed in depo (ADR 0144), so:
 *
 *   - `storeGolden` PUTs the blessed PNG through the depo client (`@kampus/depo`)
 *     and returns `{ sha256, url }` — the sha256 the git pointer records and the
 *     immutable `depo.kamp.us/<sha256>.png` URL. It reuses depo's client so there
 *     is ONE store path, never a second uploader.
 *   - `fetchGoldenBytes` GETs bytes back from a resolved depo URL, and
 *     `resolveGoldenBytes` is the consumer seam that ties the git pointer to the
 *     bytes: pointer → depo URL → bytes (or `null` for an unblessed surface).
 *
 * The diff then compares these fetched golden bytes against the candidate render
 * (`golden-diff.ts`). Impure by design (network + depo); the decision logic stays
 * in the pure cores.
 */
import {
	type DigestError,
	type DoormanClient,
	type PayloadTooLarge,
	publicUrl,
	putBytes,
	sha256Hex,
	type Unauthorized,
	type UnsupportedMediaType,
	type UploadFailed,
} from "@kampus/depo";
import {Effect, Schema} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type {GoldenPointer} from "./golden-pointer.ts";
import {resolveGoldenEntry} from "./golden-pointer.ts";

/**
 * Resolve a surface-id to its current golden's immutable depo URL, or `null` when
 * the surface is unblessed. Built through depo's own `publicUrl` so there is ONE
 * notion of a depo address across the repo (never a second literal host) — the
 * bytes are PNG, so the key is `<sha256>.png` (ADR 0144 §3). Lives on the depo
 * boundary (not the pure pointer core) so the pointer stays dependency-free.
 */
export const resolveGoldenUrl = (pointer: GoldenPointer, surfaceId: string): string | null => {
	const entry = resolveGoldenEntry(pointer, surfaceId);
	return entry === null ? null : publicUrl(`${entry.sha256}.png`);
};

/** A stored golden: the content-address stem for the pointer + its immutable depo URL. */
export interface StoredGolden {
	readonly sha256: string;
	readonly url: string;
}

/**
 * PUT a blessed golden PNG to depo and return its `{ sha256, url }`. A
 * `ContentAddressConflict` (these exact bytes are already stored — depo is
 * write-once, ADR 0144 §4) is an idempotent success, not a failure: the immutable
 * URL is already valid, so re-storing an unchanged golden is a no-op win. Every
 * other depo failure propagates for the caller to surface.
 */
export const storeGolden = (input: {
	readonly apiKey: string;
	readonly pngBytes: Uint8Array;
}): Effect.Effect<
	StoredGolden,
	// putBytes' error union minus ContentAddressConflict — which storeGolden absorbs as an
	// idempotent success (content-addressed write-once ⇒ already-stored is already-valid).
	DigestError | Unauthorized | UnsupportedMediaType | PayloadTooLarge | UploadFailed,
	DoormanClient
> =>
	Effect.gen(function* () {
		const sha256 = yield* sha256Hex(input.pngBytes);
		const url = yield* putBytes({
			apiKey: input.apiKey,
			contentType: "image/png",
			body: input.pngBytes,
		}).pipe(
			Effect.catchTag("depo/ContentAddressConflict", () =>
				Effect.succeed(publicUrl(`${sha256}.png`)),
			),
		);
		return {sha256, url};
	});

/** A depo GET failure — a non-2xx status, a transport fault, or a body-read fault. */
export class GoldenFetchError extends Schema.TaggedErrorClass<GoldenFetchError>()(
	"@kampus/design-capture/GoldenFetchError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

/**
 * GET the golden bytes from a resolved depo URL. depo reads are zero-compute
 * public-read (ADR 0144 §3), so this is a plain authenticated-nothing GET; any
 * non-2xx or transport fault is a `GoldenFetchError` (the URL a pointer names must
 * be fetchable, so a miss is loud, never a silent empty image).
 */
export const fetchGoldenBytes = (
	url: string,
): Effect.Effect<Uint8Array, GoldenFetchError, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const response = yield* HttpClient.execute(HttpClientRequest.get(url)).pipe(
			Effect.mapError(
				(cause) => new GoldenFetchError({message: `depo GET ${url} transport failed`, cause}),
			),
		);
		if (response.status < 200 || response.status >= 300) {
			return yield* new GoldenFetchError({
				message: `depo GET ${url} returned HTTP ${response.status}`,
			});
		}
		const buffer = yield* response.arrayBuffer.pipe(
			Effect.mapError(
				(cause) => new GoldenFetchError({message: `depo GET ${url} body read failed`, cause}),
			),
		);
		return new Uint8Array(buffer);
	});

/**
 * The consumer seam both `write-code` (generation self-check) and `review-design`
 * (blocking gate) resolve a golden through, so there is ONE notion of "the golden
 * for this surface": pointer → depo URL → bytes. An unblessed surface resolves to
 * `null` (no golden yet — the caller treats it as "nothing to compare against"),
 * never an error.
 */
export const resolveGoldenBytes = (
	pointer: GoldenPointer,
	surfaceId: string,
): Effect.Effect<Uint8Array | null, GoldenFetchError, HttpClient.HttpClient> => {
	const url = resolveGoldenUrl(pointer, surfaceId);
	return url === null ? Effect.succeed(null) : fetchGoldenBytes(url);
};
