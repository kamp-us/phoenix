/**
 * The reload proof's config layer. Which programs it registers, which spells each one declares and
 * which keys are bound to them are read at import from the JSON file `TUVAL_RELOAD_FIXTURE` names,
 * so rewriting that file and loading the config again is a config change — the module stays put and
 * nothing has to be kept in step with it.
 */

import {readFileSync} from "node:fs";
import {defineMachine} from "@demlik/tea";
import {Effect, Schema} from "effect";
import {defineSpell} from "../commands/spell.ts";
import type {TuvalConfigInput} from "../config.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";

/** One generation of the fixture: what the JSON file holds. */
export interface DeclaredConfig {
	readonly programs: ReadonlyArray<{readonly id: string; readonly spells: ReadonlyArray<string>}>;
	readonly keys: Readonly<Record<string, string>>;
}

type State = {readonly seen: number};
type Msg = {readonly type: "tick"};
type Notify = {readonly type: "notify"};

const spellNamed = (name: string) =>
	defineSpell({
		path: [name],
		describe: `Answer with the name of this spell, which is "${name}".`,
		params: Schema.Struct({}),
		result: Schema.Struct({name: Schema.String}),
		execute: () => Effect.succeed({name}),
		capabilities: [],
	});

const program = (row: DeclaredConfig["programs"][number]): AnyProgram =>
	({
		id: ProgramId.make(row.id),
		core: defineMachine<State, Msg, Notify, never, unknown>({
			init: (loaded) => [loaded ?? {seen: 0}, []],
			update: {tick: (state) => [{seen: state.seen + 1}, []]},
			interpret: {notify: () => Promise.resolve()},
		}),
		ports: {},
		handlers: {notify: () => Effect.succeed([] as ReadonlyArray<Msg>)},
		spells: row.spells.map(spellNamed),
		capabilities: [],
		identity: {
			package: "@kampus/tuval",
			program: row.id,
			version: "1.0.0",
			digest: `sha256:${row.id}`,
		},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Notify, never, unknown, never, never>;

const declared = JSON.parse(
	readFileSync(process.env.TUVAL_RELOAD_FIXTURE ?? "", "utf8"),
) as DeclaredConfig;

export default {
	version: 1,
	programs: declared.programs.map(program),
	keys: declared.keys,
} satisfies TuvalConfigInput;
