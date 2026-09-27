/**
 * The page's "Open project…" port over its spell call (#9697): each question is a `project` spell,
 * and the open is exactly the call `tuval open` makes (`../../discovery/reach.ts`) — the same path and
 * the same arguments — so it takes the kernel's own open, trust prompt and all.
 */

import {assert, describe, it} from "@effect/vitest";
import {CallId} from "@kampus/tuval-sdk/kernel/protocol/ids";
import {
	PROTOCOL_VERSION,
	type SpellCall,
	SpellReplyError,
	SpellReplyOk,
} from "@kampus/tuval-sdk/kernel/protocol/messages";
import {Effect} from "effect";
import {ProjectOpenerFailure, projectOpenerOver} from "./project-opener.ts";

const replying = (answer: (call: SpellCall) => unknown, fail?: string) => {
	const calls: Array<SpellCall> = [];
	const opener = projectOpenerOver((call) => {
		calls.push(call);
		return Effect.succeed(
			fail === undefined
				? new SpellReplyOk({
						type: "spell.reply",
						version: PROTOCOL_VERSION,
						id: CallId.make(call.id),
						ok: true,
						result: answer(call),
					})
				: new SpellReplyError({
						type: "spell.reply",
						version: PROTOCOL_VERSION,
						id: CallId.make(call.id),
						ok: false,
						error: {tag: "tuval/FolderNotTrusted", message: fail},
					}),
		);
	});
	return {opener, calls};
};

describe("projectOpenerOver", () => {
	it.effect("opens with the project open spell, the request tuval open sends", () =>
		Effect.gen(function* () {
			const {opener, calls} = replying(() => ({
				folder: "/work/demlik",
				name: "demlik",
				key: "-work-demlik",
				programs: 2,
				refused: [],
				processes: 1,
				restored: 0,
			}));
			const opened = yield* opener.open("/work/demlik");
			assert.deepStrictEqual(opened, {folder: "/work/demlik", name: "demlik", key: "-work-demlik"});
			assert.deepStrictEqual(calls[0]?.path, ["project", "open"]);
			assert.deepStrictEqual(calls[0]?.args, {folder: "/work/demlik"});
		}),
	);

	it.effect("browses the home folder by naming none, and a folder by naming it", () =>
		Effect.gen(function* () {
			const {opener, calls} = replying((call) => ({
				folder: (call.args as {folder?: string}).folder ?? "/home/ada",
				name: "x",
				key: "-x",
				parent: null,
				open: false,
				folders: [],
			}));
			assert.strictEqual((yield* opener.browse(null)).folder, "/home/ada");
			assert.strictEqual((yield* opener.browse("/work")).folder, "/work");
			assert.deepStrictEqual(
				calls.map((call) => [call.path, call.args]),
				[
					[["project", "browse"], {}],
					[["project", "browse"], {folder: "/work"}],
				],
			);
		}),
	);

	it.effect("fails with the kernel's own message when the spell refuses", () =>
		Effect.gen(function* () {
			const {opener} = replying(() => null, "the folder /work/x is not trusted");
			const failure = yield* Effect.flip(opener.open("/work/x"));
			assert.instanceOf(failure, ProjectOpenerFailure);
			assert.strictEqual(failure.reason, "the folder /work/x is not trusted");
		}),
	);

	it.effect("refuses an answer in a shape the page cannot read, never passing it on", () =>
		Effect.gen(function* () {
			const {opener} = replying(() => [{folder: 7}]);
			const failure = yield* Effect.flip(opener.recent);
			assert.include(failure.reason, "project recent");
		}),
	);
});
