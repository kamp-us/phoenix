/**
 * "Ask every registered ai-agent implementation", as a real call — the seam ruling 5 (#8070)
 * assumes and source did not have.
 *
 * `TuvalAiAgent` is a `Context.Service` with one layer per backend and nothing holds those layers
 * as a set. Program rows, though, are already enumerable: `Registry.list` is the one collection the
 * kernel keeps, and every agent row is built by `aiAgentProgram`, which stamps `aiAgent` on it. So
 * the set of backends is derived from the registry rather than maintained beside it, and a fourth
 * backend joins this answer by being registered in the config and by nothing else.
 *
 * `isAiAgentBackend` is shaped like `showsInAWindow` (`../shell/picker/entries.ts`) on purpose: an
 * absent field is the whole test, and a caller that filters with it holds rows the checker agrees
 * carry a layer. The two predicates are independent and stay that way — a headless agent row has a
 * session store like any other, and whether it can bind a window is the other predicate's question.
 */

import {type Cause, Context, Effect, Layer} from "effect";
import {type AnyProgram, type ProgramId, provenanceOf} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import type {AiAgentBackend} from "./program.ts";
import {type ListError, newestFirst, type SessionSummary, TuvalAiAgent} from "./service/index.ts";

/** A registry row that declares a backend: what `isAiAgentBackend` admits. */
export type AiAgentBackendRow = AnyProgram & {readonly aiAgent: AiAgentBackend<any>};

export const isAiAgentBackend = (row: AnyProgram): row is AiAgentBackendRow =>
	(row as Partial<AiAgentBackendRow>).aiAgent !== undefined;

export const aiAgentBackends = (
	rows: ReadonlyArray<AnyProgram>,
): ReadonlyArray<AiAgentBackendRow> => rows.filter(isAiAgentBackend);

/** The registered backends, in registration order. Never fails: a desk with none registers none. */
export const readAiAgentBackends: Effect.Effect<
	ReadonlyArray<AiAgentBackendRow>,
	never,
	Registry
> = Effect.gen(function* () {
	const registry = yield* Registry;
	return aiAgentBackends(yield* registry.list);
});

/** One backend that could not answer, named so a surface can say which store is missing. */
export interface BackendListFailure {
	readonly programId: ProgramId;
	/** `package/program@version (digest)` — the row's own provenance, as a refusal names it. */
	readonly provenance: string;
	/**
	 * A `Cause` rather than a `ListError`, because a backend has two ways to fail to answer: its
	 * store refuses the read, or its layer dies standing the transport up. Both are this backend
	 * failing to answer, and neither may reach the other backends' rows.
	 */
	readonly cause: Cause.Cause<ListError>;
}

/**
 * One backend's session, attributed to the registry row it was read through.
 *
 * `programId` is the routing key and `backend` is the display tag (ruling 6), and they are two
 * fields because they are two different strings: `pi-session` is the row a spawn or a transcript
 * read has to name, `pi` is what the row's meta line says. Only this module can stamp the first —
 * a backend's layer does not know which id it was registered under — so a session gains it here,
 * on the way out of the one call that holds the row.
 */
export interface AiAgentSession extends SessionSummary {
	/** The registered program row's id: what a transcript read and a first-send spawn name. */
	readonly programId: ProgramId;
}

export interface AiAgentSessions {
	/** Every answering backend's sessions as one list, newest first, as the port declares. */
	readonly sessions: ReadonlyArray<AiAgentSession>;
	readonly failures: ReadonlyArray<BackendListFailure>;
}

type Outcome =
	| {readonly _tag: "listed"; readonly sessions: ReadonlyArray<AiAgentSession>}
	| {readonly _tag: "refused"; readonly failure: BackendListFailure};

const askOne = (row: AiAgentBackendRow, services: Context.Context<never>): Effect.Effect<Outcome> =>
	Effect.scoped(
		Effect.gen(function* () {
			// Erased and provided exactly as the spawner does a row's handlers
			// (`../process/Processes.ts`): an `AnyProgram`'s leftover requirement is `any`, and
			// `services` is the kernel context that satisfies it — the same one a spawn of this row
			// would run under (#7951).
			const built = yield* Layer.build(row.aiAgent.layer as Layer.Layer<TuvalAiAgent>);
			return yield* Context.get(built, TuvalAiAgent).listSessions;
		}),
	).pipe(
		Effect.provideContext(services),
		Effect.map(
			(sessions): Outcome => ({
				_tag: "listed",
				sessions: sessions.map((session) => ({...session, programId: row.id})),
			}),
		),
		Effect.catchCause((cause) =>
			Effect.succeed<Outcome>({
				_tag: "refused",
				failure: {programId: row.id, provenance: provenanceOf(row), cause},
			}),
		),
	);

/**
 * Every registered backend's sessions as one newest-first list, plus the backends that could not
 * answer. A failing store is reported beside the others' rows and never in place of them: an empty
 * list has to keep meaning "you have no sessions".
 *
 * The backends are asked one at a time. Each ask builds a real transport — a model runtime, a CLI —
 * and there are as many builds here as the config registered rows, so nothing is bought by standing
 * them all up at once.
 */
export const listAiAgentSessions = (
	services: Context.Context<never>,
): Effect.Effect<AiAgentSessions, never, Registry> =>
	Effect.gen(function* () {
		const rows = yield* readAiAgentBackends;
		const outcomes = yield* Effect.forEach(rows, (row) => askOne(row, services), {
			concurrency: 1,
		});
		return {
			sessions: newestFirst(
				outcomes.flatMap((outcome) => (outcome._tag === "listed" ? outcome.sessions : [])),
			),
			failures: outcomes.flatMap((outcome) =>
				outcome._tag === "refused" ? [outcome.failure] : [],
			),
		};
	});
