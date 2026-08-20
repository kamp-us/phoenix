/**
 * The doorman's one operation: authenticate, guard, content-address, write-once,
 * return the URL. This is the whole write path (ADR 0144 decision 4) — it composes
 * the auth seam (`ApiKeyVerifier`), the pure domain (`domain.ts`), and the storage
 * seam (`Storage`), so it unit-tests end to end with both seams substituted and no
 * live D1 / R2 (`.patterns/effect-testing.md`).
 *
 * The order of the steps below is load-bearing: it IS the acceptance contract.
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
		// Auth first — a bad key must never reach storage (nothing is written).
		yield* (yield* ApiKeyVerifier).verify(req.apiKey);

		const contentType = yield* allowedContentType(req.contentType);
		yield* withinSizeCap(req.body.byteLength);

		const key = yield* contentAddressKey(req.body, contentType);

		// Write-once. The key IS the sha256 of the bytes, so an existing key of the
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

		yield* storage.put(key, req.body, contentType);
		return {key, url: publicUrl(key), created: true} satisfies UploadResult;
	});
