import {Option, Schema} from "effect";
import {
	type ExtensionUICancelRequest,
	type ExtensionUIEvent,
	ExtensionUIRequest,
	type ExtensionUIResponseOutcome,
	type ExtensionUIResponseRequest,
	ExtensionUIScope,
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

export const decodeExtensionUIEvent = (value: unknown): ExtensionUIEvent | undefined =>
	Option.getOrUndefined(Schema.decodeUnknownOption(ExtensionUIEventSchema)(value));

interface FateOperation {
	readonly id: string;
	readonly kind: "mutation";
	readonly name: string;
	readonly input: unknown;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null;

const runFate = async (operation: FateOperation): Promise<unknown> => {
	const response = await fetch("/fate", {
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
	if (!isRecord(result) || result.ok !== true || !isRecord(result.data)) {
		throw new Error("Extension UI işlemi reddedildi");
	}
	return result.data;
};

const decodeOutcome = (value: unknown): ExtensionUIResponseOutcome => {
	const outcome = Option.getOrUndefined(
		Schema.decodeUnknownOption(ExtensionUIResponseOutcomeSchema)(value),
	);
	if (outcome === undefined) throw new Error("Extension UI yanıt sonucu okunamadı");
	return outcome;
};

export interface ExtensionUIBrowserClient {
	readonly respond: (request: ExtensionUIResponseRequest) => Promise<ExtensionUIResponseOutcome>;
	readonly cancel: (request: ExtensionUICancelRequest) => Promise<ExtensionUIResponseOutcome>;
	readonly subscribe: (handlers: {
		readonly open: () => void;
		readonly event: (event: ExtensionUIEvent) => void;
		readonly disconnect: () => void;
		readonly malformed: () => void;
	}) => () => void;
}

export const extensionUIBrowserClient: ExtensionUIBrowserClient = {
	respond: async (input) =>
		decodeOutcome(
			await runFate({
				id: `extension-ui-respond-${input.response.id}`,
				kind: "mutation",
				name: "extensionUi.respond",
				input,
			}),
		),
	cancel: async (input) =>
		decodeOutcome(
			await runFate({
				id: `extension-ui-cancel-${input.id}`,
				kind: "mutation",
				name: "extensionUi.cancel",
				input,
			}),
		),
	subscribe: (handlers) => {
		const source = new EventSource("/fate/extension-ui/live");
		source.onopen = handlers.open;
		source.onerror = handlers.disconnect;
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
			else handlers.event(event);
		};
		return () => source.close();
	},
};
