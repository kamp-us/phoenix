/**
 * The regression floor's arming sidecar — which incident-corpus cases the deterministic tier can
 * actually execute, and what each one runs (issue #4681).
 *
 * `deterministic-tier.ts` takes its `resolveCommand` from the caller, and the authored eval format
 * has no command field and gains none (#4674). So the CLI-layer command a case runs has to be
 * committed *beside* the corpus rather than inside it, and this module is that file's decoder.
 *
 * A row is a discriminated union on `status`, on `ruled-keeps.ts`'s precedent: a `pending` row
 * without a written reason is unrepresentable. That is the whole point of the shape — an incident
 * case the floor cannot yet run is a **committed admission carrying prose**, never a silence. And
 * the completeness rule that pairs with it is the gate's, not this module's: every deterministic
 * case in the corpus must appear here under one status or the other, so a case added to the corpus
 * without an arming decision reds instead of quietly leaving the floor.
 */
import {Result} from "effect";
import * as Schema from "effect/Schema";
import type {CommandResolver, DeterministicCommand, TieredEvalCase} from "./deterministic-tier.ts";

/** The corpus the regression floor is measured against (#4675), repo-relative. */
export const DEFAULT_FLOOR_CASES = "packages/fabrika-cli/src/eval/incident-corpus/evals.json";

/** The arming sidecar that sits beside it — this module's file. */
export const DEFAULT_FLOOR_COMMANDS = "packages/fabrika-cli/src/eval/incident-corpus/commands.json";

/** A case the floor executes: the CLI-layer command, exactly as the tier's observer spawns it. */
const ArmedRow = Schema.Struct({
	status: Schema.Literal("armed"),
	caseId: Schema.Int,
	command: Schema.String,
	args: Schema.Array(Schema.String),
	cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
	timeoutMs: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});

/** A case the floor cannot run yet. `pendingReason` is required: it quotes what is owed. */
const PendingRow = Schema.Struct({
	status: Schema.Literal("pending"),
	caseId: Schema.Int,
	pendingReason: Schema.String,
});

const FloorRow = Schema.Union([ArmedRow, PendingRow]);

export const FloorCommandsFile = Schema.Struct({
	corpus: Schema.String,
	rows: Schema.Array(FloorRow),
});

export type FloorRow = typeof FloorRow.Type;
export type FloorCommands = typeof FloorCommandsFile.Type;

export class FloorCommandsError extends Schema.TaggedErrorClass<FloorCommandsError>()(
	"FloorCommandsError",
	{
		reason: Schema.Literals(["malformed-json", "schema-mismatch", "duplicate-case"]),
		message: Schema.String,
	},
) {}

const decodeUnknown = Schema.decodeUnknownResult(FloorCommandsFile);

/**
 * Decode the sidecar. Total — every rejection is a typed failure, never a throw.
 *
 * The duplicate check is here rather than in the schema because two rows for one case id is the one
 * malformation a well-typed file can still carry: whichever row won would decide whether the case
 * runs, and "which of these two is in force" is not a question the floor may answer by ordering.
 */
export const decodeFloorCommands = (
	text: string,
): Result.Result<FloorCommands, FloorCommandsError> =>
	Result.try({
		try: (): unknown => JSON.parse(text),
		catch: (cause) =>
			new FloorCommandsError({
				reason: "malformed-json",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	}).pipe(
		Result.flatMap((parsed) =>
			decodeUnknown(parsed).pipe(
				Result.mapError(
					(error) => new FloorCommandsError({reason: "schema-mismatch", message: error.message}),
				),
			),
		),
		Result.flatMap((file) => {
			const seen = new Set<number>();
			for (const row of file.rows) {
				if (seen.has(row.caseId)) {
					return Result.fail(
						new FloorCommandsError({
							reason: "duplicate-case",
							message: `two rows claim case ${row.caseId} — one case carries one arming decision`,
						}),
					);
				}
				seen.add(row.caseId);
			}
			return Result.succeed(file);
		}),
	);

/** The armed rows, keyed by case id. */
export const armedRows = (file: FloorCommands): ReadonlyMap<number, DeterministicCommand> => {
	const armed = new Map<number, DeterministicCommand>();
	for (const row of file.rows) {
		if (row.status !== "armed") continue;
		armed.set(row.caseId, {
			command: row.command,
			args: row.args,
			cwd: row.cwd ?? null,
			timeoutMs: row.timeoutMs ?? null,
		});
	}
	return armed;
};

/** The pending rows and the prose each one owes, keyed by case id. */
export const pendingRows = (file: FloorCommands): ReadonlyMap<number, string> => {
	const pending = new Map<number, string>();
	for (const row of file.rows) {
		if (row.status === "pending") pending.set(row.caseId, row.pendingReason);
	}
	return pending;
};

/**
 * The tier's `resolveCommand`, bound to a decoded sidecar.
 *
 * An unarmed case resolves `null`, which the tier reds as `uncheckable` rather than skipping — so
 * routing a pending case here would fail the floor. The gate never does: it hands the tier only the
 * armed cases, and accounts for the pending ones separately.
 */
export const commandResolverOf = (file: FloorCommands): CommandResolver => {
	const armed = armedRows(file);
	return (evalCase: TieredEvalCase): DeterministicCommand | null => armed.get(evalCase.id) ?? null;
};
