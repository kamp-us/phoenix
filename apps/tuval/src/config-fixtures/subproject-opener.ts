/**
 * The subproject fixtures' program (#9689): it opens and closes subprojects when told to, keeps the
 * folders it opened in its checkpoint and opens them again on a restore, and tries to reach a named
 * process, writing what the boundary answered into its state. Each config that plans it names it
 * with its own id, so one project can hold an opener beside a bystander.
 */

import {defineMachine} from "@demlik/tea";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {
	closeSubproject,
	guardReach,
	openSubproject,
} from "@kampus/tuval-sdk/kernel/process/subprojects";
import {type AnyProgram, type Program, ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Effect} from "effect";

export interface OpenerState {
	readonly opened: ReadonlyArray<string>;
	/** `"reached"`, or the refusal's message, for the last `reach`. */
	readonly reach: string | null;
}

type Msg =
	| {readonly type: "open"; readonly folder: string}
	| {readonly type: "close"; readonly folder: string}
	| {readonly type: "reach"; readonly process: string}
	| {readonly type: "reached"; readonly outcome: string};

type Cmd =
	| {readonly type: "subproject.open"; readonly folder: string}
	| {readonly type: "subproject.close"; readonly folder: string}
	| {readonly type: "reach"; readonly process: string};

const reopen = (state: OpenerState): ReadonlyArray<Cmd> =>
	state.opened.map((folder) => ({type: "subproject.open", folder}));

export const openerProgram = (id: string): AnyProgram =>
	({
		id: ProgramId.make(id),
		core: defineMachine<OpenerState, Msg, Cmd, never, unknown>({
			init: (loaded) => {
				const state = (loaded as OpenerState | null) ?? {opened: [], reach: null};
				return [state, reopen(state)];
			},
			update: {
				open: (state, msg) => [
					{...state, opened: [...state.opened, msg.folder]},
					[{type: "subproject.open", folder: msg.folder}],
				],
				close: (state, msg) => [
					{...state, opened: state.opened.filter((folder) => folder !== msg.folder)},
					[{type: "subproject.close", folder: msg.folder}],
				],
				reach: (state, msg) => [state, [{type: "reach", process: msg.process}]],
				reached: (state, msg) => [{...state, reach: msg.outcome}, []],
			},
		}),
		ports: {},
		handlers: {
			"subproject.open": (cmd: Extract<Cmd, {type: "subproject.open"}>) =>
				Effect.as(openSubproject(cmd.folder), [] as ReadonlyArray<Msg>),
			"subproject.close": (cmd: Extract<Cmd, {type: "subproject.close"}>) =>
				Effect.as(closeSubproject(cmd.folder), [] as ReadonlyArray<Msg>),
			reach: (cmd: Extract<Cmd, {type: "reach"}>) =>
				guardReach(ProcessId.make(cmd.process)).pipe(
					Effect.as("reached"),
					Effect.catch((refused) => Effect.succeed(refused.message)),
					Effect.map((outcome): ReadonlyArray<Msg> => [{type: "reached", outcome}]),
				),
		},
		capabilities: [],
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: "sha256:x"},
		placement: {host: "local"},
	}) satisfies Program<OpenerState, Msg, Cmd, never, unknown, unknown, never>;
