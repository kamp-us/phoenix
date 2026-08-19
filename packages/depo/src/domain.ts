/**
 * depo's client-side domain — the content-type allowlist and the `<sha256>.<ext>`
 * content address. See ADR 0144.
 *
 * This mirrors the doorman's own `domain.ts`, so the key the client computes is the
 * key the server stores. Keep it PURE (no HTTP, no fs, no apiKey) — that is what lets
 * the content-addressing unit-test with no live worker.
 */
import * as Effect from "effect/Effect";
import {DigestError, UnsupportedFile} from "./errors.ts";

/** The single source the client shares with the doorman — keep the two in step. */
export const ALLOWED_TYPES = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
} as const;

export type AllowedContentType = keyof typeof ALLOWED_TYPES;
export type AllowedExt = (typeof ALLOWED_TYPES)[AllowedContentType];

export const PUBLIC_HOST = "https://depo.kamp.us";

const EXT_TO_TYPE: Record<string, AllowedContentType> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

export const contentTypeForFile = (
	filename: string,
): Effect.Effect<AllowedContentType, UnsupportedFile> => {
	const dot = filename.lastIndexOf(".");
	const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
	const type = EXT_TO_TYPE[ext];
	if (type === undefined) {
		return Effect.fail(new UnsupportedFile({filename, ext: ext || "<none>"}));
	}
	return Effect.succeed(type);
};

export const sha256Hex = (bytes: Uint8Array): Effect.Effect<string, DigestError> =>
	Effect.tryPromise({
		// `.slice()` yields a fresh `Uint8Array<ArrayBuffer>` (never a SharedArrayBuffer),
		// which is what `crypto.subtle.digest`'s `BufferSource` requires under strict TS.
		try: () => crypto.subtle.digest("SHA-256", bytes.slice()),
		catch: (cause) => new DigestError({cause}),
	}).pipe(
		Effect.map((buf) =>
			Array.from(new Uint8Array(buf))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(""),
		),
	);

export const contentAddressKey = (
	bytes: Uint8Array,
	contentType: AllowedContentType,
): Effect.Effect<string, DigestError> =>
	sha256Hex(bytes).pipe(Effect.map((hex) => `${hex}.${ALLOWED_TYPES[contentType]}`));

export const publicUrl = (key: string): string => `${PUBLIC_HOST}/${key}`;
