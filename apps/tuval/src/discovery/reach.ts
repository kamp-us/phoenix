/**
 * The two things the `tuval` command does to a desk that is already running (#9696): bring its page
 * forward, and ask it to open a project. The open travels over the desk's own transport as the
 * `project open` spell, so it takes the same path an "Open project…" in the page takes, trust
 * prompt included (#9693), and the reply is the spell's own.
 */

import {CallId} from "@kampus/tuval-sdk/kernel/protocol/ids";
import {
	PROTOCOL_VERSION,
	SpellCall,
	type SpellReply,
} from "@kampus/tuval-sdk/kernel/protocol/messages";
import {Context, Effect, Layer, Option, Schema} from "effect";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {Socket} from "effect/unstable/socket";
import {attach} from "../shell/transport/client.ts";

/** The desk's page could not be brought forward. The desk itself is untouched. */
export class DeskNotShown extends Schema.TaggedError<DeskNotShown>()("tuval/DeskNotShown", {
	page: Schema.String,
	reason: Schema.String,
}) {
	override get message(): string {
		return `could not bring the desk at ${this.page} forward: ${this.reason}`;
	}
}

/** The running desk could not be reached to ask it anything. */
export class DeskUnreachable extends Schema.TaggedError<DeskUnreachable>()(
	"tuval/DeskUnreachable",
	{reason: Schema.String},
) {
	override get message(): string {
		return `could not reach the running desk: ${this.reason}`;
	}
}

/**
 * Where the desk's page is shown. The web desk's page lives in a browser, so bringing it forward is
 * opening its URL there; the Electron desk will answer the same call with its own window.
 */
export class DeskWindow extends Context.Service<
	DeskWindow,
	{readonly show: (page: string) => Effect.Effect<void, DeskNotShown>}
>()("tuval/DeskWindow") {
	/** The platform's own URL opener: `open` on macOS, `start` on Windows, `xdg-open` elsewhere. */
	static readonly browser = Layer.effect(
		DeskWindow,
		Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
			DeskWindow.of({
				show: (page) =>
					spawner.exitCode(opener(page)).pipe(
						Effect.mapError((error) => new DeskNotShown({page, reason: error.message})),
						Effect.flatMap((code) =>
							code === 0
								? Effect.void
								: Effect.fail(new DeskNotShown({page, reason: `the opener exited ${code}`})),
						),
					),
			}),
		),
	);
}

const opener = (url: string): ChildProcess.Command => {
	switch (process.platform) {
		case "darwin":
			return ChildProcess.make("open", [url]);
		case "win32":
			return ChildProcess.make("cmd", ["/c", "start", "", url]);
		default:
			return ChildProcess.make("xdg-open", [url]);
	}
};

/** Ask the desk at `launchUrl` to open `folder`, and wait for its answer. */
export const openInDesk = Effect.fn("Tuval.openInDesk")(
	function* (launchUrl: string, folder: string) {
		const desk = yield* attach(launchUrl);
		return yield* desk.call(
			new SpellCall({
				type: "spell.call",
				version: PROTOCOL_VERSION,
				id: CallId.make(`tuval-open-${process.pid}`),
				path: ["project", "open"],
				args: {folder},
			}),
		);
	},
	Effect.scoped,
	Effect.mapError((error) => new DeskUnreachable({reason: error.message})),
	Effect.provide(Socket.layerWebSocketConstructorGlobal),
);

const Opened = Schema.Struct({
	name: Schema.String,
	programs: Schema.Int,
	refused: Schema.Array(Schema.String),
	processes: Schema.Int,
});
const decodeOpened = Schema.decodeUnknownOption(Opened);

/** The lines the command prints for the desk's answer to an open, and whether it opened. */
export const renderOpenReply = (
	folder: string,
	reply: SpellReply,
): {readonly opened: boolean; readonly lines: ReadonlyArray<string>} => {
	if (!reply.ok) {
		return {
			opened: false,
			lines: [`tuval: the running desk did not open ${folder} — ${reply.error.message}`],
		};
	}
	return Option.match(decodeOpened(reply.result), {
		onNone: () => ({
			opened: true,
			lines: [`tuval: opened the project ${folder} in the running desk`],
		}),
		onSome: (opened) => ({
			opened: true,
			lines: [
				`tuval: opened the project ${opened.name} (${folder}) in the running desk — ${opened.programs} program(s), ${opened.processes} process(es)`,
				...opened.refused.map((refusal) => `tuval: ${refusal}`),
			],
		}),
	});
};
