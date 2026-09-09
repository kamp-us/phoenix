/**
 * The wire between the page and the kernel: one JSON frame per message, each a nominal `kind` plus
 * a predicate that admits its payload — the same discipline a port declares (`../../registry/program.ts`),
 * for the same reason: the kind names the protocol and the predicate admits the body, and nothing
 * decodes by guessing.
 *
 * Two facts about the vocabulary are load-bearing. The frames are program-blind: a process's state
 * crosses as `unknown`, and the program's own module gives it back its shape on the page, exactly as
 * the process table erases it (`../../table/row.ts`). And there is **no shell frame** — the shell
 * process's state travels as an ordinary `process-state` frame, so the page finds its shell by
 * reading the table for the shell program's row like it would find any other process (#7556).
 *
 * The `registry` frame is a catalog and not an exception to the first of those. What it carries is
 * what the *registry* knows about a program a window could show — its id, the name a surface calls
 * it, and the reference naming its renderer — and nothing a running process holds: no state, no Msg,
 * no private vocabulary. A page that reads it learns what it may spawn and which renderer a program
 * asks for, and still learns every process's state as `unknown` (#7788).
 *
 * The `keys` frame is the one thing here that is neither state nor catalog: it is the grammar the
 * page routes over, and the page may route over no other
 * ([ADR 0353](../../../../../.decisions/0353-kernel-sends-the-prefix-table.md)).
 *
 * The two `spell` frames are the only round trip a page starts. Everything else the kernel holds is
 * pushed; a spell call is the one thing a page may ask for, and it is asked for as the protocol's
 * own `SpellCall`/`SpellReply` pair admitted through that module's schemas rather than a second
 * request shape written here (`../../protocol/messages.ts`, ADR 0348 R1.3, #8161). The pair
 * correlates on the `CallId` the caller minted, so neither frame carries a `seq` of this
 * transport's own.
 */

import {Duration, Option, Predicate, Result, Schema} from "effect";
import {readParams} from "../../commands/parse/spell-index.ts";
import type {Lifecycle, ProcessId} from "../../process/process.ts";
import {SpellCall, SpellReply} from "../../protocol/messages.ts";
import {RegistryDescription} from "../../protocol/registry-description.ts";
import type {ProgramId, RendererKind, RendererRef} from "../../registry/program.ts";
import type {PortDeclaration, TableEvent, TableEventKind, TableRow} from "../../table/row.ts";
import {type Binding, CommandName, type PrefixTable} from "../keys/table.ts";
import type {UndecodableReason} from "./errors.ts";

export const ATTACH_KIND = "tuval/transport/attach/v1";
export const DETACH_KIND = "tuval/transport/detach/v1";
export const DISPATCH_KIND = "tuval/transport/dispatch/v1";
export const SPELL_CALL_KIND = "tuval/transport/spell-call/v1";

export const TABLE_KIND = "tuval/transport/table/v1";
export const PROCESS_STATE_KIND = "tuval/transport/process-state/v1";
export const ATTACH_REFUSED_KIND = "tuval/transport/attach-refused/v1";
export const DISPATCHED_KIND = "tuval/transport/dispatched/v1";
export const REGISTRY_KIND = "tuval/transport/registry/v1";
export const KEYS_KIND = "tuval/transport/keys/v1";
export const SPELL_REPLY_KIND = "tuval/transport/spell-reply/v1";
export const SPELL_REGISTRY_KIND = "tuval/transport/spell-registry/v1";

/** Attach to one process: from here its state arrives as `process-state` frames for as long as it lives. */
export interface AttachFrame {
	readonly kind: typeof ATTACH_KIND;
	readonly processId: ProcessId;
}

/** Stop receiving one process's state. The process is untouched; only this socket's interest ends. */
export interface DetachFrame {
	readonly kind: typeof DETACH_KIND;
	readonly processId: ProcessId;
}

/**
 * Send a Msg into a process. `seq` is this socket's own correlation number — the acknowledgement
 * comes back on it, which is how `dispatch` is an Effect that resolves rather than a shout.
 */
export interface DispatchFrame {
	readonly kind: typeof DISPATCH_KIND;
	readonly seq: number;
	readonly processId: ProcessId;
	readonly msg: {readonly type: string; readonly [field: string]: unknown};
}

/**
 * One spell call, on its way to the kernel's executor. The payload is the protocol's own `SpellCall`
 * and not a second request shape: the correlation is the `CallId` the caller already minted, so this
 * frame needs no `seq` of its own (ADR 0348 R1.3, `../../protocol/messages.ts`).
 */
