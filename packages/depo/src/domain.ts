/**
 * depo's client-side domain — the pure rules that turn a local file into the
 * exact upload the doorman (#1970, ADR 0144 decision 4) will accept: the
 * content-type → extension allowlist and the `<sha256>.<ext>` content address.
 *
 * This mirrors the doorman's own `domain.ts` (PNG/JPEG/WebP, sha256+ext) so the
 * key the client computes is the key the server stores — a mismatch would only
 * surface as a wasted round-trip. Kept PURE (no HTTP, no fs, no apiKey) so the
 * content-addressing unit-tests with no live worker (`.patterns/effect-testing.md`
 * unit tier).
 */
import * as Effect from "effect/Effect";
import {UnsupportedFile} from "./errors.ts";

/**
 * The content-type allowlist and its extension — the single source the client
 * shares with the doorman (ADR 0144 decision 4). depo holds exactly PNG / JPEG /
 * WebP. A file whose extension is not a key here is refused before any network
 * call, so the CLI never presents a payload the doorman would 415.
 */
export const ALLOWED_TYPES = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
} as const;

export type AllowedContentType = keyof typeof ALLOWED_TYPES;
export type AllowedExt = (typeof ALLOWED_TYPES)[AllowedContentType];

/** The public read host — a depo URL is `https://depo.kamp.us/<sha256>.<ext>`. */
export const PUBLIC_HOST = "https://depo.kamp.us";

/** File extension → the allowlisted content-type the doorman keys off of. */
const EXT_TO_TYPE: Record<string, AllowedContentType> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

/**
 * Resolve a filename's extension to an allowlisted content-type, or refuse. The
 * extension is lowercased so `SHOT.PNG` is accepted; a name with no extension, or
 * one outside the allowlist, fails `UnsupportedFile` — the client-side mirror of
 * the doorman's 415, caught before the upload.
 */
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

/** Lowercase hex of a SHA-256 digest — the content-address stem. */
export const sha256Hex = (bytes: Uint8Array): Effect.Effect<string> =>
	// `.slice()` yields a fresh `Uint8Array<ArrayBuffer>` (never a SharedArrayBuffer),
	// which is what `crypto.subtle.digest`'s `BufferSource` requires under strict TS.
	Effect.promise(() => crypto.subtle.digest("SHA-256", bytes.slice())).pipe(
		Effect.map((buf) =>
			Array.from(new Uint8Array(buf))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(""),
		),
	);

/** The object key for a body of a given type: `<sha256>.<ext>` — matches the doorman. */
export const contentAddressKey = (
	bytes: Uint8Array,
	contentType: AllowedContentType,
): Effect.Effect<string> =>
	sha256Hex(bytes).pipe(Effect.map((hex) => `${hex}.${ALLOWED_TYPES[contentType]}`));

/** The permanent public URL for a stored key: `https://depo.kamp.us/<key>`. */
export const publicUrl = (key: string): string => `${PUBLIC_HOST}/${key}`;
