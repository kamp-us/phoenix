import {Option, Schema} from "effect";
import {
	type ExtensionUICancelRequest,
	type ExtensionUIEvent,
	ExtensionUIRequest,
	type ExtensionUIResponseOutcome,
	type ExtensionUIResponseRequest,
	ExtensionUIScope,
	ExtensionUISnapshot,
} from "../shared/extension-ui.js";

const Placement = Schema.Literals(["aboveEditor", "belowEditor"]);
const NotifyRequest = Schema.Struct({
	type: Schema.Literal("extension_ui_request"),
	id: Schema.String,
	method: Schema.Literal("notify"),
	message: Schema.String,
	notifyType: Schema.optionalKey(Schema.Literals(["info", "warning", "error"])),
});
const EventScope = {sequence: Schema.Number, scope: ExtensionUIScope};
const ExtensionUIEventSchema = Schema.Union([
	Schema.Struct({...EventScope, _tag: Schema.Literal("request"), request: ExtensionUIRequest}),
	Schema.Struct({...EventScope, _tag: Schema.Literal("notify"), request: NotifyRequest}),
	Schema.Struct({
		...EventScope,
		_tag: Schema.Literal("status"),
		key: Schema.String,
		text: Schema.optionalKey(Schema.String),
		replay: Schema.Boolean,
	}),
	Schema.Struct({
		...EventScope,
		_tag: Schema.Literal("widget"),
		key: Schema.String,
		lines: Schema.optionalKey(Schema.Array(Schema.String)),
		placement: Placement,
		replay: Schema.Boolean,
	}),
	Schema.Struct({
		...EventScope,
		_tag: Schema.Literal("settled"),
		id: Schema.String,
		method: Schema.Literals(["select", "confirm", "input", "editor"]),
		outcome: Schema.Literals(["responded", "cancelled", "timeout", "disconnected", "unloaded"]),
	}),
	Schema.Struct({
		...EventScope,
		_tag: Schema.Literal("degradation"),
		id: Schema.String,
		method: Schema.Literals(["setTitle", "set_editor_text"]),
		outcome: Schema.Literals(["unavailable", "deferred"]),
	}),
	Schema.Struct({...EventScope, _tag: Schema.Literal("unloaded")}),
]);

const ExtensionUIResponseOutcomeSchema = Schema.Union([
	Schema.Struct({_tag: Schema.Literal("accepted"), id: Schema.String}),
	Schema.Struct({_tag: Schema.Literal("duplicate"), id: Schema.String}),
	Schema.Struct({_tag: Schema.Literal("unknown"), id: Schema.String}),
	Schema.Struct({
		_tag: Schema.Literal("method-mismatch"),
		id: Schema.String,
		method: Schema.Literals(["select", "confirm", "input", "editor"]),
	}),
]);

type AcceptedSettlement = Extract<ExtensionUIResponseOutcome, {_tag: "accepted" | "duplicate"}>;
type SettlementRefusalReason = "stale-id" | "unknown" | "method-mismatch";

export class ExtensionUISettlementRefusal extends Error {
	readonly _tag = "ExtensionUISettlementRefusal";
	readonly reason: SettlementRefusalReason;
	readonly expectedId: string;
	readonly outcome: ExtensionUIResponseOutcome;

	constructor(
		reason: SettlementRefusalReason,
		expectedId: string,
		outcome: ExtensionUIResponseOutcome,
	) {
		super(
			reason === "stale-id"
				? `Extension UI yanıtı ${expectedId} yerine ${outcome.id} isteğine ait; görünür istek açık tutuldu.`
				: `Extension UI ${expectedId} isteğini ${outcome._tag} sonucu ile reddetti; görünür istek açık tutuldu.`,
		);
		this.name = "ExtensionUISettlementRefusal";
		this.reason = reason;
		this.expectedId = expectedId;
		this.outcome = outcome;
	}
}

export const decodeExtensionUIEvent = (value: unknown): ExtensionUIEvent | undefined =>
	Option.getOrUndefined(Schema.decodeUnknownOption(ExtensionUIEventSchema)(value));

export const bindExtensionUIOutcome = (expectedId: string, value: unknown): AcceptedSettlement => {
	const outcome = Option.getOrUndefined(
		Schema.decodeUnknownOption(ExtensionUIResponseOutcomeSchema)(value),
	);
	if (outcome === undefined) throw new Error("Extension UI yanıt sonucu okunamadı");
	if (outcome.id !== expectedId) {
		throw new ExtensionUISettlementRefusal("stale-id", expectedId, outcome);
	}
	if (outcome._tag === "unknown" || outcome._tag === "method-mismatch") {
		throw new ExtensionUISettlementRefusal(outcome._tag, expectedId, outcome);
	}
	return outcome;
};

