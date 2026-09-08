/**
 * One request in, one answer out. The answer is either a `CommandResult` or a `ProtocolError`,
 * never a failure — a refusal the protocol has a code for is data the client is owed, and only a
 * broken connection is an Effect failure. Nothing here touches a socket, so the whole refusal
 * behaviour (locked, not found, ownership) is testable without one.
 */

import {randomUUID} from "node:crypto";
import {Effect} from "effect";
import type {
	Command,
	CommandResult,
	ProtocolError,
	RpcTarget,
	SessionSnapshot,
} from "../wire/index.ts";
import {isSessionTarget} from "../wire/index.ts";
import type {PiSessionHandle, PiSessionHostApi} from "./PiSessionHost.ts";
import type {ConnectionId, SessionRecord, SessionRecords} from "./records.ts";
import {sessionMetadata, sessionSnapshot} from "./snapshots.ts";

export type Answer =
	| {readonly ok: true; readonly result: CommandResult}
	| {readonly ok: false; readonly error: ProtocolError};

export interface DispatchContext {
	readonly connection: ConnectionId;
	/** This server's own id. A target naming another server is not this server's to answer. */
	readonly serverId: string;
	readonly records: SessionRecords;
	readonly host: PiSessionHostApi;
	readonly now: () => number;
	/** Called after a command changed a session, so the server can push the new snapshot. */
	readonly onChanged: (sessionId: string) => Effect.Effect<void>;
}

const failure = (error: ProtocolError): Answer => ({ok: false, error});

const notFound = (sessionId: string): Answer =>
	failure({code: "not_found", message: `no session ${sessionId}`});

const locked = (sessionId: string): Answer =>
	failure({
		code: "session_locked",
		message: `session ${sessionId} is attached to another connection`,
	});

const internal = (message: string): Answer => failure({code: "internal_error", message});

const misaddressed = (message: string): Answer => failure({code: "invalid_request", message});

/**
 * Every session command needs the same three things first: the record exists, this connection
 * owns it, and the answer carries a fresh snapshot. `owned` supplies the first two; the caller
 * runs its host call and then snapshots.
 */
type OwnershipGate =
	| {readonly _tag: "Owned"; readonly record: SessionRecord}
	| {readonly _tag: "Refused"; readonly answer: Answer};

const owned = (context: DispatchContext, target: RpcTarget, sessionId: string): OwnershipGate => {
	const record = context.records.get(sessionId);
	if (record === undefined) return {_tag: "Refused", answer: notFound(sessionId)};
	if (record.owner === undefined || record.owner.connection !== context.connection) {
		return {_tag: "Refused", answer: locked(sessionId)};
	}
	// The envelope fences the call and the payload names the session; a call whose two halves
	// disagree is one this server cannot route, not one it should guess at.
	if (!isSessionTarget(target)) {
		return {
			_tag: "Refused",
			answer: misaddressed(`${sessionId} needs a session target, not a server target`),
		};
	}
	if (target.sessionId !== sessionId) {
		return {
			_tag: "Refused",
			answer: misaddressed(`target names session ${target.sessionId}, the call names ${sessionId}`),
		};
	}
	if (target.attachmentId !== record.owner.attachment) {
		return {_tag: "Refused", answer: locked(sessionId)};
	}
	return {_tag: "Owned", record};
};

const snapshotOf = (
	context: DispatchContext,
	record: SessionRecord,
): Effect.Effect<SessionSnapshot> =>
	record.handle.read.pipe(
		Effect.map((view) => {
			const current = context.records.get(record.handle.id) ?? record;
			return sessionSnapshot(current, view, context.connection);
		}),
	);

