/**
 * Reading a checkpoint back: the predicate over one saved `AiAgentSessionState`, and the `null`
 * refusal Demlik's `Store.migrate` contract asks for (`src/durability/snapshot.ts` takes the same
 * shape over the envelope this state travels inside).
 *
 * A predicate rather than a second `effect/Schema` copy of the item union: `ports/` already owns
 * the admission test for every shape here and declares itself "not a schema system", so a schema
 * beside it would be a second source that drifts. Composing the port predicates keeps one.
 */

import {
	isPermissionRequest,
	isTranscriptItems,
	isWindowOmission,
	type PermissionRequest,
} from "../ports/index.ts";
import {type AiAgentSessionState, type HistoryPage, phases, type UsageTotals} from "./state.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNullOrString = (value: unknown): value is string | null =>
	value === null || typeof value === "string";

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isUsage = (value: unknown): value is UsageTotals =>
	isRecord(value) &&
	isNullOrString(value.model) &&
	isFiniteNumber(value.inputTokens) &&
	isFiniteNumber(value.outputTokens) &&
	isFiniteNumber(value.cost);

const isPermissions = (value: unknown): value is Readonly<Record<string, PermissionRequest>> =>
	isRecord(value) && Object.values(value).every(isPermissionRequest);

const isModes = (value: unknown): boolean =>
	isRecord(value) &&
	isNullOrString(value.current) &&
	Array.isArray(value.available) &&
	value.available.every((mode) => typeof mode === "string");

const isTranscript = (value: unknown): boolean =>
	isRecord(value) && isTranscriptItems(value.items) && isWindowOmission(value.omitted);

const isPage = (value: unknown): value is HistoryPage | null =>
	value === null ||
	(isRecord(value) && isTranscriptItems(value.items) && typeof value.hasMore === "boolean");

const isFailure = (value: unknown): boolean =>
	value === null ||
	(isRecord(value) &&
		typeof value.tag === "string" &&
		isNullOrString(value.reason) &&
		typeof value.detail === "string");

export const isAiAgentSessionState = (value: unknown): value is AiAgentSessionState =>
	isRecord(value) &&
	typeof value.phase === "string" &&
	(phases as ReadonlyArray<string>).includes(value.phase) &&
	isNullOrString(value.sessionId) &&
	typeof value.cwd === "string" &&
	isTranscript(value.transcript) &&
	isNullOrString(value.interrupted) &&
	isUsage(value.usage) &&
	isPermissions(value.permissions) &&
	isModes(value.modes) &&
	isNullOrString(value.lastPrompt) &&
	isPage(value.lastPage) &&
	isFailure(value.failure);

/** A snapshot the predicate refuses is `null`, never a throw — the store decides what to do. */
export const parseSessionState = (raw: unknown): AiAgentSessionState | null =>
	isAiAgentSessionState(raw) ? raw : null;
