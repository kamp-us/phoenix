/**
 * `@kampus/read-guard` — the harness fix for the largest mined subagent error
 * class (~151: read-before-edit + modified-since-read; epic #737, child #740).
 *
 * The core (`decide`) is a pure, IO-free decision: given a target path, the
 * session read-set, and the file's current mtime, it returns `inject-read` (never
 * read, or stale read) or `no-op` (a current read on record). `transcript.ts`
 * reconstructs the read-set from the session transcript; `bin.ts` wires the two to
 * the Claude Code PreToolUse envelope, blocking an Edit/Write of an unread/stale
 * target with a precise `Read <path> first` instruction instead of letting the
 * harness's raw refusal burn a turn.
 */
export {
	blockReason,
	type Decision,
	decide,
	type ReadSet,
	type RecordedRead,
	type StaleReason,
} from "./read-guard.ts";
export {parseReadSet} from "./transcript.ts";
