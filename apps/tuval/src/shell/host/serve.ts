/**
 * The one caller of `serve` (`../transport/server.ts`). Until this module landed the transport was
 * a server nothing started — [#7780](https://github.com/kamp-us/phoenix/issues/7780).
 *
 * `handles` is `Processes.handle` rather than a map the caller collected: the picker spawns
 * processes long after the socket opened, and a snapshot taken at boot could only ever serve the
 * processes that existed then.
 */

import {Context, Effect} from "effect";
import {Processes} from "../../process/Processes.ts";
import type {ProcessTable} from "../../process/ProcessTable.ts";
import type {Registry} from "../../registry/Registry.ts";
import type {ProcessTablePort} from "../../table/ProcessTablePort.ts";
import type {PrefixTable} from "../keys/index.ts";
import {mintLaunchToken} from "../transport/handshake.ts";
import {serve, type TransportServer} from "../transport/server.ts";

export interface ServeDeskOptions {
	/** The kernel `start`/`boot` built. Every service the socket reads comes from here. */
	readonly kernel: Context.Context<Registry | Processes | ProcessTable | ProcessTablePort>;
	/** `0` binds an ephemeral port — what a test wants; the bin names a real one. */
	readonly port: number;
	readonly host?: string;
	/**
	 * The key grammar every attached page is sent and routes over (ADR 0353). It is the caller's,
	 * because a kernel context does not carry it: the shell row closes over the table it was built
	 * with and no registry row hands one back — [#7890](https://github.com/kamp-us/phoenix/issues/7890).
	 */
	readonly table: PrefixTable;
}

export type DeskServer = TransportServer;

/**
 * Serve one desk. The launch token is minted here and never leaves this process except inside the
 * URL it returns, so nothing writes it to disk and nothing logs it apart from that one line.
 */
export const serveDesk = Effect.fn("Tuval.shell.serveDesk")(function* (options: ServeDeskOptions) {
	const processes = Context.get(options.kernel, Processes);
	return yield* serve({
		token: mintLaunchToken(),
		port: options.port,
		...(options.host === undefined ? {} : {host: options.host}),
		handles: processes.handle,
		table: options.table,
	}).pipe(Effect.provideContext(options.kernel), Effect.orDie);
});
