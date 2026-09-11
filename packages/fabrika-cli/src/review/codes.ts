/**
 * Exit allocations for review. See ./command.ts help for caller semantics.
 * Shared meanings stay imported so their values cannot drift.
 * Private allocations may overlap sibling groups; ../exit-code-alignment.ts checks against the base.
 */

import {
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";
import {OFF_VOCABULARY as TRIAGE_OFF_VOCABULARY} from "../triage/codes.ts";

export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/** An absent target is proven; a failed read must use PRECONDITION_UNKNOWN. */
export const ZERO_SCOPE = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const OFF_VOCABULARY = TRIAGE_OFF_VOCABULARY;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * Refused: the live head moved past the inspected `--sha`.
 *
 * The one code whose absence would let a verdict formed over one tree land on another — `bindToHead`'s
 * `Stale` arm applied at the write seam.
 */
export const STALE_HEAD = 12;
/**
 * Refused: the read completed and its scope is **provably incomplete**.
 *
 * Neither {@link PRECONDITION_UNKNOWN} (nothing failed) nor {@link ZERO_SCOPE} (scope exists; it just
 * was not all seen). Folding it into either renders a half-seen PR as a fully-judged one.
 */
export const INCOMPLETE_SCAN = 13;
export const ACL_DENIED = 14;
export const APPEND_ONLY = 15;
/**
 * Refused: the check runs at the head came from no workflow this repo authors.
 *
 * Neither {@link ZERO_SCOPE} (runs exist) nor {@link INCOMPLETE_SCAN} (all of them were seen). The
 * enumeration is complete and every run passed — and not one gate inspected the bytes, which is the
 * state that reads as safety while carrying none.
 */
export const NO_GATE_COVERAGE = 16;
/**
 * Refused: this post would retire a standing verdict of the OPPOSITE polarity at the same head, and
 * `--supersede` was not passed.
 *
 * Its own seat rather than {@link OFF_VOCABULARY}, because nothing about the arguments is off any
 * vocabulary — the write is legitimate and one flag away. What it costs is the record: a FAIL
 * overwritten by a PASS leaves nothing showing a gate ever blocked, and GitHub keeps no comment-body
 * history to recover it from. Nothing is written on this refusal.
 */
export const SUPERSEDES_VERDICT = 17;

/** Reserved for report file body sections, which no review verb performs. */
export const DELIBERATE_GAP = 4;
