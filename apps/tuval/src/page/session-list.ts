/**
 * The page's half of the session list: build the call, read the reply, hand the rows on.
 *
 * The page asks for the list the only way it may ask for anything — a `SpellCall`, correlated on
 * its own `CallId` (`../protocol/messages.ts`, ADR 0348 R1.3), carried by the transport's one spell
 * frame pair. No frame of its own is added for it: the kernel's other lists reach a page as
 * push-on-change frames because the kernel already holds them, and this one is a disk walk answered
 * on demand.
 *
 * `readSessionList` is where a reply becomes rows. It reads the correlation first, because a reply
 * carrying another call's id is not this call's answer and folding it in would show one window
 * another's list; then it decodes against the wire schema, so a malformed result is a refusal the
 * window can render rather than rows it cannot trust.
 *
 * Nothing here touches how the picker's `Program` and `Process` entries are built
 * (`./AttachedDesk.tsx`): the session list is a third thing beside them.
 */

import {Result, Schema} from "effect";
import type {WindowId} from "../protocol/ids.ts";
import {CallId} from "../protocol/ids.ts";
import type {SpellFailure, SpellReply} from "../protocol/messages.ts";
import {PROTOCOL_VERSION, SpellCall} from "../protocol/messages.ts";
import type {SessionRow, UnreadableBackend} from "../protocol/session-list.ts";
import {
	SESSION_LIST_CALL_PATH,
	SESSION_LIST_DEADLINE_MILLIS,
	SESSION_LIST_TIMED_OUT_TAG,
	SessionList,
} from "../protocol/session-list.ts";

/** The rows a window is handed, and the backends that could not be read beside them. */
export interface ListedSessions {
	readonly _tag: "Listed";
	readonly sessions: ReadonlyArray<SessionRow>;
	readonly unreadable: ReadonlyArray<UnreadableBackend>;
}

/** The call was answered and the answer was a refusal — a timed-out walk, an unregistered row. */
export interface RefusedSessions {
	readonly _tag: "Refused";
	readonly failure: SpellFailure;
}

/**
 * The call is out and no reply has landed. It carries the clock a window renders against — when the
 * call left and the bound it runs against — because "still reading" with nothing beside it is the
 * one unchanging sentence #8280 exists to remove.
 */
export interface ReadingSessions {
	readonly _tag: "Reading";
	readonly startedAt: number;
	readonly deadlineMillis: number;
}

/**
 * The deadline won. Its own state rather than a refusal with a tag to read, because a timed-out
 * read is neither an empty store nor an unreadable backend, and a surface that folds it into either
 * of those says something about the store that nobody measured.
 */
export interface TimedOutSessions {
	readonly _tag: "TimedOut";
	readonly deadlineMillis: number;
}

export type SessionListAnswer = ListedSessions | RefusedSessions;

/** Every state the read can end in. `Reading` is not among them, which is the point of the split. */
export type SettledSessions = ListedSessions | RefusedSessions | TimedOutSessions;

/** What a window renders: the read, at whatever point it has reached. */
export type SessionListStatus = ReadingSessions | SettledSessions;

export const reading = (
	startedAt: number,
	deadlineMillis: number = SESSION_LIST_DEADLINE_MILLIS,
): ReadingSessions => ({_tag: "Reading", startedAt, deadlineMillis});

/**
 * One landed answer as the state it really is. A refusal carrying the kernel's own timeout tag is
 * the deadline having fired, so it becomes `TimedOut` here rather than at every surface that
 * renders a refusal — one reading of that tag, in the module that already owns the wire.
 */
export const settled = (
	answer: SessionListAnswer,
	deadlineMillis: number = SESSION_LIST_DEADLINE_MILLIS,
): SettledSessions =>
	answer._tag === "Refused" && answer.failure.tag === SESSION_LIST_TIMED_OUT_TAG
		? {_tag: "TimedOut", deadlineMillis}
		: answer;

/**
 * The status at a clock. A read whose deadline has passed with no reply is timed out whatever the
 * transport does next: the kernel bounds the walk at the same number, so a surface still saying
 * "reading" past it is waiting on an answer that is not coming.
 */
export const atClock = (status: SessionListStatus, now: number): SessionListStatus =>
	status._tag === "Reading" && now - status.startedAt >= status.deadlineMillis
		? {_tag: "TimedOut", deadlineMillis: status.deadlineMillis}
		: status;

/** How long the read has been out, never past its own bound and never negative. */
export const elapsedMillis = (status: ReadingSessions, now: number): number =>
	Math.min(Math.max(now - status.startedAt, 0), status.deadlineMillis);

/**
 * One call for the whole list. The id is minted here — the caller keeps it and hands it back to
 * `readSessionList`, which is the whole of the correlation. `window` rides along when the call came
 * from one, so the kernel resolves the scope; the page never names a process.
 */
export const sessionListCall = (window?: WindowId): SpellCall =>
	new SpellCall({
		type: "spell.call",
		version: PROTOCOL_VERSION,
		id: CallId.make(crypto.randomUUID()),
		path: [...SESSION_LIST_CALL_PATH],
		args: {},
		...(window === undefined ? {} : {window}),
	});

const refused = (failure: SpellFailure): RefusedSessions => ({_tag: "Refused", failure});

/**
 * One reply as this call's answer, or `null` when it answers a different call. `null` is not an
 * empty list: a page holding several calls open reads every reply, and "not mine" has to stay
 * distinguishable from "mine, and there are no sessions".
 */
export const readSessionList = (call: SpellCall, reply: SpellReply): SessionListAnswer | null => {
	if (reply.id !== call.id) return null;
	if (!reply.ok) return refused(reply.error);
	const decoded = Schema.decodeUnknownResult(SessionList)(reply.result);
	if (Result.isFailure(decoded)) {
		return refused({
			tag: "tuval/BadSessionList",
			message: "the kernel answered with a result this page cannot read as a session list",
			path: call.path,
		});
	}
	return {
		_tag: "Listed",
		sessions: decoded.success.sessions,
		unreadable: decoded.success.unreadable,
	};
};
