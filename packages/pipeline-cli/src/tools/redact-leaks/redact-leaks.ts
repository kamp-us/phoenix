/**
 * `redact-leaks` core — the pure, IO-free transform that MASKS an already-detected
 * machine-local path leak while preserving its evidential shape (issue #3021).
 *
 * Detection is NOT re-implemented here: `redactLeaks` consumes `findCommentLeaks`
 * (../leak-guard/leak-guard.ts) as the single leak-pattern source (#3021 AC3) and only
 * decides how to MASK each hit — never a second, divergent pattern definition. The mask
 * keeps the class-root that documents "a machine-local path of this kind was here"
 * (`/var/folders`, `/Users`, `~`, …) and replaces the identifying remainder (user-hash,
 * temp filename, home segment) with `<redacted>`: REDACT, not strip — `@/var/folders/<redacted>`
 * still reads as evidence without exposing the user-hash. This is the transform triage's
 * Step-4 verbatim-preserve step runs over an original before nesting it in `<details>`, so
 * the no-local-paths leak invariant OUTRANKS verbatim-fidelity when the verbatim content is
 * itself a leak (#2393-class).
 */
import {findCommentLeaks} from "../leak-guard/leak-guard.ts";

const REDACTED = "<redacted>";

// [matched-prefix, class-root to keep], longest-prefix-first. The kept root is the
// non-identifying token that names the leak CLASS (the evidential shape); everything after
// it is the identifying remainder the mask drops. Keyed off the matcher's own matched
// string, so this is post-classification of findCommentLeaks output — NOT a second
// leak-pattern definition (detection stays single-sourced in leak-guard). A `~/.claude`
// tool dir and a `/vault/` mount are themselves identifying, so their kept root drops to
// `~` / `` (bare slash) — the shape survives, the identity does not.
const REDACTION_ROOTS: ReadonlyArray<readonly [prefix: string, keep: string]> = [
	["/var/folders", "/var/folders"],
	["/private/tmp", "/private/tmp"],
	["/private/var", "/private/var"],
	["/Users", "/Users"],
	["/tmp", "/tmp"],
	["~/.claude", "~"],
	["~/.usirin", "~"],
	["~/.agent", "~"],
	["~/code", "~"],
	["/vault", ""],
];

/** Mask one matched leak: keep its class-root, redact the identifying remainder, keep a trailing slash. */
const redactMatch = (matched: string): string => {
	const root = REDACTION_ROOTS.find(([prefix]) => matched.startsWith(prefix));
	const keep = root ? root[1] : "";
	const trailing = matched.endsWith("/") ? "/" : "";
	return `${keep}/${REDACTED}${trailing}`;
};

/**
 * Redact every machine-local path leak in `text`, preserving evidential shape. Leak-free
 * text is returned byte-for-byte unchanged (#3021 AC5). Longest matches are replaced first
 * so a shorter match can't corrupt a longer overlapping one (`/Users/foo` vs `/Users/foobar`).
 */
export const redactLeaks = (text: string): string => {
	if (!text) return text;
	const matches = [...new Set(findCommentLeaks(text).map((leak) => leak.matched))].sort(
		(a, b) => b.length - a.length,
	);
	let out = text;
	for (const matched of matches) {
		out = out.split(matched).join(redactMatch(matched));
	}
	return out;
};
