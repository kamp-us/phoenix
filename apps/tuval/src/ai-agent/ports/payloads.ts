/**
 * What travels on each of the five AI agent ports, and the predicate that admits it.
 *
 * A port is a nominal kind plus a payload predicate (#7512) — not a schema system — so each
 * payload here is a plain type with a hand-written predicate, the shape `src/ports/` routes on.
 * A port whose protocol runs both ways carries one tagged payload rather than two kinds, so a
 * single route between two nodes serves the whole conversation.
 */

import {Predicate, Schema} from "effect";
import {
	isJsonValue,
	isNonNegativeInteger,
	isTranscriptItems,
	type JsonValue,
	type TranscriptItem,
} from "./transcript-item.ts";

/** What a window bound left out, and why. `none` is the whole tail, nothing dropped. */
export interface WindowOmission {
	readonly items: number;
	readonly bytes: number;
	readonly reason: "none" | "item-limit" | "byte-limit";
}

const reasons: ReadonlySet<string> = new Set<WindowOmission["reason"]>([
	"none",
	"item-limit",
	"byte-limit",
]);

export const isWindowOmission = (value: unknown): value is WindowOmission =>
	Predicate.isObject(value) &&
	isNonNegativeInteger(value.items) &&
	isNonNegativeInteger(value.bytes) &&
	typeof value.reason === "string" &&
	reasons.has(value.reason);

/** `transcript` — the live tail as the program last computed it, plus what the window dropped. */
export interface TranscriptPayload {
	readonly items: ReadonlyArray<TranscriptItem>;
	readonly omitted: WindowOmission;
}

export const isTranscriptPayload = (value: unknown): value is TranscriptPayload =>
	Predicate.isObject(value) && isTranscriptItems(value.items) && isWindowOmission(value.omitted);

/**
 * `transcript-page` — a request for older history and the page that answers it. `before` is the
 * oldest item the caller already holds, or `null` for the oldest end of the live tail; `next` is
 * the cursor for the page older than this one, or `null` when there is none.
 */
export type TranscriptPagePayload =
	| {readonly kind: "request"; readonly before: string | null; readonly limit: number}
	| {
			readonly kind: "page";
			readonly items: ReadonlyArray<TranscriptItem>;
			readonly omitted: WindowOmission;
			readonly next: string | null;
	  };

const isCursor = (value: unknown): value is string | null =>
	value === null || (typeof value === "string" && value.length > 0);

export const isTranscriptPagePayload = (value: unknown): value is TranscriptPagePayload => {
	if (!Predicate.isObject(value)) return false;
	switch (value.kind) {
		case "request":
			return isCursor(value.before) && Number.isInteger(value.limit) && (value.limit as number) > 0;
		case "page":
			return (
				isTranscriptItems(value.items) && isWindowOmission(value.omitted) && isCursor(value.next)
			);
		default:
			return false;
	}
};

/**
 * `prompt` — one turn of operator text. `key` is the idempotency key: a second prompt carrying a
 * key the session already saw is dropped rather than re-sent, so a transport retry is free while
 * a deliberate resend mints a new key.
 *
 * Both fields are required here, and that is a reversal (#7991). They used to be optional so an
 * older sender stayed readable, but the receiver refused an unstamped prompt anyway (`program.ts`)
 * — into a `failed` Msg only a rendering window can see. So the optionality bought no sender
 * anything: their turn never ran either way, and the caller read `delivered: true`. Required, the
 * kernel's own `accepts` check refuses at the send, which is the error the Claude `send` tool
 * already promises. The kind stays `@1` because the set of payloads that ever produced a turn is
 * unchanged; only the moment of refusal moved.
 */
export interface PromptPayload {
	readonly text: string;
	readonly key: string;
	/** Epoch milliseconds, stamped by the sender: the turn's clock, since the core reads none. */
	readonly timestamp: number;
}

export const isPromptPayload = (value: unknown): value is PromptPayload =>
	Predicate.isObject(value) &&
	typeof value.text === "string" &&
	typeof value.key === "string" &&
	Number.isFinite(value.timestamp);

/** One card the window renders while the program waits for an answer. */
export interface PermissionRequest {
	readonly title: string;
	readonly displayName: string;
	readonly description: string;
	readonly input: JsonValue;
	/** Whether this request may be answered `allow-always`, not whether it should be. */
	readonly offersAlways: boolean;
}

