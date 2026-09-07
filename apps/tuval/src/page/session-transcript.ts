/**
 * The page's half of one session's transcript: build the page call, read the reply, fold the pages
 * that land into the one history a window renders.
 *
 * It is the sibling of `./session-list.ts` and is shaped the same way, because it answers over the
 * same carriage: a `SpellCall` correlated on its own `CallId` (`../protocol/messages.ts`, ADR 0348
 * R1.3), decoded against the wire schema, refused rather than emptied when it cannot be read. The
 * two rules that make a refusal legible are here rather than at the surface — a reply for another
 * call is `null` and never an empty page, and a result the schema refuses is a refusal and never
 * a session that holds nothing.
 *
 * **The fold is the other half, and it is why this module is more than a codec.** A transcript is
 * read one page at a time from the newest end backwards, so the history on screen is every landed
 * page in one list and the cursor is whatever the newest-landed page said. Keeping that fold pure
 * is what lets the window's paging be proved without a socket: `landedPage` is a total function
 * from the state and one answer to the next state, and every rule the surface owes — older pages
 * go before the ones already held, an id already on screen is not repeated, a failed older page
 * leaves the history alone and the cursor where it was — is a case of it.
 */

import {Result, Schema} from "effect";
import type {WindowId} from "../protocol/ids.ts";
import {CallId} from "../protocol/ids.ts";
import type {SpellFailure, SpellReply} from "../protocol/messages.ts";
import {PROTOCOL_VERSION, SpellCall} from "../protocol/messages.ts";
import type {SessionTranscriptRequest, TranscriptItemWire} from "../protocol/session-transcript.ts";
import {SESSION_TRANSCRIPT_PATH, SessionTranscript} from "../protocol/session-transcript.ts";

/** One page landed and decoded: the items it carried and the cursor for the page older than it. */
export interface PagedTranscript {
	readonly _tag: "Paged";
	readonly page: SessionTranscript;
}

/** The call was answered and the answer was a refusal — no such session, a timed-out store walk. */
export interface RefusedTranscript {
	readonly _tag: "Refused";
	readonly failure: SpellFailure;
}

export type TranscriptLanding = PagedTranscript | RefusedTranscript;

/**
 * One page call. The id is minted here and the caller hands it back to `readSessionTranscript`,
 * which is the whole of the correlation. `window` rides along when the call came from one, exactly
 * as the list's does, so the kernel resolves the scope and the page names no process.
 */
export const sessionTranscriptCall = (
	request: SessionTranscriptRequest,
	window?: WindowId,
): SpellCall =>
	new SpellCall({
		type: "spell.call",
		version: PROTOCOL_VERSION,
		id: CallId.make(crypto.randomUUID()),
		path: [...SESSION_TRANSCRIPT_PATH],
		args: {
			programId: request.programId,
			sessionId: request.sessionId,
			cwd: request.cwd,
			before: request.before,
			limit: request.limit,
		},
		...(window === undefined ? {} : {window}),
	});

const refused = (failure: SpellFailure): RefusedTranscript => ({_tag: "Refused", failure});

/**
 * One reply as this call's answer, or `null` when it answers a different call. `null` is not an
 * empty page: a window holding a first read and an older read open at once reads every reply, and
 * "not mine" has to stay distinguishable from "mine, and there is nothing older".
 */
export const readSessionTranscript = (
	call: SpellCall,
	reply: SpellReply,
): TranscriptLanding | null => {
	if (reply.id !== call.id) return null;
	if (!reply.ok) return refused(reply.error);
	const decoded = Schema.decodeUnknownResult(SessionTranscript)(reply.result);
	if (Result.isFailure(decoded)) {
		return refused({
			tag: "tuval/BadSessionTranscript",
			message: "the kernel answered with a result this page cannot read as a transcript page",
			path: call.path,
		});
	}
	return {_tag: "Paged", page: decoded.success};
};

/**
 * Where the walk into older history has got to, once a first page is on screen. It is beside the
 * history rather than in place of it, because a failed older page must not take the transcript the
 * operator is already reading off the screen.
 */
export type OlderRead =
	| {readonly _tag: "Idle"}
	| {readonly _tag: "Reading"}
	| {readonly _tag: "Failed"; readonly failure: SpellFailure};

/** What a caller's read answered with. `null` is "the first read is out", never "there is nothing". */
export type TranscriptAnswer =
	| {readonly _tag: "Read"; readonly page: SessionTranscript; readonly older: OlderRead}
	| {readonly _tag: "Refused"; readonly failure: SpellFailure};

/**
 * Every landed page as one value. `landed` is its own field and not `items.length > 0`, because a
 * session that really holds nothing is a page that landed and an empty transcript that never
 * answered is not — folding them together is the one mistake this surface exists to refuse.
 */
export interface TranscriptPaging {
	/** Oldest first, every landed page folded together. */
	readonly items: ReadonlyArray<TranscriptItemWire>;
	/** The cursor the next older request must carry, or `null` at the beginning of history. */
	readonly next: string | null;
	readonly landed: boolean;
	/** The refusal that answered the *first* page, which is the whole view failing. */
	readonly refusal: SpellFailure | null;
	readonly older: OlderRead;
}

export const noPages: TranscriptPaging = {
	items: [],
	next: null,
	landed: false,
	refusal: null,
	older: {_tag: "Idle"},
};

/** An older page was asked for. Nothing else moves: the cursor advances only when a page lands. */
export const askedOlder = (paging: TranscriptPaging): TranscriptPaging => ({
	...paging,
	older: {_tag: "Reading"},
});

/**
 * Older items before the ones already held, with anything already on screen dropped. Ids are the
 * identity the store gives an item, so an overlapping page — a store that re-reads the cursor's own
 * row, a retry that answered twice — folds to the same transcript rather than a doubled one.
 */
const fold = (
	older: ReadonlyArray<TranscriptItemWire>,
	held: ReadonlyArray<TranscriptItemWire>,
): ReadonlyArray<TranscriptItemWire> => {
	const seen = new Set(held.map((item) => item.id));
	return [...older.filter((item) => !seen.has(item.id)), ...held];
};

/**
 * The state after one answer to the request that carried `before`. `before === null` is the first
 * page — the read that fills the window — and every other value is a walk further back, which is
 * why the two refusal arms differ: the first page failing is the view failing, and an older page
 * failing is a readable transcript that could not be extended.
 */
export const landedPage = (
	paging: TranscriptPaging,
	before: string | null,
	landing: TranscriptLanding,
): TranscriptPaging => {
	if (landing._tag === "Refused") {
		return before === null
			? {...paging, refusal: landing.failure, older: {_tag: "Idle"}}
			: {...paging, older: {_tag: "Failed", failure: landing.failure}};
	}
	return {
		items: before === null ? landing.page.items : fold(landing.page.items, paging.items),
		next: landing.page.next,
		landed: true,
		refusal: null,
		older: {_tag: "Idle"},
	};
};

/** The paging as the surface renders it: the first read out, refused, or a history with a cursor. */
export const pagedAnswer = (paging: TranscriptPaging): TranscriptAnswer | null => {
	if (paging.refusal !== null) return {_tag: "Refused", failure: paging.refusal};
	if (!paging.landed) return null;
	return {_tag: "Read", page: {items: paging.items, next: paging.next}, older: paging.older};
};
