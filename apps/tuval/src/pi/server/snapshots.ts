/**
 * Record + view → wire snapshot. `attached` is per viewer and `locked` is not: a second
 * connection asking for the server snapshot must see the session as locked without seeing it as
 * its own.
 */

import type {
	ModelMetadata,
	ServerSnapshot,
	SessionMetadata,
	SessionSnapshot,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import {PROTOCOL_VERSION} from "@earendil-works/pi-protocol";
import type {PiSessionView} from "./PiSessionHost.ts";
import type {ConnectionId, SessionRecord} from "./records.ts";

export const sessionMetadata = (record: SessionRecord): SessionMetadata => ({
	id: record.handle.id,
	createdAt: record.handle.createdAt,
	updatedAt: record.updatedAt,
	cwd: record.handle.cwd,
});

const queuedSteerItems = (
	record: SessionRecord,
	queued: ReadonlyArray<string>,
): ReadonlyArray<UserTranscriptItem> =>
	queued.map((text, index) => ({
		id: `${record.handle.id}:steer:${index}`,
		role: "user",
		content: [{type: "text", text}],
		timestamp: record.updatedAt,
	}));

export const sessionSnapshot = (
	record: SessionRecord,
	view: PiSessionView,
	viewer: ConnectionId,
): SessionSnapshot => {
	const queuedSteer = queuedSteerItems(record, view.queuedSteer);
	return {
		id: record.handle.id,
		...(view.name === undefined ? {} : {name: view.name}),
		cwd: record.handle.cwd,
		createdAt: record.handle.createdAt,
		updatedAt: record.updatedAt,
		phase: view.phase,
		model: view.model,
		thinkingLevel: view.thinkingLevel,
		attached: record.owner?.connection === viewer,
		locked: record.owner !== undefined,
		revision: record.revision,
		transcript: [...view.transcript],
		queuedSteer: [...queuedSteer],
		queuedSteerCount: queuedSteer.length,
	};
};

export const serverSnapshot = (options: {
	readonly serverId: string;
	readonly revision: number;
	readonly records: ReadonlyArray<SessionRecord>;
	readonly models: ReadonlyArray<ModelMetadata>;
}): ServerSnapshot => ({
	serverId: options.serverId,
	protocolVersion: PROTOCOL_VERSION,
	revision: options.revision,
	sessions: options.records.map(sessionMetadata),
	models: [...options.models],
});
