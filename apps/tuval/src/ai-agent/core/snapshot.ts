/**
 * Reading a checkpoint back: the predicate over one saved `AiAgentSessionState`, and the `null`
 * refusal Demlik's `Store.migrate` contract asks for (`src/durability/snapshot.ts` takes the same
 * shape over the envelope this state travels inside).
 *
 * A predicate rather than a second `effect/Schema` copy of the item union: `ports/` already owns
 * the admission test for every shape here and declares itself "not a schema system", so a schema
 * beside it would be a second source that drifts. Composing the port predicates keeps one.
 */

import {Predicate} from "effect";
import {
	isCommandRef,
	isModelRef,
	isPendingPermission,
	isSubagentSlots,
	isThinkingLevel,
	isTranscriptItems,
	isWindowOmission,
	type PendingPermission,
} from "../ports/index.ts";
import {checkpointUnreadable} from "./failures.ts";
import {
	type AiAgentSessionState,
	checkpointFields,
	type HistoryPage,
	type Interruption,
	initialState,
	phases,
	restore,
	type TurnUsage,
	type UsageLedger,
	type UsageTotals,
} from "./state.ts";

const isNullOrString = (value: unknown): value is string | null =>
	value === null || typeof value === "string";

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isAbsentOrString = (value: unknown): boolean =>
	value === undefined || typeof value === "string";

/**
 * The booted-on account, whose two fields are each optional.
 *
 * The `email` clause is the founder's org-and-plan-only ruling held at the parse boundary (#8649):
 * `AgentAccount` declares no such field, so nothing in this process can write one, and a checkpoint
 * that carries one was not written by this program and is not a session this program will load.
 */
const isNullOrAccount = (value: unknown): boolean =>
	value === null ||
	(Predicate.isObject(value) &&
		value.email === undefined &&
		isAbsentOrString(value.organization) &&
		isAbsentOrString(value.subscriptionType));

/** The flat totals a checkpoint written before usage was keyed by turn carries; see `withUsageLedger`. */
const isFlatUsage = (value: unknown): value is UsageTotals =>
	Predicate.isObject(value) &&
	isNullOrString(value.model) &&
	isFiniteNumber(value.inputTokens) &&
	isFiniteNumber(value.outputTokens) &&
	isFiniteNumber(value.cost);

const isTurnUsage = (value: unknown): value is TurnUsage =>
	Predicate.isObject(value) &&
	isFiniteNumber(value.inputTokens) &&
	isFiniteNumber(value.outputTokens) &&
	isFiniteNumber(value.cost);

const isUsage = (value: unknown): value is UsageLedger =>
	Predicate.isObject(value) &&
	isNullOrString(value.model) &&
	Predicate.isObject(value.turns) &&
	Object.values(value.turns).every(isTurnUsage);

const isPermissions = (value: unknown): value is Readonly<Record<string, PendingPermission>> =>
	Predicate.isObject(value) && Object.values(value).every(isPendingPermission);

const isModes = (value: unknown): boolean =>
	Predicate.isObject(value) &&
	isNullOrString(value.current) &&
	Array.isArray(value.available) &&
	value.available.every((mode) => typeof mode === "string");

const isModels = (value: unknown): boolean =>
	Predicate.isObject(value) &&
	(value.current === null || isModelRef(value.current)) &&
	Array.isArray(value.available) &&
	value.available.every(isModelRef);

const isCommands = (value: unknown): boolean => Array.isArray(value) && value.every(isCommandRef);
const isThinking = (value: unknown): boolean =>
	Predicate.isObject(value) &&
	(value.current === null || isThinkingLevel(value.current)) &&
	Array.isArray(value.available) &&
	value.available.every(isThinkingLevel);

const isTranscript = (value: unknown): boolean =>
	Predicate.isObject(value) && isTranscriptItems(value.items) && isWindowOmission(value.omitted);

const isPage = (value: unknown): value is HistoryPage | null =>
	value === null ||
	(Predicate.isObject(value) &&
		isTranscriptItems(value.items) &&
		typeof value.hasMore === "boolean");

const isInterruption = (value: unknown): value is Interruption | null =>
	value === null || (Predicate.isObject(value) && isFiniteNumber(value.requestedAt));

