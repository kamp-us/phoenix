/**
 * The digest a decision ruling binds: the first 12 lowercase hex of the SHA-256 of the issue body
 * that was ruled on.
 *
 * **The body is the whole scope, and that is why nothing is excluded from it.** A plan approval has
 * to exclude the two labels its own flip writes, or the digest would be invalidated by the very
 * write it guards (`../plan/digest.ts`). A ruling has no such problem: the flip it gates writes
 * *labels*, and labels are not in the body. So the serialization is the body itself, and a body
 * rewritten under a standing ruling stops matching — which is the property the whole marker exists
 * for.
 *
 * The canonicalization is the one thing this file decides, and it is deliberately narrow: line
 * endings and trailing whitespace only. GitHub's own clients round-trip a body through CRLF, so a
 * digest sensitive to that would read a founder's ruling as stale because somebody opened the issue
 * in a different editor. Everything a person can actually mean by editing the issue — a word, a
 * criterion, a whole section — still moves the digest.
 */

import {createHash} from "node:crypto";

export const DIGEST_LENGTH = 12;

/** 12 lowercase hex — the shape the wire marker brands, so a mistyped value refuses before any read. */
export const DIGEST_RE = /^[0-9a-f]{12}$/;

/** Line endings normalized, trailing whitespace dropped, leading and trailing blank lines trimmed. */
export const canonicalBody = (body: string): string =>
	body
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.trim();

export const bodyDigest = (body: string): string =>
	createHash("sha256").update(canonicalBody(body), "utf8").digest("hex").slice(0, DIGEST_LENGTH);
