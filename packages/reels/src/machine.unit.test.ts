import {replay} from "@demlik/tea";
import {nextDelayMs} from "@demlik/tea/retry-backoff";
import {describe, expect, it} from "vitest";
import {
	type BatchMsg,
	bundle,
	caption,
	pause,
	RETRY,
	reelsMachine,
	render,
	type State,
	soundtrack,
} from "./machine.ts";

const machine = reelsMachine({concurrency: 1});
const reels = [
	{id: "a", hash: "ha"},
	{id: "b", hash: "hb"},
];
const requested = {
	type: "batch_requested",
	reels,
	force: false,
	at: 0,
} satisfies BatchMsg;

const fold = (msgs: ReadonlyArray<BatchMsg>, loaded: State | null = null) =>
	replay(machine, {msgs, ctx: {}, loaded});

const scored: ReadonlyArray<BatchMsg> = [
	requested,
	soundtrack.ok(soundtrack({reelId: "a"}), {path: "soundtracks/a.wav"}, 1),
	soundtrack.ok(soundtrack({reelId: "b"}), {path: "soundtracks/b.wav"}, 2),
];

describe("reels machine", () => {
	it("writes every soundtrack before it bundles", () => {
		const first = fold([requested]);
		expect(first.state.type).toBe("scoring");
		expect(first.cmds).toEqual([soundtrack({reelId: "a"}), soundtrack({reelId: "b"})]);
		const done = fold(scored);
		expect(done.state.type).toBe("bundling");
		expect(done.cmds).toContainEqual(bundle({reels: 2}));
	});

	it("renders no more reels at once than its concurrency", () => {
		const rendering = fold([
			...scored,
			bundle.ok(bundle({reels: 2}), {serveUrl: "http://bundle"}, 3),
		]);
		expect(rendering.state.type).toBe("rendering");
		expect(rendering.cmds.filter((cmd) => cmd.type === "render")).toEqual([
			render({reelId: "a", attempt: 1}),
		]);
	});

	it("backs off and retries a failed render, then gives up after the policy's attempts", () => {
		const base: ReadonlyArray<BatchMsg> = [
			...scored,
			bundle.ok(bundle({reels: 2}), {serveUrl: "u"}, 3),
		];
		const fail = (attempt: number) =>
			render.err(render({reelId: "a", attempt}), {_tag: "render_failed", message: "boom"}, 4);
		const once = fold([...base, fail(1)]);
		expect(once.cmds.at(-1)).toEqual(pause({reelId: "a", ms: nextDelayMs({attempt: 1}, RETRY)}));

		const exhausted: Array<BatchMsg> = [...base];
		for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
			exhausted.push(fail(attempt));
			if (attempt < RETRY.maxAttempts)
				exhausted.push(pause.ok(pause({reelId: "a", ms: 0}), undefined, 5));
		}
		const gaveUp = fold(exhausted);
		const outcomes = "outcomes" in gaveUp.state ? gaveUp.state.outcomes : {};
		expect(outcomes.a).toMatchObject({status: "failed", attempts: RETRY.maxAttempts});
		expect(gaveUp.cmds.at(-1)).toEqual(render({reelId: "b", attempt: 1}));
	});

	it("finishes when every reel settles and remembers each by its hash", () => {
		const finished = fold([
			...scored,
			bundle.ok(bundle({reels: 2}), {serveUrl: "u"}, 3),
			render.ok(render({reelId: "a", attempt: 1}), {video: "out/a.mp4", seconds: 10}, 4),
			caption.ok(caption({reelId: "a", video: "out/a.mp4"}), {path: "out/a.txt"}, 5),
			render.ok(render({reelId: "b", attempt: 1}), {video: "out/b.mp4", seconds: 12}, 6),
			caption.ok(caption({reelId: "b", video: "out/b.mp4"}), {path: "out/b.txt"}, 7),
		]);
		expect(finished.state.type).toBe("finished");

		const again = fold([{...requested, at: 8}], finished.state);
		expect(again.state.type).toBe("finished");
		expect(again.cmds).toEqual([]);
		expect("outcomes" in again.state && again.state.outcomes.a).toEqual({
			status: "unchanged",
			video: "out/a.mp4",
		});

		const forced = fold([{...requested, force: true, at: 9}], finished.state);
		expect(forced.state.type).toBe("scoring");
	});
});
