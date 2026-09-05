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
 */

import {Duration, Option} from "effect";
import type {Lifecycle, ProcessId} from "../../process/process.ts";
import type {ProgramId, RendererKind, RendererRef} from "../../registry/program.ts";
import type {PortDeclaration, TableEvent, TableEventKind, TableRow} from "../../table/row.ts";
import {type Binding, CommandName, type PrefixTable} from "../keys/table.ts";
import type {UndecodableReason} from "./errors.ts";

export const ATTACH_KIND = "tuval/transport/attach/v1";
export const DETACH_KIND = "tuval/transport/detach/v1";
export const DISPATCH_KIND = "tuval/transport/dispatch/v1";

export const TABLE_KIND = "tuval/transport/table/v1";
export const PROCESS_STATE_KIND = "tuval/transport/process-state/v1";
export const ATTACH_REFUSED_KIND = "tuval/transport/attach-refused/v1";
export const DISPATCHED_KIND = "tuval/transport/dispatched/v1";
export const REGISTRY_KIND = "tuval/transport/registry/v1";
export const KEYS_KIND = "tuval/transport/keys/v1";

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

export type ClientFrame = AttachFrame | DetachFrame | DispatchFrame;

/** A table row as JSON: `parentId`'s `Option` is a nullable field, and nothing else changes. */
export interface WireRow {
	readonly id: ProcessId;
	readonly programId: ProgramId;
	readonly parentId: ProcessId | null;
	readonly ports: Readonly<Record<string, PortDeclaration>>;
	readonly stateSummary: {readonly lifecycle: Lifecycle; readonly revision: number};
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

/** The acknowledgement for one `seq`. Its two arms are `DispatchResult`'s (`../window/host.ts`). */
export interface DispatchedFrame {
	readonly kind: typeof DISPATCHED_KIND;
	readonly seq: number;
	readonly result:
		| {readonly _tag: "Delivered"}
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

export type ServerFrame =
	| TableFrame
	| ProcessStateFrame
	| AttachRefusedFrame
	| DispatchedFrame
	| RegistryFrame
	| KeysFrame;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isProcessIdString = (value: unknown): value is ProcessId => typeof value === "string";

const isMessage = (value: unknown): value is DispatchFrame["msg"] =>
	isRecord(value) && typeof value.type === "string";

const isPortDeclaration = (value: unknown): value is PortDeclaration =>
	isRecord(value) &&
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
]);

const isRendererRef = (value: unknown): value is RendererRef =>
	isRecord(value) &&
	typeof value.kind === "string" &&
	rendererKinds.has(value.kind) &&
	typeof value.ref === "string";

const isSummary = (value: unknown): value is WireRow["stateSummary"] =>
	isRecord(value) &&
	typeof value.lifecycle === "string" &&
	lifecycles.has(value.lifecycle) &&
	typeof value.revision === "number";

export const isWireRow = (value: unknown): value is WireRow =>
	isRecord(value) &&
	typeof value.id === "string" &&
	typeof value.programId === "string" &&
	(value.parentId === null || typeof value.parentId === "string") &&
	isRecord(value.ports) &&
	Object.values(value.ports).every(isPortDeclaration) &&
	isSummary(value.stateSummary);

export const isAttachFrame = (value: unknown): value is AttachFrame =>
	isRecord(value) && value.kind === ATTACH_KIND && isProcessIdString(value.processId);

export const isDetachFrame = (value: unknown): value is DetachFrame =>
	isRecord(value) && value.kind === DETACH_KIND && isProcessIdString(value.processId);

export const isDispatchFrame = (value: unknown): value is DispatchFrame =>
	isRecord(value) &&
	value.kind === DISPATCH_KIND &&
	Number.isInteger(value.seq) &&
	isProcessIdString(value.processId) &&
	isMessage(value.msg);

export const isTableFrame = (value: unknown): value is TableFrame =>
	isRecord(value) &&
	value.kind === TABLE_KIND &&
	typeof value.event === "string" &&
	tableEventKinds.has(value.event) &&
	isWireRow(value.row);

