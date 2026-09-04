/** Rows the projection and layout tests read: a two-root forest, and a process with many ports. */

import {Option} from "effect";
import {ProcessId, ProgramId} from "../../protocol/ids.ts";
import type {PortDeclaration, TableRow} from "../../table/row.ts";

export const processId = (id: string): ProcessId => ProcessId.make(id);

export const row = (
	id: string,
	parent: string | null,
	ports: Readonly<Record<string, PortDeclaration>> = {},
	revision = 0,
): TableRow => ({
	id: processId(id),
	programId: ProgramId.make("counter"),
	parentId: parent === null ? Option.none() : Option.some(processId(parent)),
	ports,
	stateSummary: {lifecycle: "running", revision},
});

/**
 * Two roots and a three-deep branch under the first, which is the shape a process table takes the
 * moment a user spawns two unrelated programs and one of them spawns children.
 */
export const twoRootForest: ReadonlyArray<TableRow> = [
	row("root-a", null),
	row("child-a1", "root-a"),
	row("child-a2", "root-a"),
	row("grandchild-a1", "child-a1"),
	row("root-b", null),
	row("child-b1", "root-b"),
];

const wide: Readonly<Record<string, PortDeclaration>> = {
	"transcript-out-with-a-very-long-declared-name": {kind: "tuval/transcript", direction: "out"},
	"prompt-in-with-a-very-long-declared-name": {kind: "tuval/prompt", direction: "in"},
	"diagnostics-out-with-a-very-long-declared-name": {kind: "tuval/diagnostic", direction: "out"},
	"cancel-in-with-a-very-long-declared-name": {kind: "tuval/cancel", direction: "in"},
};

/** One narrow root beside a child whose port list is far wider than the minimum box. */
export const widePortForest: ReadonlyArray<TableRow> = [
	row("root-a", null),
	row("child-a1", "root-a", wide),
	row("child-a2", "root-a"),
];
