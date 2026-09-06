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
	type UsageTotals,
} from "./state.ts";

const isNullOrString = (value: unknown): value is string | null =>
	value === null || typeof value === "string";

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isUsage = (value: unknown): value is UsageTotals =>
	Predicate.isObject(value) &&
	isNullOrString(value.model) &&
	isFiniteNumber(value.inputTokens) &&
	isFiniteNumber(value.outputTokens) &&
	isFiniteNumber(value.cost);

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
	isPermissions(value.permissions) &&
	isFiniteNumber(value.permissionsRaised) &&
	isModes(value.modes) &&
	isModels(value.models) &&
	isCommands(value.commands) &&
	isThinking(value.thinking) &&
	isNullOrString(value.lastPrompt) &&
	isSends(value.sends) &&
	isPage(value.lastPage) &&
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
 */
export const loadCheckpoint = (loaded: unknown, cwd: string): AiAgentSessionState => {
	const checkpoint = parseSessionState(withCheckpointDefaults(loaded, cwd));
	return checkpoint === null
		? {...initialState(cwd), phase: "gone", failure: checkpointUnreadable}
		: restore(checkpoint);
};
