/**
 * `SessionSummary` — one AI-agent session as a list row reads it, in no backend's own shape.
 *
 * The two stores disagree about almost everything. At `@anthropic-ai/claude-agent-sdk@0.3.259`
 * `SDKSessionInfo` carries `firstPrompt`, `gitBranch` and a `lastModified` in epoch milliseconds,
 * and counts no messages; at `@earendil-works/pi-coding-agent@0.84.3` `SessionInfo` carries
 * `firstMessage`, a `messageCount` and a `modified` that is a `Date`, and knows no git branch.
 * Neither type may cross the port, so this is what both map inward to.
 *
 * Four of the seven fields are optional because a real store leaves them out, and `sessionSummary`
 * below is what keeps an absence an absence: Pi's `cwd` is the empty string for sessions old enough
 * to predate the field, and a session with no git branch is not a session on a branch named "".
 */

/** One session, backend-neutral. Built through `sessionSummary`, never by a backend's own literal. */
export interface SessionSummary {
	readonly sessionId: string;
	/** Milliseconds since the epoch, so a union across backends sorts without parsing anything. */
	readonly lastModified: number;
	/** Which registered implementation this session came from — the row's backend tag. */
	readonly backend: string;
	readonly firstPrompt?: string | undefined;
	/** The directory the session was started in. */
	readonly folder?: string | undefined;
	readonly branch?: string | undefined;
	/** Absent when the store does not count. `0` is a genuinely empty session, not an absence. */
	readonly messageCount?: number | undefined;
}

/**
 * What a backend has in hand before normalizing. The nullable and empty spellings are admitted
 * here precisely so they are refused on the way in — a `null`, a blank string or a negative count
 * becomes an absent field rather than a value a row would render.
 */
export interface SessionDraft {
	readonly sessionId: string;
	/** A `Date` is taken as readily as epoch milliseconds, because one store answers in each. */
	readonly lastModified: number | Date;
	readonly backend: string;
	readonly firstPrompt?: string | null | undefined;
	readonly folder?: string | null | undefined;
	readonly branch?: string | null | undefined;
	readonly messageCount?: number | null | undefined;
}

const text = (value: string | null | undefined): string | undefined => {
	const trimmed = value?.trim() ?? "";
	return trimmed.length === 0 ? undefined : trimmed;
};

const count = (value: number | null | undefined): number | undefined =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

export const sessionSummary = (draft: SessionDraft): SessionSummary => {
	const firstPrompt = text(draft.firstPrompt);
	const folder = text(draft.folder);
	const branch = text(draft.branch);
	const messageCount = count(draft.messageCount);
	return {
		sessionId: draft.sessionId,
		lastModified:
			typeof draft.lastModified === "number" ? draft.lastModified : draft.lastModified.getTime(),
		backend: draft.backend,
		...(firstPrompt === undefined ? {} : {firstPrompt}),
		...(folder === undefined ? {} : {folder}),
		...(branch === undefined ? {} : {branch}),
		...(messageCount === undefined ? {} : {messageCount}),
	};
};

/** Newest first, as the port declares. `sort` is stable, so a tie keeps the store's own order. */
export const newestFirst = (
	sessions: ReadonlyArray<SessionSummary>,
): ReadonlyArray<SessionSummary> =>
	[...sessions].sort((left, right) => right.lastModified - left.lastModified);
