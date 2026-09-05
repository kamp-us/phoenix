/**
 * The `ps` registry row: an ordinary program (founder ruling 1), spawned, split and closed like any
 * other, whose window renderer is the process table.
 *
 * The row carries a `RendererRef` and not a renderer, because a row is kernel-side data that must
 * stay free of React (`../../page/renderers.tsx` says why the page's own table is keyed by program
 * id). `./renderer.tsx` mints the typed `WindowRenderer` this reference names, and the shell's
 * `resolverFromTable` refuses a table entry whose `kind` disagrees with this one.
 *
 * No ports and no host handlers: the table reads `Snapshot.processes` on the page, so this process
 * subscribes to nothing and asks the kernel for nothing. Its state is the sort and the selection,
 * and the kernel checkpoints it like any other program's.
 */

import type {Cmd} from "@demlik/tea";
import {
	type AnyProgram,
	type Program,
	ProgramId,
	type RendererRef,
} from "../../registry/program.ts";
import {type PsMsg, type PsState, psCore} from "./state.ts";

export const psId = ProgramId.make("ps");

/** The name the page's renderer table resolves. Its `kind` is what a mismatched entry is refused on. */
export const PS_RENDERER_REF = "tuval/ps";

export const psRendererRef: RendererRef = {kind: "host-native", ref: PS_RENDERER_REF};

export const psProgram: AnyProgram = {
	id: psId,
	label: "Process table",
	core: psCore,
	ports: {},
	handlers: {},
	capabilities: [],
	renderer: psRendererRef,
	identity: {
		package: "@kampus/tuval",
		program: "ps",
		version: "1.0.0",
		digest: "sha256:ps",
	},
	placement: {host: "local"},
} satisfies Program<PsState, PsMsg, Cmd<never>, never, unknown, never, never>;
