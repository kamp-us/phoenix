import type {RpcExtensionUIRequest, RpcExtensionUIResponse} from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";

export type RpcExtensionUIMethod = RpcExtensionUIRequest["method"];
export type ExtensionUISupport = "supported" | "unavailable" | "deferred";
export type ExtensionUIRetention = "none" | "current";

export const extensionUIMethods = {
	select: {kind: "blocking", support: "supported", retention: "none"},
	confirm: {kind: "blocking", support: "supported", retention: "none"},
	input: {kind: "blocking", support: "supported", retention: "none"},
	editor: {kind: "blocking", support: "supported", retention: "none"},
	notify: {kind: "fire-and-forget", support: "supported", retention: "none"},
	setStatus: {kind: "fire-and-forget", support: "supported", retention: "current"},
	setWidget: {kind: "fire-and-forget", support: "supported", retention: "current"},
	setTitle: {kind: "fire-and-forget", support: "unavailable", retention: "none"},
	set_editor_text: {kind: "fire-and-forget", support: "deferred", retention: "none"},
} as const satisfies Record<
	RpcExtensionUIMethod,
	{
		readonly kind: "blocking" | "fire-and-forget";
		readonly support: ExtensionUISupport;
		readonly retention: ExtensionUIRetention;
	}
>;

export const ExtensionUIScope = Schema.Struct({
	packageName: Schema.String,
	sessionId: Schema.String,
});
export type ExtensionUIScope = (typeof ExtensionUIScope)["Type"];

const SelectRequest = Schema.Struct({
	type: Schema.Literal("extension_ui_request"),
	id: Schema.String,
	method: Schema.Literal("select"),
	title: Schema.String,
	options: Schema.Array(Schema.String),
	timeout: Schema.optionalKey(Schema.Number),
});
const ConfirmRequest = Schema.Struct({
	type: Schema.Literal("extension_ui_request"),
	id: Schema.String,
	method: Schema.Literal("confirm"),
	title: Schema.String,
	message: Schema.String,
	timeout: Schema.optionalKey(Schema.Number),
});
const InputRequest = Schema.Struct({
	type: Schema.Literal("extension_ui_request"),
	id: Schema.String,
	method: Schema.Literal("input"),
	title: Schema.String,
	placeholder: Schema.optionalKey(Schema.String),
	timeout: Schema.optionalKey(Schema.Number),
});
const EditorRequest = Schema.Struct({
	type: Schema.Literal("extension_ui_request"),
	id: Schema.String,
	method: Schema.Literal("editor"),
	title: Schema.String,
	prefill: Schema.optionalKey(Schema.String),
});
const NotifyRequest = Schema.Struct({
	type: Schema.Literal("extension_ui_request"),
	id: Schema.String,
	method: Schema.Literal("notify"),
	message: Schema.String,
	notifyType: Schema.optionalKey(Schema.Literals(["info", "warning", "error"])),
});
const StatusRequest = Schema.Struct({
	type: Schema.Literal("extension_ui_request"),
	id: Schema.String,
	method: Schema.Literal("setStatus"),
	statusKey: Schema.String,
	statusText: Schema.optionalKey(Schema.String),
});
const WidgetRequest = Schema.Struct({
	type: Schema.Literal("extension_ui_request"),
	id: Schema.String,
	method: Schema.Literal("setWidget"),
	widgetKey: Schema.String,
	widgetLines: Schema.optionalKey(Schema.Array(Schema.String)),
	widgetPlacement: Schema.optionalKey(Schema.Literals(["aboveEditor", "belowEditor"])),
});
const TitleRequest = Schema.Struct({
	type: Schema.Literal("extension_ui_request"),
	id: Schema.String,
	method: Schema.Literal("setTitle"),
	title: Schema.String,
});
const EditorTextRequest = Schema.Struct({
	type: Schema.Literal("extension_ui_request"),
	id: Schema.String,
	method: Schema.Literal("set_editor_text"),
	text: Schema.String,
});

export const ExtensionUIRequest = Schema.Union([
	SelectRequest,
	ConfirmRequest,
	InputRequest,
	EditorRequest,
	NotifyRequest,
	StatusRequest,
	WidgetRequest,
	TitleRequest,
	EditorTextRequest,
]);
export type ExtensionUIRequest = (typeof ExtensionUIRequest)["Type"];

type ExhaustiveRequestPin = ExtensionUIRequest["method"] extends RpcExtensionUIRequest["method"]
	? RpcExtensionUIRequest["method"] extends ExtensionUIRequest["method"]
		? true
		: never
	: never;
