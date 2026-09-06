/**
 * What picking a session row does, as data: which window it lands in, what the surface reads while
 * it is read-only, and what the first send has to create (epic #8070, rulings 2 and 5).
 *
 * Pure, so the two rules that matter are provable without a DOM. **Opening writes nothing** — an
 * open produces a read request and never a spawn, so no branch here can start a process or a
 * session. **The first send creates the process and the second one does not** — `send` carries the
 * phase, so the transition happens once by construction rather than by a caller remembering to
 * check a flag.
 *
 * A row with no folder is a refusal rather than a request with a guessed `cwd`: a backend finds a
 * session by folder and id together, and inventing one would open somebody else's session or none.
 */

import type {SessionRow} from "../../protocol/session-list.ts";

/** Where an activated row lands. Plain activation is inline; Cmd+Enter is the other window. */
export type OpenTarget = "inline" | "new-window";

/** What the window is showing: the list, or one session's transcript in place of it. */
export type SessionListView =
	| {readonly kind: "list"}
	| {readonly kind: "session"; readonly session: SessionRow};

export const listView: SessionListView = {kind: "list"};

export const sessionView = (session: SessionRow): SessionListView => ({kind: "session", session});

/** One page read: which session, from which backend, and how far back. */
export interface TranscriptRead {
	readonly backend: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly before: string | null;
	readonly limit: number;
}

/** Why a row cannot be opened at all. The one case: the store filed it under no folder. */
export interface OpenRefused {
	readonly _tag: "OpenRefused";
	readonly reason: "no-folder";
	readonly session: SessionRow;
}

export type OpenRequest = {readonly _tag: "Read"; readonly read: TranscriptRead} | OpenRefused;

/** How many items one page of a read-only transcript asks for. */
export const TRANSCRIPT_PAGE_SIZE = 50;

/**
 * The read that shows a row, or the refusal that says why it cannot be shown. `before` is the
 * oldest item the caller already holds, so walking further back is the same call with a cursor —
 * the port's own paging rather than one fetch of the whole transcript (ruling 5).
 */
export const openRead = (
	session: SessionRow,
	before: string | null = null,
	limit: number = TRANSCRIPT_PAGE_SIZE,
): OpenRequest =>
	session.folder === undefined
		? {_tag: "OpenRefused", reason: "no-folder", session}
		: {
				_tag: "Read",
				read: {
					backend: session.backend,
					sessionId: session.sessionId,
					cwd: session.folder,
					before,
					limit,
				},
			};

/** Read-only until the operator sends; live once the send created the process. */
export type OpenPhase = "reading" | "live";

/**
 * The spawn a send needs: open this backend's program in this window, resuming this session. The
 * three fields are the program to spawn and the `{cwd, resume}` it comes up on, and there is no
 * fourth — the epic's rabbit-holes rule out a program-arguments system.
 */
export interface SessionSpawn {
	readonly programId: string;
	readonly cwd: string;
	readonly resume: string;
}

export interface SendPlan {
	readonly phase: OpenPhase;
	/** The spawn this send needs, or `null` because the process the last send created is still there. */
	readonly spawn: SessionSpawn | null;
	/** The refusal that stopped the send, when a row with no folder got this far. */
	readonly refused: OpenRefused | null;
}

/**
 * What one send does. From `reading` it asks for exactly one spawn and moves to `live`; from `live`
 * it asks for none, because the process that send created is the one this window is bound to now.
 */
export const send = (phase: OpenPhase, session: SessionRow): SendPlan => {
	if (phase === "live") return {phase: "live", spawn: null, refused: null};
	if (session.folder === undefined) {
		return {
			phase: "reading",
			spawn: null,
			refused: {_tag: "OpenRefused", reason: "no-folder", session},
		};
	}
	return {
		phase: "live",
		spawn: {programId: session.backend, cwd: session.folder, resume: session.sessionId},
		refused: null,
	};
};