export interface SpellCallFrame {
	readonly kind: typeof SPELL_CALL_KIND;
	readonly call: SpellCall;
}

export type ClientFrame = AttachFrame | DetachFrame | DispatchFrame | SpellCallFrame;

/** A table row as JSON: every `Option` on it is a nullable field, and nothing else changes. */
export interface WireRow {
	readonly id: ProcessId;
	readonly programId: ProgramId;
	readonly parentId: ProcessId | null;
	readonly ports: Readonly<Record<string, PortDeclaration>>;
	readonly stateSummary: {readonly lifecycle: Lifecycle; readonly revision: number};
	readonly title: string | null;
	readonly status: string | null;
}

export interface TableFrame {
	readonly kind: typeof TABLE_KIND;
	readonly event: TableEventKind;
	readonly row: WireRow;
}

/**
 * One process's public state. `gone` is the terminal arm for that process id, and it carries no
 * state — the same two arms `ProcessView` has on the page (`../window/host.ts`).
 */
export interface ProcessStateFrame {
	readonly kind: typeof PROCESS_STATE_KIND;
	readonly processId: ProcessId;
	readonly view:
		| {
				readonly _tag: "Live";
				readonly lifecycle: Lifecycle;
				readonly revision: number;
				readonly state: unknown;
		  }
		| {readonly _tag: "ProcessGone"};
}

/** Why one attach was refused. The socket stays open: another process on it may still be served. */
export interface AttachRefusedFrame {
	readonly kind: typeof ATTACH_REFUSED_KIND;
	readonly processId: ProcessId;
	readonly refusal:
		| {readonly reason: "placement-unsupported"; readonly placement: string}
		| {readonly reason: "no-such-process"};
}

/**
 * The acknowledgement for one `seq`. Its two arms are `DispatchResult`'s (`../window/host.ts`).
 *
 * `Delivered` carries the process's public state as it stands once the Msg has been applied — the
 * same program-blind `unknown` a `process-state` frame carries, read off the same summary. It is
 * the *reply* to a dispatch rather than a broadcast, which is what lets a caller learn what its own
 * Msg did without racing the state pump: the two leave on different fibers and nothing orders them
 * (#8274). Optional, because a kernel that has already dropped the row between the dispatch and the
 * read has no state to send and still owes the ack.
 */
export interface DispatchedFrame {
	readonly kind: typeof DISPATCHED_KIND;
	readonly seq: number;
	readonly result:
		| {
				readonly _tag: "Delivered";
				readonly view?: {readonly revision: number; readonly state: unknown};
		  }
		| {readonly _tag: "ProcessGone"; readonly processId: ProcessId};
}

/**
 * One registry row a window can show. `renderer` is required rather than optional because a headless
 * row never crosses: the kernel filters the catalog with `showsInAWindow` (`../picker/entries.ts`),
 * so "on the wire" and "can fill a window" are the same fact and a page cannot be handed a program
 * it could offer and then fail to render.
 */
export interface WireProgram {
	readonly programId: ProgramId;
	readonly label: string;
	readonly renderer: RendererRef;
	/**
	 * The two desk-level references the row declares beside its window renderer
	 * (`../../registry/program.ts`). Optional on the row and therefore optional here: a program that
	 * declares neither sends neither, and the page's inspector region answers `not-declared` rather
	 * than going looking for a reference nobody made.
	 */
	readonly inspector?: RendererRef;
	readonly status?: RendererRef;
}

/**
 * Every windowed program this kernel has, whole. A later frame replaces the list rather than
 * amending it, so a page that reloads its catalog cannot end up holding a program the registry
 * dropped.
 */
export interface RegistryFrame {
	readonly kind: typeof REGISTRY_KIND;
	readonly programs: ReadonlyArray<WireProgram>;
}

/** One binding as JSON. `command` is a branded string, so only its type is erased. */
export interface WireBinding {
	readonly sequence: string;
	readonly command: string;
	readonly repeatable: boolean;
}

/** The prefix table as JSON: `repeatTimeout`'s `Duration` is milliseconds, and nothing else changes. */
export interface WirePrefixTable {
	readonly prefix: string;
	readonly repeatTimeoutMs: number;
	readonly bindings: ReadonlyArray<WireBinding>;
}

/**
 * The grammar the kernel routes keys against, sent as the socket opens. A later frame replaces the
 * table rather than amending it, the same way the catalog is replaced whole.
 */