const isFailure = (value: unknown): boolean =>
	value === null ||
	(Predicate.isObject(value) &&
		typeof value.tag === "string" &&
		isNullOrString(value.reason) &&
		typeof value.detail === "string");

const isPageOutcome = (value: unknown): boolean =>
	value === null ||
	(Predicate.isObject(value) &&
		((value.status === "success" && value.page !== null && isPage(value.page)) ||
			(value.status === "refused" && value.failure !== null && isFailure(value.failure))));

const sendStates: ReadonlyArray<string> = ["pending", "accepted", "refused", "uncertain"];

/**
 * A settled send's failure is the one field the state's arms disagree on, so each arm is checked
 * for what its own type declares: `refused` carries a failure, `uncertain` carries one or `null`,
 * and `pending` and `accepted` carry no such field at all.
 */
const sendFailure = (state: string, value: unknown): boolean => {
	if (state === "refused") return value !== null && isFailure(value);
	if (state === "uncertain") return isFailure(value);
	return true;
};

const isSend = (value: unknown): boolean =>
	Predicate.isObject(value) &&
	typeof value.key === "string" &&
	typeof value.state === "string" &&
	sendStates.includes(value.state) &&
	sendFailure(value.state, value.failure);

const isSends = (value: unknown): boolean => Array.isArray(value) && value.every(isSend);

const isQueuedPrompt = (value: unknown): boolean =>
	Predicate.isObject(value) &&
	typeof value.key === "string" &&
	typeof value.text === "string" &&
	isFiniteNumber(value.timestamp);

const isQueued = (value: unknown): boolean => Array.isArray(value) && value.every(isQueuedPrompt);

export const isAiAgentSessionState = (value: unknown): value is AiAgentSessionState =>
	Predicate.isObject(value) &&
	typeof value.phase === "string" &&
	(phases as ReadonlyArray<string>).includes(value.phase) &&
	isNullOrString(value.sessionId) &&
	isFiniteNumber(value.connection) &&
	typeof value.cwd === "string" &&
	isTranscript(value.transcript) &&
	isNullOrString(value.interrupted) &&
	isInterruption(value.interruption) &&
	isUsage(value.usage) &&
	isNullOrString(value.agentVersion) &&
	isNullOrAccount(value.account) &&
	isPermissions(value.permissions) &&
	isFiniteNumber(value.permissionsRaised) &&
	isModes(value.modes) &&
	isModels(value.models) &&
	isCommands(value.commands) &&
	isThinking(value.thinking) &&
	isNullOrString(value.lastPrompt) &&
	isSends(value.sends) &&
	isQueued(value.queued) &&
	isPage(value.lastPage) &&
	isPageOutcome(value.pageOutcome) &&
	isSubagentSlots(value.subagents) &&
	isFailure(value.failure);

/** A snapshot the predicate refuses is `null`, never a throw — the store decides what to do. */
export const parseSessionState = (raw: unknown): AiAgentSessionState | null =>
	isAiAgentSessionState(raw) ? raw : null;

/**
 * An absent field takes its empty default, so a checkpoint written before that field landed is
 * still a session (#8095).
 *
 * Nothing filled one before, and the load path trusted the type instead: a desk that had saved
 * before `commands` landed came back with `commands: undefined`, which emptied the slash-command
 * picker, and with `permissionsRaised: undefined`, which made `permissionsRaised + 1` `NaN` from
 * the first card onward. `JSON` then dropped the `undefined` key on the save that follows `init`,
 * so the hole was written back over the checkpoint.
 *
 * Derived, never a second list: `checkpointFields` is the field set and `initialState` is the
 * defaults, so the next field added to the state is filled by this same walk. It supplies what is
 * absent and repairs nothing — a field saved with the wrong type stays wrong, and
 * `parseSessionState` still refuses it.
 */
export const withCheckpointDefaults = (raw: unknown, cwd: string): unknown => {
	if (!Predicate.isObject(raw)) return raw;
	const absent = checkpointFields.filter((field) => raw[field] === undefined);
	if (absent.length === 0) return raw;
	const defaults = initialState(cwd);
	return {...raw, ...Object.fromEntries(absent.map((field) => [field, defaults[field]]))};
};

