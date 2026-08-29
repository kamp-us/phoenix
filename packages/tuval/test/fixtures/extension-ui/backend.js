import {Effect, Layer} from "effect";
import {PackageExtensionUI} from "../../../dist/backend/extension-ui.js";

const request = (id, method, values = {}) => ({
	type: "extension_ui_request",
	id,
	method,
	...values,
});

export const makeLayer = () =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const ui = yield* PackageExtensionUI;
			yield* Effect.forkChild(
				Effect.gen(function* () {
					yield* Effect.sleep("250 millis");
					yield* ui.dispatch(
						"session-main",
						request("notify", "notify", {message: "Fixture bildirimi", notifyType: "info"}),
					);
					yield* ui.dispatch(
						"session-main",
						request("status", "setStatus", {statusKey: "phase", statusText: "fixture hazır"}),
					);
					yield* ui.dispatch(
						"session-other",
						request("status-other", "setStatus", {statusKey: "phase", statusText: "diğer oturum"}),
					);
					yield* ui.dispatch(
						"session-main",
						request("widget", "setWidget", {
							widgetKey: "plan",
							widgetLines: ["select", "confirm", "input", "editor"],
							widgetPlacement: "aboveEditor",
						}),
					);
					yield* ui.dispatch(
						"session-main",
						request("title", "setTitle", {title: "Uygulanmamalı"}),
					);
					yield* ui.dispatch(
						"session-main",
						request("editor-text", "set_editor_text", {text: "Ertelenmiş metin"}),
					);
					yield* ui.dispatch(
						"session-timeout",
						request("timeout", "confirm", {
							title: "Süre aşımı",
							message: "Bu istek kendiliğinden iptal olur.",
							timeout: 300,
						}),
					);
					yield* ui.dispatch(
						"session-main",
						request("select", "select", {title: "Fixture seçimi", options: ["alfa", "beta"]}),
					);
					yield* ui.dispatch(
						"session-main",
						request("confirm", "confirm", {title: "Fixture onayı", message: "Devam edilsin mi?"}),
					);
					yield* ui.dispatch(
						"session-main",
						request("input", "input", {title: "Fixture girdisi", placeholder: "yanıt"}),
					);
					yield* ui.dispatch(
						"session-main",
						request("editor", "editor", {title: "Fixture editörü", prefill: "başlangıç"}),
					);
					yield* Effect.sleep("250 millis");
					yield* ui.unload("session-other");
				}),
			);
		}),
	);