export type PermissionDecision = "allow-once" | "allow-always" | "deny";

const decisions: ReadonlySet<string> = new Set<PermissionDecision>([
	"allow-once",
	"allow-always",
	"deny",
]);

/**
 * How far one card's answer has got. A card leaves the pending set on its confirmation and not on
 * the click that answered it (#8006), so `answering` is the state a window renders while the
 * decision is out and `unresolved` is the one it renders when that answer's outcome is unknown.
 *
 * `unresolved` offers no second answer: the authorization may have been applied, so re-sending one
 * is a retry nobody asked for. Only the backend's own `permission-resolved` clears it.
 */
export type PermissionProgress =
	| {readonly status: "open"}
	| {readonly status: "answering"; readonly decision: PermissionDecision}
	| {readonly status: "unresolved"; readonly decision: PermissionDecision};

/** One card the window renders, how far its answer has got, and which raising of its id it is. */
export interface PendingPermission {
	readonly request: PermissionRequest;
	/**
	 * Which request this session has raised, counting from one. A confirmation names it, so an
	 * answer whose reply arrives after its card was settled cannot clear a later card that happens
	 * to carry the same request id.
	 */
	readonly seq: number;
	readonly progress: PermissionProgress;
}

/**
 * `permission` — the pending set outbound, keyed by request id, and one answer inbound. A program
 * that never prompts emits an empty `pending` and is done; it declares the port all the same, so
 * the window's wiring does not change per program.
 */
export type PermissionPayload =
	| {readonly kind: "pending"; readonly requests: Readonly<Record<string, PendingPermission>>}
	| {
			readonly kind: "decision";
			readonly request: string;
			readonly decision: PermissionDecision;
			readonly message?: string;
	  };

export const isPermissionRequest = (value: unknown): value is PermissionRequest =>
	Predicate.isObject(value) &&
	typeof value.title === "string" &&
	typeof value.displayName === "string" &&
	typeof value.description === "string" &&
	isJsonValue(value.input) &&
	typeof value.offersAlways === "boolean";

const isProgress = (value: unknown): value is PermissionProgress =>
	Predicate.isObject(value) &&
	(value.status === "open" ||
		((value.status === "answering" || value.status === "unresolved") &&
			typeof value.decision === "string" &&
			decisions.has(value.decision)));

export const isPendingPermission = (value: unknown): value is PendingPermission =>
	Predicate.isObject(value) &&
	isPermissionRequest(value.request) &&
	isNonNegativeInteger(value.seq) &&
	isProgress(value.progress);

export const isPermissionPayload = (value: unknown): value is PermissionPayload => {
	if (!Predicate.isObject(value)) return false;
	switch (value.kind) {
		case "pending":
			return (
				Predicate.isObject(value.requests) &&
				Object.values(value.requests).every(isPendingPermission)
			);
		case "decision":
			return (
				typeof value.request === "string" &&
				value.request.length > 0 &&
				typeof value.decision === "string" &&
				decisions.has(value.decision) &&
				(value.message === undefined || typeof value.message === "string")
			);
		default:
			return false;
	}
};

/** A mode a program offers. The names are the program's own; the window only lists them. */
export const Mode = Schema.String.pipe(Schema.brand("tuval/ai-agent/Mode"));
export type Mode = typeof Mode.Type;

/**
 * `mode` — the current mode and the list on offer outbound, one set inbound. A program with no
 * modes advertises `{current: null, available: []}`.
 */
export type ModePayload =
	| {readonly kind: "state"; readonly current: Mode | null; readonly available: ReadonlyArray<Mode>}
	| {readonly kind: "set"; readonly mode: Mode};

const isMode = (value: unknown): value is Mode => typeof value === "string" && value.length > 0;

export const isModePayload = (value: unknown): value is ModePayload => {
	if (!Predicate.isObject(value)) return false;
	switch (value.kind) {
		case "state":
			return (
				(value.current === null || isMode(value.current)) &&
				Array.isArray(value.available) &&
				value.available.every(isMode)
			);
		case "set":
			return isMode(value.mode);
		default:
			return false;
	}
};