/**
 * The one entry a pre-ledger checkpoint's totals come back as. Reserved: no backend mints it.
 */
export const SPENT_BEFORE_LEDGER = "spent-before-ledger";

/**
 * A checkpoint written before usage was keyed by turn, read as a ledger (#8369).
 *
 * It carries one flat sum and no ids to attribute it to, so the sum becomes a single entry and the
 * totals the window renders are unchanged. This is a repair rather than a default, which is why it
 * is not `withCheckpointDefaults`' walk: the field is present and well-formed, it is the shape the
 * ledger replaced. A turn that was in flight when that checkpoint was written is not in the ledger
 * and can still be reported once more — this migrates the totals, it cannot recover ids the old
 * shape never held.
 */
export const withUsageLedger = (raw: unknown): unknown => {
	if (!Predicate.isObject(raw) || !isFlatUsage(raw.usage)) return raw;
	const flat = raw.usage;
	return {
		...raw,
		usage: {
			model: flat.model,
			turns: {
				[SPENT_BEFORE_LEDGER]: {
					inputTokens: flat.inputTokens,
					outputTokens: flat.outputTokens,
					cost: flat.cost,
				},
			},
		},
	};
};

/**
 * A checkpoint written before a slot counted its workers, read with the count it implied (#8664).
 *
 * A repair rather than a default, for the same reason `withUsageLedger` is one: `subagents` is
 * present and well-formed, it is the per-slot shape that grew a field. Every slot the old shape
 * could write held one spawning call and said nothing about a fan-out, so `1` is what it meant —
 * and without this the predicate refuses the whole checkpoint and the desk comes back `gone`.
 *
 * It fills only an absent count. A slot carrying a `workers` of the wrong type stays wrong, and
 * `parseSessionState` still refuses it.
 */
export const withSubagentWorkers = (raw: unknown): unknown => {
	if (
		!Predicate.isObject(raw) ||
		!Predicate.isObject(raw.subagents) ||
		Array.isArray(raw.subagents)
	)
		return raw;
	const slots = Object.entries(raw.subagents);
	if (!slots.some(([, slot]) => Predicate.isObject(slot) && slot.workers === undefined)) return raw;
	return {
		...raw,
		subagents: Object.fromEntries(
			slots.map(([key, slot]) => [
				key,
				Predicate.isObject(slot) && slot.workers === undefined ? {...slot, workers: 1} : slot,
			]),
		),
	};
};

/**
 * The checkpoint read, as the defaulting and the predicate composed once: the session, or `null`.
 *
 * One function rather than two call sites of the same pair, because `loadCheckpoint` wants the
 * session and the row's `restorable` (`../program.ts`) wants only the bit. A store that sealed on a
 * different verdict than the one the window renders would hold the wrong bytes (#8112).
 */
export const readCheckpoint = (loaded: unknown, cwd: string): AiAgentSessionState | null =>
	parseSessionState(withSubagentWorkers(withUsageLedger(withCheckpointDefaults(loaded, cwd))));

/**
 * What the store loaded, read as a session — or the refusal, when it is not one. The machine's
 * `init` rehydrate branch is this and nothing else.
 *
 * It takes `unknown` because that is what arrives: Demlik types `init`'s argument as the state, but
 * the checkpoint store's `migrate` is identity and the envelope's parse never looks inside the
 * state, so before #8095 the load path trusted a type nothing had checked.
 *
 * A checkpoint still invalid once defaulted comes back `gone` carrying the refusal. `gone` is the
 * one phase `resumeMessages` dispatches nothing into (`../restore/checkpoint.ts`), so the failure
 * survives to the window's status line — an `idle` refusal would trigger the fresh `start` that
 * clears `failure`, which is the silent fresh session over an unreadable checkpoint #7514 refuses.
 *
 * The refused bytes are not destroyed by the save that follows `init`: the row answers `restorable`
 * off the same read, and durability seals the store on a `false` (#8112).
 */
export const loadCheckpoint = (loaded: unknown, cwd: string): AiAgentSessionState => {
	const checkpoint = readCheckpoint(loaded, cwd);
	return checkpoint === null
		? {...initialState(cwd), phase: "gone", failure: checkpointUnreadable}
		: restore(checkpoint);
};
