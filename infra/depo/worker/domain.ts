/**
 * The doorman's domain — the deliberately-small set of rules that make depo a
 * screenshot/image store and nothing else (ADR 0144: "dumb by mandate"). Kept
 * PURE and free of R2/HTTP/better-auth so every rule is unit-testable with no
 * engine (`.patterns/effect-testing.md` unit tier): the allowlist, the size cap,
 * and the content-address key derivation are domain objects, not scattered
 * request-handler branches (make invalid states unrepresentable).
 *
 * Write-once is NOT here: it is a fact about what R2 already holds, so it lives in
 * the upload orchestrator (`upload.ts`) against the storage seam. What IS here is
 * the *decision* the orchestrator needs — the content address a body maps to.
 */
import * as Effect from "effect/Effect";
import {DigestFailed, PayloadTooLarge, UnsupportedMediaType} from "./errors.ts";

/**
 * The content-type allowlist and its extension. depo holds exactly PNG / JPEG /
 * WebP (ADR 0144 decision 4). The map is the single source: the allowlist check
 * and the `<sha256>.<ext>` extension both read it, so a type can never be accepted
 * without a defined extension (an accepted-but-un-keyable state is unrepresentable).
 */
export const ALLOWED_TYPES = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
} as const;

export type AllowedContentType = keyof typeof ALLOWED_TYPES;
export type AllowedExt = (typeof ALLOWED_TYPES)[AllowedContentType];

/** ~10 MB (ADR 0144 decision 4). Bodies at or under the cap are accepted. */
export const SIZE_CAP_BYTES = 10 * 1024 * 1024;

/** The public read host — a depo URL is `https://depo.kamp.us/<sha256>.<ext>`. */
export const PUBLIC_HOST = "https://depo.kamp.us";

/**
 * Narrow a raw content-type header to an `AllowedContentType`, or refuse. The
 * header may carry parameters (`image/png; charset=binary`) or casing — normalize
 * to the bare, lowercased media type before matching so a well-formed request is
 * not rejected on a cosmetic difference.
 */
export const allowedContentType = (
	raw: string | null | undefined,
): Effect.Effect<AllowedContentType, UnsupportedMediaType> => {
	const [mediaType = ""] = (raw ?? "").split(";");
	const normalized = mediaType.trim().toLowerCase();
	if (normalized in ALLOWED_TYPES) {
		return Effect.succeed(normalized as AllowedContentType);
	}
	return Effect.fail(new UnsupportedMediaType({contentType: normalized || "<none>"}));
};

/** Refuse a body strictly over the cap; at-or-under passes. */
export const withinSizeCap = (size: number): Effect.Effect<number, PayloadTooLarge> =>
	size > SIZE_CAP_BYTES
		? Effect.fail(new PayloadTooLarge({size, cap: SIZE_CAP_BYTES}))
		: Effect.succeed(size);

/** Lowercase hex of a SHA-256 digest — the content-address stem. */
export const sha256Hex = (bytes: Uint8Array): Effect.Effect<string> =>
	Effect.tryPromise({
		try: () => crypto.subtle.digest("SHA-256", bytes),
		catch: (cause) => new DigestFailed({cause}),
	}).pipe(
		// The digest is a guaranteed-success content-address computation; a rejection is
		// a genuine defect, not a domain failure — keep the `E` channel `never`.
		Effect.orDie,
		Effect.map((buf) =>
			Array.from(new Uint8Array(buf))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(""),
		),
	);

/** The R2 object key for a body of a given type: `<sha256>.<ext>`. */
export const contentAddressKey = (
	bytes: Uint8Array,
	contentType: AllowedContentType,
): Effect.Effect<string> =>
	sha256Hex(bytes).pipe(Effect.map((hex) => `${hex}.${ALLOWED_TYPES[contentType]}`));

/** The permanent public URL for a stored key: `https://depo.kamp.us/<key>`. */
export const publicUrl = (key: string): string => `${PUBLIC_HOST}/${key}`;
