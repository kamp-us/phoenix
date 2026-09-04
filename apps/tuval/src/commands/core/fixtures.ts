/**
 * The scripted registry the discovery spells are tested against: the three real core spells, a
 * `window` group with the three shapes a usage column has to render, and one program's spells so
 * the grouping is exercised over both sources.
 */

import {type Cmd, defineMachine} from "@demlik/tea";
import {Effect, Schema} from "effect";
import {type AnyProgram, type Program, ProgramId} from "../../registry/program.ts";
import {buildRegistry} from "../registry.ts";
import {type AnySpell, ClientId, defineSpell, type Scope, WorkspaceId} from "../spell.ts";
import {helpSpells} from "./index.ts";

export const scope: Scope = {
	workspace: WorkspaceId.make("ws-1"),
	client: ClientId.make("cli"),
};

export const windowClose = defineSpell({
	path: ["window", "close"],
	describe: "Close the focused window",
	params: Schema.Struct({}),
	result: Schema.Struct({closed: Schema.Boolean}),
	execute: () => Effect.succeed({closed: true}),
	capabilities: [],
});

export const windowSwap = defineSpell({
	path: ["window", "swap"],
	describe: "Swap with the neighbour: left|right|up|down",
	params: Schema.Struct({dir: Schema.String}),
	result: Schema.Struct({swapped: Schema.Boolean}),
	execute: () => Effect.succeed({swapped: true}),
	capabilities: [],
});

export const windowFocus = defineSpell({
	path: ["window", "focus"],
	describe: "Focus the neighbour in one direction",
	params: Schema.Struct({
		direction: Schema.Literals(["left", "right", "up", "down"]),
		count: Schema.optionalKey(Schema.String),
	}),
	result: Schema.Struct({focused: Schema.Boolean}),
	execute: () => Effect.succeed({focused: true}),
	capabilities: [],
});

export const windowSpells: ReadonlyArray<AnySpell> = [windowClose, windowSwap, windowFocus];

const machine = defineMachine<
	{readonly count: number},
	{readonly type: "tick"},
	Cmd<never>,
	never,
	unknown
>({
	init: (loaded) => [loaded ?? {count: 0}, []],
	update: {tick: (state) => [{count: state.count + 1}, []]},
});

export const program = (id: string, spells: ReadonlyArray<AnySpell>): AnyProgram =>
	({
		id: ProgramId.make(id),
		core: machine,
		ports: {},
		handlers: {},
		spells,
		capabilities: [],
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host: "local"},
	}) satisfies Program<
		{readonly count: number},
		{readonly type: "tick"},
		Cmd<never>,
		never,
		unknown,
		never,
		never
	>;

const save = defineSpell({
	path: ["save"],
	describe: "Write the buffer to disk",
	params: Schema.Struct({}),
	result: Schema.Struct({saved: Schema.Boolean}),
	execute: () => Effect.succeed({saved: true}),
	capabilities: [],
});

const bufferNext = defineSpell({
	path: ["buffer", "next"],
	describe: "Show the next buffer",
	params: Schema.Struct({}),
	result: Schema.Struct({shown: Schema.Boolean}),
	execute: () => Effect.succeed({shown: true}),
	capabilities: [],
});

/** The whole table: the three discovery spells, the window group, and one program's two spells. */
export const table = buildRegistry({
	core: [...helpSpells, ...windowSpells],
	programs: [program("editor", [save, bufferNext])],
});

/** The same table with the window group gone — what a config reload swaps in. */
export const smallerTable = buildRegistry({core: [...helpSpells], programs: []});