export const isProcessStateFrame = (value: unknown): value is ProcessStateFrame =>
	isRecord(value) &&
	value.kind === PROCESS_STATE_KIND &&
	isProcessIdString(value.processId) &&
	isRecord(value.view) &&
	((value.view._tag === "Live" &&
		typeof value.view.lifecycle === "string" &&
		lifecycles.has(value.view.lifecycle) &&
		typeof value.view.revision === "number" &&
		"state" in value.view) ||
		value.view._tag === "ProcessGone");

export const isAttachRefusedFrame = (value: unknown): value is AttachRefusedFrame =>
	isRecord(value) &&
	value.kind === ATTACH_REFUSED_KIND &&
	isProcessIdString(value.processId) &&
	isRecord(value.refusal) &&
	((value.refusal.reason === "placement-unsupported" &&
		typeof value.refusal.placement === "string") ||
		value.refusal.reason === "no-such-process");

export const isDispatchedFrame = (value: unknown): value is DispatchedFrame =>
	isRecord(value) &&
	value.kind === DISPATCHED_KIND &&
	Number.isInteger(value.seq) &&
	isRecord(value.result) &&
	(value.result._tag === "Delivered" ||
		(value.result._tag === "ProcessGone" && isProcessIdString(value.result.processId)));

export const isWireProgram = (value: unknown): value is WireProgram =>
	isRecord(value) &&
	typeof value.programId === "string" &&
	typeof value.label === "string" &&
	isRendererRef(value.renderer);

export const isRegistryFrame = (value: unknown): value is RegistryFrame =>
	isRecord(value) &&
	value.kind === REGISTRY_KIND &&
	Array.isArray(value.programs) &&
	value.programs.every(isWireProgram);

export const isWireBinding = (value: unknown): value is WireBinding =>
	isRecord(value) &&
	typeof value.sequence === "string" &&
	typeof value.command === "string" &&
	typeof value.repeatable === "boolean";

export const isWirePrefixTable = (value: unknown): value is WirePrefixTable =>
	isRecord(value) &&
	typeof value.prefix === "string" &&
	typeof value.repeatTimeoutMs === "number" &&
	Number.isFinite(value.repeatTimeoutMs) &&
	Array.isArray(value.bindings) &&
	value.bindings.every(isWireBinding);

export const isKeysFrame = (value: unknown): value is KeysFrame =>
	isRecord(value) && value.kind === KEYS_KIND && isWirePrefixTable(value.table);

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
		predicates: ReadonlyArray<(value: unknown) => value is F>,
	) =>
	(text: string): Decoded<F> => {
		const parsed = parse(text);
		if (!parsed.ok) return undecodable("not-json");
		const value = parsed.value;
		if (!isRecord(value) || typeof value.kind !== "string" || !known.has(value.kind)) {
			return undecodable("unknown-kind");
		}
		for (const admits of predicates) {
			if (admits(value)) return {_tag: "Frame", frame: value};
		}
		// The kind is one this end serves, so the body is what failed: a payload the predicate refused.
		return undecodable("malformed-payload");
	};

export const decodeClientFrame: (text: string) => Decoded<ClientFrame> = decodeWith<ClientFrame>(
	new Set([ATTACH_KIND, DETACH_KIND, DISPATCH_KIND]),
	[isAttachFrame, isDetachFrame, isDispatchFrame],
);

export const decodeServerFrame: (text: string) => Decoded<ServerFrame> = decodeWith<ServerFrame>(
	new Set([
		TABLE_KIND,
		PROCESS_STATE_KIND,
		ATTACH_REFUSED_KIND,
		DISPATCHED_KIND,
		REGISTRY_KIND,
		KEYS_KIND,
	]),
	[
		isTableFrame,
		isProcessStateFrame,
		isAttachRefusedFrame,
		isDispatchedFrame,
		isRegistryFrame,
		isKeysFrame,
	],
);

export const encodeFrame = (frame: ClientFrame | ServerFrame): string => JSON.stringify(frame);

export const toWireRow = (row: TableRow): WireRow => ({
	id: row.id,
	programId: row.programId,
	parentId: Option.getOrNull(row.parentId),
	ports: row.ports,
	stateSummary: row.stateSummary,
});

export const fromWireRow = (row: WireRow): TableRow => ({
	id: row.id,
	programId: row.programId,
	parentId: Option.fromNullishOr(row.parentId),
	ports: row.ports,
	stateSummary: row.stateSummary,
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