interface FateOperation {
	readonly id: string;
	readonly kind: "query" | "mutation";
	readonly name: string;
	readonly input?: unknown;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null;

const runFate = async (operation: FateOperation, endpoint = "/fate"): Promise<unknown> => {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({version: 1, operations: [{...operation, select: []}]}),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body.results)) throw new Error("Fate yanıtı okunamadı");
	const result = body.results.find(
		(candidate) => isRecord(candidate) && candidate.id === operation.id,
	);
	if (!isRecord(result) || result.ok !== true) throw new Error("Extension UI işlemi reddedildi");
	return result.data;
};

const readCurrentSnapshots = async (): Promise<ReadonlyArray<ExtensionUISnapshot>> => {
	const value = await runFate(
		{
			id: `extension-ui-current-${crypto.randomUUID()}`,
			kind: "query",
			name: "extensionUi.current",
		},
		"/fate?extension-ui-current=1",
	);
	const snapshots = Option.getOrUndefined(
		Schema.decodeUnknownOption(Schema.Array(ExtensionUISnapshot))(value),
	);
	if (snapshots === undefined) throw new Error("Extension UI güncel görünümü okunamadı");
	return snapshots;
};

export interface ExtensionUIBrowserClient {
	readonly respond: (request: ExtensionUIResponseRequest) => Promise<AcceptedSettlement>;
	readonly cancel: (request: ExtensionUICancelRequest) => Promise<AcceptedSettlement>;
	readonly subscribe: (handlers: {
		readonly open: () => void;
		readonly snapshot: (snapshots: ReadonlyArray<ExtensionUISnapshot>) => void;
		readonly snapshotFailure: (reason: string) => void;
		readonly event: (event: ExtensionUIEvent) => void;
		readonly disconnect: () => void;
		readonly malformed: () => void;
	}) => () => void;
}

export const extensionUIBrowserClient: ExtensionUIBrowserClient = {
	respond: async (input) =>
		bindExtensionUIOutcome(
			input.response.id,
			await runFate({
				id: `extension-ui-respond-${input.response.id}`,
				kind: "mutation",
				name: "extensionUi.respond",
				input,
			}),
		),
	cancel: async (input) =>
		bindExtensionUIOutcome(
			input.id,
			await runFate({
				id: `extension-ui-cancel-${input.id}`,
				kind: "mutation",
				name: "extensionUi.cancel",
				input,
			}),
		),
	subscribe: (handlers) => {
		const source = new EventSource("/fate/extension-ui/live");
		let generation = 0;
		let active = true;
		let awaitingSnapshot = false;
		let queuedEvents: Array<ExtensionUIEvent> = [];
		source.onopen = () => {
			const currentGeneration = ++generation;
			awaitingSnapshot = true;
			queuedEvents = [];
			handlers.open();
			const restore = (attempt: number): void => {
				void readCurrentSnapshots()
					.then((snapshots) => {
						if (!active || currentGeneration !== generation) return;
						handlers.snapshot(snapshots);
						awaitingSnapshot = false;
						for (const event of queuedEvents) handlers.event(event);
						queuedEvents = [];
					})
					.catch((error) => {
						if (!active || currentGeneration !== generation) return;
						if (attempt < 3) {
							setTimeout(() => restore(attempt + 1), [250, 500][attempt - 1] ?? 500);
							return;
						}
						queuedEvents = [];
						handlers.snapshotFailure(
							error instanceof Error
								? error.message
								: "Extension UI yetkili görünümü geri yüklenemedi",
						);
					});
			};
			restore(1);
		};
		source.onerror = () => {
			generation += 1;
			awaitingSnapshot = false;
			queuedEvents = [];
			handlers.disconnect();
		};
		source.onmessage = (message) => {
			let raw: unknown;
			// biome-ignore lint/plugin: EventSource delivers JSON text before the typed Schema boundary.
			try {
				raw = JSON.parse(message.data);
			} catch {
				handlers.malformed();
				return;
			}
			const event = decodeExtensionUIEvent(raw);
			if (event === undefined) handlers.malformed();
			else if (awaitingSnapshot) {
				queuedEvents.push(event);
				if (queuedEvents.length > 500) queuedEvents.shift();
			} else handlers.event(event);
		};
		return () => {
			active = false;
			generation += 1;
			source.close();
		};
	},
};
