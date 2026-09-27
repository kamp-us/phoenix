/**
 * Desk layers for loader tests, which read rows by id and must not build the real shell. Not a
 * config module: it has no default export, and the loader never imports it.
 */

import {fileURLToPath} from "node:url";
import {NodeId} from "@kampus/tuval-sdk/kernel/ports/graph";
import {type AnyProgram, ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {defaultPrefixTable} from "@kampus/tuval-ui/keys";
import type {DeskLayer} from "../config.ts";

const origin = fileURLToPath(import.meta.url);

/** A desk that supplies nothing, for a test about the file layers alone. */
export const noDesk: DeskLayer = {
	origin,
	programs: [],
	graph: {nodes: []},
	table: defaultPrefixTable,
};

/** One opaque row and its node, standing in for the shell under the ids a fixture can redeclare. */
export const fixtureDesk: DeskLayer = {
	origin,
	programs: [{id: ProgramId.make("desk")} as AnyProgram],
	graph: {nodes: [{id: NodeId.make("desk"), program: ProgramId.make("desk"), on: []}]},
	table: defaultPrefixTable,
};