export interface KeysFrame {
	readonly kind: typeof KEYS_KIND;
	readonly table: WirePrefixTable;
}

/** The answer to one `SpellCallFrame`, matched to it by the `CallId` both carry. */
export interface SpellReplyFrame {
	readonly kind: typeof SPELL_REPLY_KIND;
	readonly reply: SpellReply;
}

export interface SpellRegistryFrame {
	readonly kind: typeof SPELL_REGISTRY_KIND;
	readonly registry: RegistryDescription;
}

export type ServerFrame =
	| TableFrame
	| ProcessStateFrame
	| AttachRefusedFrame
	| DispatchedFrame
	| RegistryFrame
	| KeysFrame
	| SpellRegistryFrame
	| SpellReplyFrame;

const isProcessIdString = (value: unknown): value is ProcessId => typeof value === "string";

const isMessage = (value: unknown): value is DispatchFrame["msg"] =>
	Predicate.isObject(value) && typeof value.type === "string";

const isPortDeclaration = (value: unknown): value is PortDeclaration =>
	Predicate.isObject(value) &&
	typeof value.kind === "string" &&
	(value.direction === "in" || value.direction === "out");

const lifecycles: ReadonlySet<string> = new Set<Lifecycle>(["running", "stopping"]);
const tableEventKinds: ReadonlySet<string> = new Set<TableEventKind>([
	"spawned",
	"stopped",
	"state-changed",
]);

const rendererKinds: ReadonlySet<string> = new Set<RendererKind>([
	"host-native",
	"host-declarative",
	"isolated-frame",
	"module",
]);

const isRendererRef = (value: unknown): value is RendererRef =>
	Predicate.isObject(value) &&
	typeof value.kind === "string" &&
	rendererKinds.has(value.kind) &&
	typeof value.ref === "string";

const isSummary = (value: unknown): value is WireRow["stateSummary"] =>
	Predicate.isObject(value) &&
	typeof value.lifecycle === "string" &&
	lifecycles.has(value.lifecycle) &&
	typeof value.revision === "number";

export const isWireRow = (value: unknown): value is WireRow =>
	Predicate.isObject(value) &&
	typeof value.id === "string" &&
	typeof value.programId === "string" &&
	(value.parentId === null || typeof value.parentId === "string") &&
	Predicate.isObjectOrArray(value.ports) &&
	Object.values(value.ports).every(isPortDeclaration) &&
	isSummary(value.stateSummary) &&
	(value.title === null || typeof value.title === "string") &&
	(value.status === null || typeof value.status === "string");

export const isAttachFrame = (value: unknown): value is AttachFrame =>
	Predicate.isObject(value) && value.kind === ATTACH_KIND && isProcessIdString(value.processId);

export const isDetachFrame = (value: unknown): value is DetachFrame =>
	Predicate.isObject(value) && value.kind === DETACH_KIND && isProcessIdString(value.processId);

export const isDispatchFrame = (value: unknown): value is DispatchFrame =>
	Predicate.isObject(value) &&
	value.kind === DISPATCH_KIND &&
	Number.isInteger(value.seq) &&
	isProcessIdString(value.processId) &&
	isMessage(value.msg);

export const isTableFrame = (value: unknown): value is TableFrame =>
	Predicate.isObject(value) &&
	value.kind === TABLE_KIND &&
	typeof value.event === "string" &&
	tableEventKinds.has(value.event) &&
	isWireRow(value.row);

export const isProcessStateFrame = (value: unknown): value is ProcessStateFrame =>
	Predicate.isObject(value) &&
	value.kind === PROCESS_STATE_KIND &&
	isProcessIdString(value.processId) &&
	Predicate.isObject(value.view) &&
	((value.view._tag === "Live" &&
		typeof value.view.lifecycle === "string" &&
		lifecycles.has(value.view.lifecycle) &&
		typeof value.view.revision === "number" &&
		"state" in value.view) ||
		value.view._tag === "ProcessGone");

export const isAttachRefusedFrame = (value: unknown): value is AttachRefusedFrame =>
	Predicate.isObject(value) &&
	value.kind === ATTACH_REFUSED_KIND &&
	isProcessIdString(value.processId) &&
	Predicate.isObject(value.refusal) &&
	((value.refusal.reason === "placement-unsupported" &&
		typeof value.refusal.placement === "string") ||
		value.refusal.reason === "no-such-process");

const isDispatchedView = (value: unknown): boolean =>
	Predicate.isObject(value) && typeof value.revision === "number" && "state" in value;

