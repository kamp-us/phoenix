/**
 * Session rows for this window's tests. A colocated fixture module, outside the `*.unit.test.*`
 * glob, so the same three sessions back the pure row tests and the rendered ones and no assertion
 * is written against a copy that could drift from the other.
 *
 * Every row's `programId` and `backend` are deliberately different strings — `pi-session` against
 * `pi` — because they are the routing key and the display tag, and a fixture that spelled them the
 * same made a window routing on the tag look correct (epic #8070's tail review).
 */

import type {SessionRow} from "../../protocol/session-list.ts";

/** The clock every relative timestamp below is measured against: 2026-09-05T00:00:00Z. */
export const NOW = Date.UTC(2026, 8, 5);

const HOUR = 3_600_000;

/** Newest of the three, and the only one with every field filled. */
export const claudeSession: SessionRow = {
	sessionId: "c-1",
	lastModified: NOW - HOUR,
	programId: "claude-session",
	backend: "claude",
	firstPrompt: "Wire the session list window",
	folder: "/Users/founder/code/phoenix",
	branch: "epic/8070",
	messageCount: 42,
};

/** Middle by last modified, and the one that answers on a different folder and branch. */
export const piSession: SessionRow = {
	sessionId: "p-1",
	lastModified: NOW - 2 * HOUR,
	programId: "pi-session",
	backend: "pi",
	firstPrompt: "Draft the release note",
	folder: "/Users/founder/code/demlik",
	branch: "main",
	messageCount: 1,
};

/** Oldest, and the one whose store reported nothing but an id, a time and its own name. */
export const bareSession: SessionRow = {
	sessionId: "b-1",
	lastModified: NOW - 3 * HOUR,
	programId: "pi-session",
	backend: "pi",
};

/**
 * The session the operator named. Its title and its first prompt are deliberately different
 * strings, because that difference is the whole subject of #8135 — a fixture spelling them the same
 * would make a row still labelling by the prompt look correct.
 */
export const renamedSession: SessionRow = {
	sessionId: "r-1",
	lastModified: NOW - 4 * HOUR,
	programId: "claude-session",
	backend: "claude",
	title: "The picker rewrite",
	firstPrompt: "why is the picker empty",
	folder: "/Users/founder/code/phoenix",
};

/** The three, deliberately out of order: the window is what puts them newest-first. */
export const scrambled: ReadonlyArray<SessionRow> = [piSession, bareSession, claudeSession];
