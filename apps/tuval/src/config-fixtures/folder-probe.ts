import {defineMachine} from "@demlik/tea";
import {WorkingFolder} from "@kampus/tuval-sdk/kernel/process/working-folder";
import type {AnyProgram, Program} from "@kampus/tuval-sdk/kernel/registry/program";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Effect, Option} from "effect";

type State = {readonly folder: string | null};
type Msg = {readonly type: "found"; readonly folder: string | null};
type Probe = {readonly type: "probe"};

/**
 * One planned program that writes the folder it runs in into its own state, for the tests that
 * read which folder a project's process was started in (#9694).
 */
const probe = {
	id: ProgramId.make("probe"),
	core: defineMachine<State, Msg, Probe, never, unknown>({
		init: (loaded) => (loaded === null ? [{folder: null}, [{type: "probe"}]] : [loaded, []]),
		update: {found: (_state, msg) => [{folder: msg.folder}, []]},
	}),
	ports: {},
	handlers: {
		probe: () =>
			Effect.map(Effect.serviceOption(WorkingFolder), (folder) => [
				{type: "found", folder: Option.getOrNull(Option.map(folder, (held) => held.path))} as const,
			]),
	},
	capabilities: [],
	identity: {package: "@kampus/tuval", program: "probe", version: "1.0.0", digest: "sha256:x"},
	placement: {host: "local"},
} satisfies Program<State, Msg, Probe, never, unknown, never, never>;

const programs: ReadonlyArray<AnyProgram> = [probe];

export default {version: 1, programs, graph: {nodes: [{id: "probe", program: "probe", on: []}]}};