export const isDispatchedFrame = (value: unknown): value is DispatchedFrame =>
	Predicate.isObject(value) &&
	value.kind === DISPATCHED_KIND &&
	Number.isInteger(value.seq) &&
	Predicate.isObject(value.result) &&
	((value.result._tag === "Delivered" &&
		(value.result.view === undefined || isDispatchedView(value.result.view))) ||
		(value.result._tag === "ProcessGone" && isProcessIdString(value.result.processId)));

export const isWireProgram = (value: unknown): value is WireProgram =>
	Predicate.isObject(value) &&
	typeof value.programId === "string" &&
	typeof value.label === "string" &&
	isRendererRef(value.renderer) &&
	// Absent is legal, present must be a reference: an `inspector` key carrying junk is a malformed
	// frame, not a program that declares no inspector.
	(value.inspector === undefined || isRendererRef(value.inspector)) &&
	(value.status === undefined || isRendererRef(value.status));

export const isRegistryFrame = (value: unknown): value is RegistryFrame =>
	Predicate.isObject(value) &&
	value.kind === REGISTRY_KIND &&
	Array.isArray(value.programs) &&
	value.programs.every(isWireProgram);

export const isWireBinding = (value: unknown): value is WireBinding =>
	Predicate.isObject(value) &&
	typeof value.sequence === "string" &&
	typeof value.command === "string" &&
	typeof value.repeatable === "boolean";

export const isWirePrefixTable = (value: unknown): value is WirePrefixTable =>
	Predicate.isObject(value) &&
	typeof value.prefix === "string" &&
	typeof value.repeatTimeoutMs === "number" &&
	Number.isFinite(value.repeatTimeoutMs) &&
	Array.isArray(value.bindings) &&
	value.bindings.every(isWireBinding);

export const isKeysFrame = (value: unknown): value is KeysFrame =>
	Predicate.isObject(value) && value.kind === KEYS_KIND && isWirePrefixTable(value.table);

/**
 * One kind's admission: the value as that frame, or `undefined` when the body is not one. A
 * function rather than a type guard, because the two spell frames decode their payload as they
 * admit it — what comes back is the protocol's own value and not the JSON it arrived as.
 */
type Admit<F> = (value: unknown) => F | undefined;

const admitting =
	<F>(admits: (value: unknown) => value is F): Admit<F> =>
	(value) =>
		admits(value) ? value : undefined;

/**
 * The two spell frames admit their payload through the protocol's own schema rather than a
 * predicate written here: the message pair is declared once (`../../protocol/messages.ts`), and a
 * second reading of it on this wire would be a second declaration that can drift from it.
 */
export const admitSpellCallFrame: Admit<SpellCallFrame> = (value) => {
	if (!Predicate.isObject(value) || value.kind !== SPELL_CALL_KIND) return undefined;
	const decoded = Schema.decodeUnknownResult(SpellCall)(value.call);
	return Result.isFailure(decoded) ? undefined : {kind: SPELL_CALL_KIND, call: decoded.success};
};

export const admitSpellReplyFrame: Admit<SpellReplyFrame> = (value) => {
	if (!Predicate.isObject(value) || value.kind !== SPELL_REPLY_KIND) return undefined;
	const decoded = Schema.decodeUnknownResult(SpellReply)(value.reply);
	return Result.isFailure(decoded) ? undefined : {kind: SPELL_REPLY_KIND, reply: decoded.success};
};

export const admitSpellRegistryFrame: Admit<SpellRegistryFrame> = (value) => {
	if (!Predicate.isObject(value) || value.kind !== SPELL_REGISTRY_KIND) return undefined;
	const decoded = Schema.decodeUnknownResult(RegistryDescription)(value.registry);
	if (Result.isFailure(decoded)) return undefined;
	const valid = Result.try(() => {
		for (const row of decoded.success) readParams(row.params);
		return {kind: SPELL_REGISTRY_KIND, registry: decoded.success} satisfies SpellRegistryFrame;
	});
	return Result.isFailure(valid) ? undefined : valid.success;
};

/** Decoded, or the one reason it was not. A refusal is a value: the caller decides what to close. */
export type Decoded<F> =
	| {readonly _tag: "Frame"; readonly frame: F}
	| {
			readonly _tag: "Undecodable";
			readonly reason: UndecodableReason;
	  };

const undecodable = <F>(reason: UndecodableReason): Decoded<F> => ({_tag: "Undecodable", reason});

