/**
 * The create-time live-broadcast gate — proves the `PublishDecision` gate suppresses the
 * public fate-live fan-out for a sandboxed row, lets a live row through, and always
 * broadcasts a restore. This is the leak surface the visibility matrix does NOT cover: the
 * static read paths filter sandboxed content, but the create-time broadcast is viewer-blind,
 * so without this gate a sandboxed çaylak's node would be pushed to anonymous subscribers.
 *
 * We record whether the publish effect ran rather than inspect a frame: "the create
 * published a public node" is exactly "the publish effect ran".
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {alwaysLive, broadcastIf, decidePublish} from "./sandbox.ts";

const at = new Date("2026-06-25T00:00:00.000Z");

const recordingPublish = () => {
	let ran = false;
	const effect = Effect.sync(() => {
		ran = true;
	});
	return {effect, didRun: () => ran};
};

describe("PublishDecision gate — create-time live broadcast gate (#1205 AC#2, #1280)", () => {
	it("does NOT publish a sandboxed node to the public topic", () => {
		const publish = recordingPublish();
		Effect.runSync(broadcastIf(decidePublish(at), publish.effect));
		assert.isFalse(publish.didRun(), "sandboxed create must not broadcast its node");
	});

	it("DOES publish a live (non-sandboxed) node — no regression", () => {
		const publish = recordingPublish();
		Effect.runSync(broadcastIf(decidePublish(null), publish.effect));
		assert.isTrue(publish.didRun(), "live create must still broadcast its node");
	});

	it("DOES publish an always-Live restore node (Removed → Live)", () => {
		const publish = recordingPublish();
		Effect.runSync(broadcastIf(alwaysLive, publish.effect));
		assert.isTrue(publish.didRun(), "restore must still broadcast its already-public node");
	});
});