/** A session call's shared tail: run it, then answer with the session's snapshot. */
const withSession = (
	context: DispatchContext,
	target: RpcTarget,
	sessionId: string,
	command: "prompt" | "steer" | "abort" | "set_model" | "set_thinking",
	call: (handle: PiSessionHandle) => Effect.Effect<void, {readonly message: string}>,
): Effect.Effect<Answer> => {
	const gate = owned(context, target, sessionId);
	if (gate._tag === "Refused") return Effect.succeed(gate.answer);
	return call(gate.record.handle).pipe(
		Effect.flatMap(() => context.onChanged(sessionId)),
		Effect.flatMap(() => snapshotOf(context, gate.record)),
		Effect.map((session): Answer => ({ok: true, result: {command, session}})),
		Effect.catch((error) => Effect.succeed(internal(error.message))),
	);
};

export const dispatch = (
	context: DispatchContext,
	target: RpcTarget,
	command: Command,
): Effect.Effect<Answer> => {
	if (target.serverId !== context.serverId) {
		return Effect.succeed(
			misaddressed(`target names server ${target.serverId}, this is ${context.serverId}`),
		);
	}
	switch (command.command) {
		case "list":
			return Effect.succeed<Answer>({
				ok: true,
				result: {command: "list", sessions: context.records.list().map(sessionMetadata)},
			});

		case "create": {
			const attachmentId = randomUUID();
			return context.host
				.open({
					cwd: command.cwd ?? process.cwd(),
					name: command.name,
					model: command.model,
					thinkingLevel: command.thinkingLevel,
				})
				.pipe(
					Effect.flatMap((handle) =>
						snapshotOf(
							context,
							context.records.insert(handle, context.connection, attachmentId, context.now()),
						),
					),
					Effect.map(
						(session): Answer => ({
							ok: true,
							result: {command: "create", session, attachmentId},
						}),
					),
					Effect.catch((error) => Effect.succeed(internal(error.message))),
				);
		}

		case "attach": {
			const attachmentId = randomUUID();
			const outcome = context.records.claim(command.sessionId, context.connection, attachmentId);
			// A session this table never held is not thereby gone: the table is per server and a
			// server is per process, so after a restart every session a checkpoint names is one only
			// the store still knows. The host re-opens it, and a host that cannot is the `not_found`
			// this used to answer straight away (#7609).
			if (outcome._tag === "NotFound") {
				return context.host.resume(command.sessionId).pipe(
					Effect.flatMap((handle) =>
						snapshotOf(
							context,
							context.records.insert(handle, context.connection, attachmentId, context.now()),
						),
					),
					Effect.map(
						(session): Answer => ({
							ok: true,
							result: {command: "attach", session, attachmentId},
						}),
					),
					Effect.orElseSucceed(() => notFound(command.sessionId)),
				);
			}
			if (outcome._tag === "Locked") return Effect.succeed(locked(command.sessionId));
			return snapshotOf(context, outcome.record).pipe(
				Effect.map(
					(session): Answer => ({
						ok: true,
						result: {command: "attach", session, attachmentId: outcome.attachment},
					}),
				),
			);
		}

		case "detach": {
			const record = context.records.get(command.sessionId);
			if (record === undefined) return Effect.succeed(notFound(command.sessionId));
			if (!context.records.release(command.sessionId, context.connection)) {
				return Effect.succeed(locked(command.sessionId));
			}
			return Effect.succeed<Answer>({
				ok: true,
				result: {command: "detach", sessionId: command.sessionId},
			});
		}

		case "prompt":
			return withSession(context, target, command.sessionId, "prompt", (handle) =>
				handle.prompt(command.text),
			);

		case "steer":
			return withSession(context, target, command.sessionId, "steer", (handle) =>
				handle.steer(command.text),
			);

		case "abort":
			return withSession(context, target, command.sessionId, "abort", (handle) => handle.abort);

		case "set_model":
			return withSession(context, target, command.sessionId, "set_model", (handle) =>
				handle.setModel(command.model),
			);

		case "set_thinking":
			return withSession(context, target, command.sessionId, "set_thinking", (handle) =>
				handle.setThinkingLevel(command.thinkingLevel),
			);
	}
};
