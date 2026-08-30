import type {TranscriptItem} from "@earendil-works/pi-protocol";
import type {LiveTranscriptEntry, TranscriptArchiveState} from "../shared/live-session.js";

interface ArchiveCursorPayload {
	readonly version: 1;
	readonly sessionId: string;
	readonly anchorId: string;
}

export const encodeArchiveCursor = (payload: ArchiveCursorPayload): string =>
	Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

export const decodeArchiveCursor = (cursor: string): ArchiveCursorPayload | undefined => {
	try {
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			typeof value !== "object" ||
			value === null ||
			!("version" in value) ||
			value.version !== 1 ||
			!("sessionId" in value) ||
			typeof value.sessionId !== "string" ||
			!("anchorId" in value) ||
			typeof value.anchorId !== "string"
		) {
			return undefined;
		}
		return value as ArchiveCursorPayload;
	} catch {
		return undefined;
	}
};

export const archiveEntryOf = (item: TranscriptItem): LiveTranscriptEntry => ({
	id: item.id,
	role: item.role,
	content: [...item.content],
	timestamp: item.timestamp,
	status: item.role === "user" ? "complete" : item.status,
});

export const archiveStateBefore = (
	sessionId: string,
	transcript: ReadonlyArray<TranscriptItem>,
	before: number,
): TranscriptArchiveState => {
	if (before <= 0) return {_tag: "complete", hasMore: false};
	const anchor = transcript[before];
	if (anchor === undefined) return {_tag: "complete", hasMore: false};
	return {
		_tag: "more",
		hasMore: true,
		cursor: encodeArchiveCursor({version: 1, sessionId, anchorId: anchor.id}),
	};
};
