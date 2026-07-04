/**
 * The doorman's one operation: authenticate, guard, content-address, write-once,
 * return the URL. This is the whole write path (ADR 0144 decision 4) — it composes
 * the auth seam (`ApiKeyVerifier`), the pure domain (`domain.ts`), and the storage
 * seam (`Storage`), so it unit-tests end to end with both seams substituted and no
 * live D1 / R2 (`.patterns/effect-testing.md`).
 *
 * Order is load-bearing and is the acceptance contract:
 *   1. verify the apiKey            → `Unauthorized` stores nothing
 *   2. allowlist the content-type   → `UnsupportedMediaType`
 *   3. size cap                     → `PayloadTooLarge`
 *   4. content-address              → the `<sha256>.<ext>` key
 *   5. write-once                   → existing key: byte-identical re-PUT is a
 *      benign success; differing bytes are refused `ContentAddressConflict`
 *   6. put + return the public URL
 */
import * as Effect from "effect/Effect";
import {allowedContentType, contentAddressKey, publicUrl, withinSizeCap} from "./domain.ts";
import {ContentAddressConflict} from "./errors.ts";
import {Storage} from "./storage.ts";
import {ApiKeyVerifier} from "./verifier.ts";

export interface UploadRequest {
	readonly apiKey: string | null;
	readonly contentType: string | null;
	readonly body: Uint8Array;
}

export interface UploadResult {
	readonly key: string;
	readonly url: string;
	/** `false` when the identical object already existed (idempotent re-PUT). */
	readonly created: boolean;
}

export const upload = (req: UploadRequest) =>
	Effect.gen(function* () {
		// 1. Auth first — a bad key must never reach storage (nothing is written).
		yield* (yield* ApiKeyVerifier).verify(req.apiKey);

		// 2–3. Domain guards on the raw upload before we touch its bytes further.
		const contentType = yield* allowedContentType(req.contentType);
		yield* withinSizeCap(req.body.byteLength);

		// 4. Content-address → the immutable key.
		const key = yield* contentAddressKey(req.body, contentType);

		// 5. Write-once. The key IS the sha256 of the bytes, so an existing key of the
		// same byte length is provably the same content — a benign idempotent re-PUT
		// (return created:false). A byte-length mismatch under an identical content-
		// address is a sha256 collision the doorman refuses rather than overwrites.
		const storage = yield* Storage;
		const existing = yield* storage.head(key);
		if (existing !== null) {
			if (existing.size !== req.body.byteLength) {
				return yield* new ContentAddressConflict({key});
			}
			return {key, url: publicUrl(key), created: false} satisfies UploadResult;
		}

		// 6. Store and return the permanent public URL.
		yield* storage.put(key, req.body, contentType);
		return {key, url: publicUrl(key), created: true} satisfies UploadResult;
	});
