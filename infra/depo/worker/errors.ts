/**
 * The doorman's tagged errors — one file for the whole write path (the
 * `.patterns/effect-errors.md` one-`errors.ts`-per-surface rule). Each is a plain
 * `Data.TaggedError`: the doorman is a standalone infra worker with no fate wire
 * codec in scope, so these carry no `FateWireCode` annotation — they map to HTTP
 * status in one place (`worker/index.ts`), not to a wire code.
 *
 * The split mirrors the pattern's domain/infra divide: `Unauthorized`,
 * `UnsupportedMediaType`, `PayloadTooLarge`, and `ContentAddressMismatch` are
 * domain refusals (the caller did something the doorman must reject → 4xx);
 * `StorageError` is infra (an R2 op failed below the domain → 500).
 */
import * as Data from "effect/Data";

/** No/invalid pasaport `apiKey` → 401. Stores nothing. */
export class Unauthorized extends Data.TaggedError("depo/Unauthorized")<{
	readonly reason: string;
}> {}

/** Content-type outside the PNG/JPEG/WebP allowlist → 415. */
export class UnsupportedMediaType extends Data.TaggedError("depo/UnsupportedMediaType")<{
	readonly contentType: string;
}> {}

/** Body over the size cap → 413. */
export class PayloadTooLarge extends Data.TaggedError("depo/PayloadTooLarge")<{
	readonly size: number;
	readonly cap: number;
}> {}

/**
 * A second PUT to an existing content-address key whose stored bytes differ from
 * the presented bytes → 409. Write-once immutability: a key never changes content.
 * (A byte-identical re-PUT is NOT this error — it is a benign idempotent success.)
 */
export class ContentAddressConflict extends Data.TaggedError("depo/ContentAddressConflict")<{
	readonly key: string;
}> {}

/** An R2 head/put failed below the domain → 500. Never leaks detail to the caller. */
export class StorageError extends Data.TaggedError("depo/StorageError")<{
	readonly op: "head" | "put";
	readonly cause: unknown;
}> {}
