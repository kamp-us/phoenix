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
					yield* Effect.sleep("50 millis");
					yield* ui.dispatch(
						"session-peer",
						request("peer-status", "setStatus", {
							statusKey: "phase",
							statusText: "eş paket durumu",
						}),
					);
					yield* ui.dispatch(
						"session-peer",
						request("peer-widget", "setWidget", {
							widgetKey: "plan",
							widgetLines: ["peer below"],
							widgetPlacement: "belowEditor",
						}),
					);
				}),
			);
		}),
	);