export const exhaustiveRequestPin: ExhaustiveRequestPin = true;

export const ExtensionUIResponse = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("extension_ui_response"),
		id: Schema.String,
		value: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("extension_ui_response"),
		id: Schema.String,
		confirmed: Schema.Boolean,
	}),
	Schema.Struct({
		type: Schema.Literal("extension_ui_response"),
		id: Schema.String,
		cancelled: Schema.Literal(true),
	}),
]);
export type ExtensionUIResponse = (typeof ExtensionUIResponse)["Type"];
type ResponsePin = ExtensionUIResponse extends RpcExtensionUIResponse ? true : never;
export const responsePin: ResponsePin = true;

export const ExtensionUIResponseRequest = Schema.Struct({
	scope: ExtensionUIScope,
	response: ExtensionUIResponse,
});
export type ExtensionUIResponseRequest = (typeof ExtensionUIResponseRequest)["Type"];

export const ExtensionUICancelRequest = Schema.Struct({scope: ExtensionUIScope, id: Schema.String});
export type ExtensionUICancelRequest = (typeof ExtensionUICancelRequest)["Type"];

export const ExtensionUIUnloadRequest = Schema.Struct({scope: ExtensionUIScope});
export type ExtensionUIUnloadRequest = (typeof ExtensionUIUnloadRequest)["Type"];

export interface ExtensionUIStatusState {
	readonly key: string;
	readonly text: string;
}
export interface ExtensionUIWidgetState {
	readonly key: string;
	readonly lines: ReadonlyArray<string>;
	readonly placement: "aboveEditor" | "belowEditor";
}
export interface ExtensionUISnapshot {
	readonly scope: ExtensionUIScope;
	readonly statuses: ReadonlyArray<ExtensionUIStatusState>;
	readonly widgets: ReadonlyArray<ExtensionUIWidgetState>;
}

export type ExtensionUIEvent =
	| {
			readonly _tag: "request";
			readonly sequence: number;
			readonly scope: ExtensionUIScope;
			readonly request: ExtensionUIRequest;
	  }
	| {
			readonly _tag: "notify";
			readonly sequence: number;
			readonly scope: ExtensionUIScope;
			readonly request: Extract<ExtensionUIRequest, {method: "notify"}>;
	  }
	| {
			readonly _tag: "status";
			readonly sequence: number;
			readonly scope: ExtensionUIScope;
			readonly key: string;
			readonly text?: string;
			readonly replay: boolean;
	  }
	| {
			readonly _tag: "widget";
			readonly sequence: number;
			readonly scope: ExtensionUIScope;
			readonly key: string;
			readonly lines?: ReadonlyArray<string>;
			readonly placement: "aboveEditor" | "belowEditor";
			readonly replay: boolean;
	  }
	| {
			readonly _tag: "settled";
			readonly sequence: number;
			readonly scope: ExtensionUIScope;
			readonly id: string;
			readonly method: "select" | "confirm" | "input" | "editor";
			readonly outcome: "responded" | "cancelled" | "timeout" | "disconnected" | "unloaded";
	  }
	| {
			readonly _tag: "degradation";
			readonly sequence: number;
			readonly scope: ExtensionUIScope;
			readonly id: string;
			readonly method: "setTitle" | "set_editor_text";
			readonly outcome: "unavailable" | "deferred";
	  }
	| {readonly _tag: "unloaded"; readonly sequence: number; readonly scope: ExtensionUIScope};

export type ExtensionUIDispatchOutcome =
	| {readonly _tag: "responded"; readonly response: ExtensionUIResponse}
	| {
			readonly _tag: "cancelled";
			readonly reason: "timeout" | "disconnected" | "unloaded" | "cancelled";
			readonly response: ExtensionUIResponse;
	  }
	| {readonly _tag: "accepted"; readonly method: "notify" | "setStatus" | "setWidget"}
	| {readonly _tag: "unavailable"; readonly method: RpcExtensionUIMethod; readonly reason: string}
	| {readonly _tag: "deferred"; readonly method: RpcExtensionUIMethod; readonly reason: string};

export type ExtensionUIResponseOutcome =
	| {readonly _tag: "accepted"; readonly id: string}
	| {readonly _tag: "duplicate"; readonly id: string}
	| {readonly _tag: "unknown"; readonly id: string}
	| {
			readonly _tag: "method-mismatch";
			readonly id: string;
			readonly method: "select" | "confirm" | "input" | "editor";
	  };
