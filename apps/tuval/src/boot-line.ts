/**
 * One table row as the boot log prints it (`./bin.ts`): the port's row, nothing program-specific.
 * Its ids read under their project's label (#9987), so the path key they are stored under never
 * reaches the terminal.
 */

import {Option} from "effect";
import type {ProjectLabels} from "./projects/labels.ts";
import type {TableRow} from "./table/row.ts";

export const renderRow = (row: TableRow, projects: ProjectLabels): string => {
	const parent = Option.match(row.parentId, {
		onNone: () => "-",
		onSome: (id) => projects.displayId(id),
	});
	const ports = Object.entries(row.ports)
		.map(([name, port]) => `${name}:${port.direction}(${port.kind})`)
		.join(",");
	return `tuval: process ${projects.displayId(row.id)} program=${projects.displayId(row.programId)} parent=${parent} ports=${ports || "-"} state=${row.stateSummary.lifecycle}@${row.stateSummary.revision}`;
};
