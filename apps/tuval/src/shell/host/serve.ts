/**
 * The one caller of `serve` (`../transport/server.ts`). Until this module landed the transport was
 * a server nothing started — [#7780](https://github.com/kamp-us/phoenix/issues/7780).
 *
 * `handles` is `Processes.handle` rather than a map the caller collected: the picker spawns
 * processes long after the socket opened, and a snapshot taken at boot could only ever serve the
 * processes that existed then.
 *
 * The spell channel is minted here for the same reason it is not minted in the transport: who a
 * caller is, is kernel vocabulary — an id and the workspace it is looking at — and the transport
 * carries frames and no scope at all (#8161).
 */

import {randomUUID} from "node:crypto";
import {Context, Effect} from "effect";
import {SpellExecutor} from "../../commands/executor.ts";
import {SpellRegistry} from "../../commands/registry.ts";
import type {Client} from "../../commands/scope.ts";
import {ClientId, WorkspaceId} from "../../commands/spell.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import type {Registry} from "../../registry/Registry.ts";
import type {ProcessTablePort} from "../../table/ProcessTablePort.ts";
import type {PrefixTable} from "../keys/index.ts";
import {shellId, shellStateOf} from "../program.ts";
import {mintLaunchToken} from "../transport/handshake.ts";
import {type SpellChannel, serve, type TransportServer} from "../transport/server.ts";

export interface ServeDeskOptions {
	/** The kernel `start`/`boot` built. Every service the socket reads comes from here. */
	readonly kernel: Context.Context<
		Registry | Processes | ProcessTable | ProcessTablePort | SpellExecutor | SpellRegistry
	>;
	/** `0` binds an ephemeral port — what a test wants; the bin names a real one. */
	readonly port: number;
	readonly host?: string;
	/**
	 * The key grammar every attached page is sent and routes over (ADR 0353). It is the caller's,
	 * because a kernel context does not carry it. On the boot path the caller does not name one
	 * either: the shell row publishes the table it resolved and `boot` reports it as
	 * `Booted.keyTable`, which is what `src/bin.ts` passes here (#7890).
	 */
	readonly table: PrefixTable;
}

export type DeskServer = TransportServer;

/**
 * The workspace a call that names no window is scoped to: the one this desk has active, read when
 * the call arrives rather than when the socket opened, so a founder who switches workspaces mid-call
 * is scoped to the one they are actually looking at. A page cannot name it — the protocol lets a
 * page name the window it called from and nothing else (`../../commands/scope.ts`), which is why
 * the kernel reads it here. A kernel serving no desk has no workspace at all, and the empty id
 * names none rather than naming a real one this caller is not in.
 */
const activeWorkspaceOf = (kernel: ServeDeskOptions["kernel"]) =>
	Effect.map(Context.get(kernel, ProcessTable).list, (rows) => {
		const desk = rows.find((row) => row.programId === shellId);
		const state = desk === undefined ? null : shellStateOf(desk.stateSummary().state);
		return WorkspaceId.make(state === null ? "" : state.activeWorkspace);
	});

/** One socket's caller, minted when it opens: two pages are two clients, never one shared identity. */
const spellChannel = (kernel: ServeDeskOptions["kernel"]): SpellChannel =>
	Effect.sync(() => {
		const executor = Context.get(kernel, SpellExecutor);
		const id = ClientId.make(randomUUID());
		return (call) =>
			Effect.flatMap(activeWorkspaceOf(kernel), (workspace) =>
				executor.execute(call, {id, workspace} satisfies Client),
			);
	});

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
		spells: spellChannel(options.kernel),
		descriptions: Context.get(options.kernel, SpellRegistry).changes,
		table: options.table,
	}).pipe(Effect.provideContext(options.kernel), Effect.orDie);
});
