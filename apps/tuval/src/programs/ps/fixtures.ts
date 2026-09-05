/**
 * Wire-shaped rows the `ps` tests read. They are `ProcessRow`s — the `Snapshot.processes` element —
 * rather than kernel `TableRow`s, because the whole claim under test is that the table works from
 * the snapshot and nothing else, and a fixture that started at the kernel's row would skip the one
 * seam that proves it.
 */

import {ProcessId, ProgramId} from "../../protocol/ids.ts";
import type {PortDeclaration, ProcessRow} from "../../protocol/process-row.ts";

export const processId = (id: string): ProcessId => ProcessId.make(id);

export interface RowOptions {
	readonly program?: string;
	readonly parent?: string | null;
	readonly ports?: Readonly<Record<string, PortDeclaration>>;
	readonly lifecycle?: "running" | "stopping";
	readonly revision?: number;
	readonly recency?: number;
}

export const row = (id: string, options: RowOptions = {}): ProcessRow => ({
	id: processId(id),
	programId: ProgramId.make(options.program ?? "counter"),
	parentId:
		options.parent === undefined || options.parent === null ? null : processId(options.parent),
	ports: options.ports ?? {},
	stateSummary: {lifecycle: options.lifecycle ?? "running", revision: options.revision ?? 0},
	recency: options.recency ?? 0,
});

/**
 * Two roots and a three-deep branch under the first, in an order the kernel would not have sent —
 * children before parents, roots interleaved — so a test that passes is a test the ordering did.
 */
export const twoRootForest: ReadonlyArray<ProcessRow> = [
	row("grandchild-a1", {parent: "child-a1", program: "log", revision: 7}),
	row("root-b", {program: "log", revision: 3}),
	row("child-a2", {parent: "root-a", revision: 12}),
	row("root-a", {revision: 1}),
	row("child-b1", {parent: "root-b", program: "shell", revision: 3}),
	row("child-a1", {
		parent: "root-a",
		program: "shell",
		revision: 3,
		ports: {
			transcript: {kind: "tuval/transcript", direction: "out"},
			prompt: {kind: "tuval/prompt", direction: "in"},
			cancel: {kind: "tuval/prompt", direction: "in"},
		},
	}),
];

/** Three rows whose lifecycle and revision are identical, so only the default order can break a tie. */
export const tiedRows: ReadonlyArray<ProcessRow> = [
	row("root-a", {program: "counter", revision: 4}),
	row("child-a1", {parent: "root-a", program: "counter", revision: 4}),
	row("child-a2", {parent: "root-a", program: "counter", revision: 4}),
];
