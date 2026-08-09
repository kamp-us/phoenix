/**
 * The body digest: the first 12 lowercase hex of the SHA-256 of the epic's body, taken **after**
 * `normalizeForReadback`.
 *
 * `ledger open` prints it; `ledger draft` and `ledger write` require it as `--body-digest`, re-read the
 * live body, recompute, and refuse on `21` if it differs. The gap between deciding and writing is
 * closed by re-deciding, not by trusting.
 *
 * **Normalizing before hashing is a scar fix, not tidiness (#4599).** v1's splice round-trip compared
 * raw bytes while its only caller captured stdout through command substitution, which strips every
 * trailing newline before the PATCH — so what GitHub stored was never what was emitted and the
 * comparison was structurally unwinnable. Hashing the normalized form makes a trailing-newline round
 * trip a match instead of a false `21` on every clean run.
 *
 * The digest covers the body text and nothing else. Unlike the sibling gate's scope digest it is
 * deliberately *not* neutral to its own guarded write: `ledger write` is the run's last write, so
 * neutrality would buy nothing and would require excluding the very bytes being verified.
 */

import {createHash} from "node:crypto";
import {normalizeForReadback} from "../report/compose.ts";

export const DIGEST_LENGTH = 12;

/** 12 lowercase hex — the one shape `--body-digest` accepts, so a mistyped value refuses before any read. */
export const BODY_DIGEST_RE = /^[0-9a-f]{12}$/;

export const bodyDigest = (body: string): string =>
	createHash("sha256")
		.update(normalizeForReadback(body), "utf8")
		.digest("hex")
		.slice(0, DIGEST_LENGTH);
