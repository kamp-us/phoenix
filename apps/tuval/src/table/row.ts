/**
 * The program-blind row every projection reads. A row names its program by id and summarizes its
 * state as lifecycle plus revision; nothing on it depends on which program runs, so a consumer
 * tells a Pi process from a Claude one by `programId` and by nothing else (#7498's stated risk).
 */

import {Option, Predicate} from "effect";
import type {Lifecycle, ProcessId, ProcessRow} from "../process/process.ts";
import type {ProgramId} from "../registry/program.ts";

/** A declared port as data: its kind and direction, never its predicate or queue. */
export interface PortDeclaration {
	readonly kind: string;
	readonly direction: "in" | "out";
}

export interface TableStateSummary {
	readonly lifecycle: Lifecycle;
	/** Committed transitions since the row appeared. Moves on every commit, says nothing of the state. */
	readonly revision: number;
}

export interface TableRow {
	readonly id: ProcessId;
	readonly programId: ProgramId;
	readonly parentId: Option.Option<ProcessId>;
	readonly ports: Readonly<Record<string, PortDeclaration>>;
	readonly stateSummary: TableStateSummary;
}

export type TableEventKind = "spawned" | "stopped" | "state-changed";

/** One change, carrying the row as it read at that moment; a `stopped` row has left the table. */
export interface TableEvent {
	readonly kind: TableEventKind;
	readonly row: TableRow;
}

export const toTableRow = (row: ProcessRow): TableRow => {
	const {lifecycle, revision} = row.stateSummary();
	const ports: Record<string, PortDeclaration> = {};
	for (const [name, port] of Object.entries(row.ports)) {
		ports[name] = {kind: port.kind, direction: port.direction};
	}
	return {
		id: row.id,
		programId: row.programId,
		parentId: row.parentId,
		ports,
		stateSummary: {lifecycle, revision},
	};
};

const kinds: ReadonlySet<string> = new Set<TableEventKind>(["spawned", "stopped", "state-changed"]);
const lifecycles: ReadonlySet<string> = new Set<Lifecycle>(["running", "stopping"]);

const isPortDeclaration = (value: unknown): value is PortDeclaration =>
	Predicate.isObject(value) &&
	typeof value.kind === "string" &&
	(value.direction === "in" || value.direction === "out");

const isStateSummary = (value: unknown): value is TableStateSummary =>
	Predicate.isObject(value) &&
	typeof value.lifecycle === "string" &&
	lifecycles.has(value.lifecycle) &&
	typeof value.revision === "number";

export const isTableRow = (value: unknown): value is TableRow =>
	Predicate.isObject(value) &&
	typeof value.id === "string" &&
	typeof value.programId === "string" &&
	Option.isOption(value.parentId) &&
	Predicate.isObjectOrArray(value.ports) &&
	Object.values(value.ports).every(isPortDeclaration) &&
	isStateSummary(value.stateSummary);

/** The port predicate: the wire is nominal kind plus predicate, and this is the predicate. */
export const isTableEvent = (value: unknown): value is TableEvent =>
	Predicate.isObject(value) &&
	typeof value.kind === "string" &&
	kinds.has(value.kind) &&
	isTableRow(value.row);
