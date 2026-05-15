/**
 * Relay global-id encoding helpers (task_1, phoenix-relay-idiom).
 *
 * Relay's `Node` interface requires every node to expose a globally-unique
 * `id: ID!`. Phoenix's underlying entities (Term, Post, Comment, Definition,
 * User, Profile) each have their own local id (slug for Term, ULID for the
 * rest, userId for Profile). The global id is the base64-encoded
 * `${typename}:${localId}` — kampus's precedent and the broadly-used Relay
 * convention.
 *
 * `decodeNodeId` is strict: it throws on malformed input. Mutation entry
 * points that need to be lenient (accept either a global or a raw local id
 * during the migration window) should use {@link extractLocalId} instead.
 */

const SEPARATOR = ":";

export type Typename = "Term" | "Post" | "Comment" | "Definition" | "User" | "Profile";

export interface DecodedNodeId {
	typename: Typename;
	id: string;
}

/**
 * Encode a `(typename, localId)` pair into a Relay-compatible global id.
 *
 * Throws on empty input — invalid states should be unrepresentable, not
 * round-tripped.
 */
export function encodeNodeId(typename: Typename, id: string): string {
	if (!typename || !id) {
		throw new Error(`encodeNodeId: typename and id are required (got ${typename!}, ${id!})`);
	}
	return base64Encode(`${typename}${SEPARATOR}${id}`);
}

/**
 * Decode a Relay global id into its `(typename, localId)` parts.
 *
 * Throws on malformed input (not base64, no separator, unknown typename).
 * Use {@link extractLocalId} when callers may legitimately pass a raw local
 * id during the schema migration.
 */
export function decodeNodeId(globalId: string): DecodedNodeId {
	if (!globalId) {
		throw new Error("decodeNodeId: globalId is required");
	}
	let decoded: string;
	try {
		decoded = base64Decode(globalId);
	} catch {
		throw new Error(`decodeNodeId: not a valid base64 string: ${globalId}`);
	}
	const sep = decoded.indexOf(SEPARATOR);
	if (sep <= 0 || sep === decoded.length - 1) {
		throw new Error(`decodeNodeId: missing separator in ${decoded}`);
	}
	const typename = decoded.slice(0, sep) as Typename;
	const id = decoded.slice(sep + 1);
	if (!isKnownTypename(typename)) {
		throw new Error(`decodeNodeId: unknown typename "${typename}"`);
	}
	return {typename, id};
}

/**
 * Lenient extractor used by mutation resolvers during the migration window.
 *
 * If `input` decodes as a valid global id of `expectedTypename`, returns the
 * inner local id. Otherwise returns `input` verbatim — the caller is
 * presumed to have sent the raw local id (the pre-migration shape that the
 * MVP frontend still uses for some surfaces).
 *
 * Once every page has migrated to fragment-based reads (tasks 2-6), this
 * helper can be replaced with strict {@link decodeNodeId} calls and removed.
 */
export function extractLocalId(input: string, expectedTypename: Typename): string {
	if (!input) return input;
	try {
		const {typename, id} = decodeNodeId(input);
		return typename === expectedTypename ? id : input;
	} catch {
		return input;
	}
}

const KNOWN_TYPENAMES: ReadonlySet<string> = new Set<Typename>([
	"Term",
	"Post",
	"Comment",
	"Definition",
	"User",
	"Profile",
]);

function isKnownTypename(value: string): value is Typename {
	return KNOWN_TYPENAMES.has(value);
}

/**
 * UTF-8-safe base64 encoder. `btoa` only accepts Latin-1; Turkish content
 * (term titles like "ölçü") would explode. We round-trip via `TextEncoder`.
 */
function base64Encode(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64Decode(input: string): string {
	const binary = atob(input);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}
