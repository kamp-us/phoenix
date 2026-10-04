/**
 * The session table: one record per open session, at most one owning connection each, and the
 * revision that every pushed snapshot advances.
 *
 * Every operation here is synchronous by construction. Effect fibers interleave only at a yield
 * point, so a mutation that reaches no `yield*` is atomic against the other request fibers, and
 * the table needs no lock — which is what lets a slow `prompt` and a later `list` run
 * concurrently without either one seeing a half-applied claim. The host calls that *are* slow
 * happen outside these functions.
 */

import type {PiSessionHandle} from "./PiSessionHost.ts";

export type ConnectionId = string;

/**
 * The attachment a `SessionTarget` names. Minted per claim, so a call made on the lease a
 * reacquire replaced carries an id the record no longer holds and is refused as locked.
 */
export type AttachmentId = string;

export interface SessionOwner {
	readonly connection: ConnectionId;
	readonly attachment: AttachmentId;
}

export interface SessionRecord {
	readonly handle: PiSessionHandle;
	readonly revision: number;
	/** Advanced with the revision, so a snapshot's `updatedAt` names the change it carries. */
	readonly updatedAt: number;
	readonly owner: SessionOwner | undefined;
}

export type ClaimOutcome =
	| {readonly _tag: "Claimed"; readonly record: SessionRecord; readonly attachment: AttachmentId}
	| {readonly _tag: "NotFound"}
	| {readonly _tag: "Locked"; readonly by: ConnectionId};

export interface SessionRecords {
	readonly insert: (
		handle: PiSessionHandle,
		owner: ConnectionId,
		attachment: AttachmentId,
		now: number,
	) => SessionRecord;
	readonly get: (id: string) => SessionRecord | undefined;
	readonly list: () => ReadonlyArray<SessionRecord>;
	/**
	 * Attach, or — when the asking connection already owns the session — reconnect: the previous
	 * attachment is invalidated and a new one issued over the same record, so the transcript
	 * survives.
	 */
	readonly claim: (id: string, connection: ConnectionId, attachment: AttachmentId) => ClaimOutcome;
	readonly release: (id: string, connection: ConnectionId) => boolean;
	/** A closed socket owns nothing; its sessions stay open and become attachable again. */
	readonly releaseConnection: (connection: ConnectionId) => void;
	/** Advances the record's revision and answers the new one. */
	readonly bump: (id: string, now: number) => number | undefined;
	/** Empties the table and answers what it held, so each handle is disposed exactly once. */
	readonly drain: () => ReadonlyArray<PiSessionHandle>;
}

export const makeSessionRecords = (): SessionRecords => {
	const records = new Map<string, SessionRecord>();

	const put = (record: SessionRecord): SessionRecord => {
		records.set(record.handle.id, record);
		return record;
	};

	return {
		insert: (handle, owner, attachment, now) =>
			put({handle, revision: 0, updatedAt: now, owner: {connection: owner, attachment}}),

		get: (id) => records.get(id),

		list: () => [...records.values()],

		claim: (id, connection, attachment) => {
			const record = records.get(id);
			if (record === undefined) return {_tag: "NotFound"};
			if (record.owner !== undefined && record.owner.connection !== connection) {
				return {_tag: "Locked", by: record.owner.connection};
			}
			return {
				_tag: "Claimed",
				record: put({...record, owner: {connection, attachment}}),
				attachment,
			};
		},

		release: (id, connection) => {
			const record = records.get(id);
			if (record?.owner === undefined || record.owner.connection !== connection) return false;
			put({...record, owner: undefined});
			return true;
		},

		releaseConnection: (connection) => {
			for (const record of records.values()) {
				if (record.owner?.connection === connection) put({...record, owner: undefined});
			}
		},

		bump: (id, now) => {
			const record = records.get(id);
			if (record === undefined) return undefined;
			const revision = record.revision + 1;
			put({...record, revision, updatedAt: now});
			return revision;
		},

		drain: () => {
			const handles = [...records.values()].map((record) => record.handle);
			records.clear();
			return handles;
		},
	};
};