const parse = (
	text: string,
): {readonly ok: true; readonly value: unknown} | {readonly ok: false} => {
	// biome-ignore lint/plugin: pure total decoder — the JSON.parse failure is fully absorbed into the returned `Decoded` refusal (`not-json`), never an E channel; both ends call it synchronously inside their own Effect, so lifting it into Effect.try would only move the absorption one frame out.
	try {
		return {ok: true, value: JSON.parse(text) as unknown};
	} catch {
		return {ok: false};
	}
};

const decodeWith =
	<F extends {readonly kind: string}>(
		known: ReadonlySet<string>,
		admits: ReadonlyArray<Admit<F>>,
	) =>
	(text: string): Decoded<F> => {
		const parsed = parse(text);
		if (!parsed.ok) return undecodable("not-json");
		const value = parsed.value;
		if (!Predicate.isObject(value) || typeof value.kind !== "string" || !known.has(value.kind)) {
			return undecodable("unknown-kind");
		}
		for (const admit of admits) {
			const frame = admit(value);
			if (frame !== undefined) return {_tag: "Frame", frame};
		}
		// The kind is one this end serves, so the body is what failed: a payload the predicate refused.
		return undecodable("malformed-payload");
	};

export const decodeClientFrame: (text: string) => Decoded<ClientFrame> = decodeWith<ClientFrame>(
	new Set([ATTACH_KIND, DETACH_KIND, DISPATCH_KIND, SPELL_CALL_KIND]),
	[
		admitting(isAttachFrame),
		admitting(isDetachFrame),
		admitting(isDispatchFrame),
		admitSpellCallFrame,
	],
);

export const decodeServerFrame: (text: string) => Decoded<ServerFrame> = decodeWith<ServerFrame>(
	new Set([
		TABLE_KIND,
		PROCESS_STATE_KIND,
		ATTACH_REFUSED_KIND,
		DISPATCHED_KIND,
		REGISTRY_KIND,
		KEYS_KIND,
		SPELL_REPLY_KIND,
		SPELL_REGISTRY_KIND,
	]),
	[
		admitting(isTableFrame),
		admitting(isProcessStateFrame),
		admitting(isAttachRefusedFrame),
		admitting(isDispatchedFrame),
		admitting(isRegistryFrame),
		admitting(isKeysFrame),
		admitSpellReplyFrame,
		admitSpellRegistryFrame,
	],
);

/** One call as the frame that carries it, so a caller never spells the kind at its send site. */
export const spellCallFrame = (call: SpellCall): SpellCallFrame => ({kind: SPELL_CALL_KIND, call});

export const spellReplyFrame = (reply: SpellReply): SpellReplyFrame => ({
	kind: SPELL_REPLY_KIND,
	reply,
});

export const encodeFrame = (frame: ClientFrame | ServerFrame): string => JSON.stringify(frame);

export const toWireRow = (row: TableRow): WireRow => ({
	id: row.id,
	programId: row.programId,
	parentId: Option.getOrNull(row.parentId),
	ports: row.ports,
	stateSummary: row.stateSummary,
	title: Option.getOrNull(row.title),
	status: Option.getOrNull(row.status),
});

export const fromWireRow = (row: WireRow): TableRow => ({
	id: row.id,
	programId: row.programId,
	parentId: Option.fromNullishOr(row.parentId),
	ports: row.ports,
	stateSummary: row.stateSummary,
	title: Option.fromNullishOr(row.title),
	status: Option.fromNullishOr(row.status),
});

export const tableFrame = (event: TableEvent): TableFrame => ({
	kind: TABLE_KIND,
	event: event.kind,
	row: toWireRow(event.row),
});

export const toWirePrefixTable = (table: PrefixTable): WirePrefixTable => ({
	prefix: table.prefix,
	repeatTimeoutMs: Duration.toMillis(table.repeatTimeout),
	bindings: table.bindings.map((binding) => ({
		sequence: binding.sequence,
		command: binding.command,
		repeatable: binding.repeatable,
	})),
});

export const fromWirePrefixTable = (table: WirePrefixTable): PrefixTable => ({
	prefix: table.prefix,
	repeatTimeout: Duration.millis(table.repeatTimeoutMs),
	bindings: table.bindings.map(
		(binding): Binding => ({
			sequence: binding.sequence,
			command: CommandName.make(binding.command),
			repeatable: binding.repeatable,
		}),
	),
});

export const keysFrame = (table: PrefixTable): KeysFrame => ({
	kind: KEYS_KIND,
	table: toWirePrefixTable(table),
});
