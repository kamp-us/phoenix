/**
 * The page's one connection lifecycle: open a link to the kernel, hand it out, wait for it to end,
 * and open the next one. A page holds exactly one of these, so a drop has one owner and a repair has
 * one place to happen.
 *
 * A link is never repaired — attaching again is the repair, and the server replays current state
 * rather than a transcript (`../shell/transport/client.ts`), which is what makes an automatic
 * re-attach safe: nothing the founder typed is replayed, because nothing here holds a pending
 * mutation to replay. A dispatch that was in flight when the socket went answers `ProcessGone` and
 * stops there.
 *
 * Replacing a link does not touch a process. The kernel owns process lifetime, this owns the socket,
 * and the two never meet: a page that drops and re-attaches finds the same processes it left.
 *
 * **Why the retry budget is a count and not a cause.** The browser will not say whether an upgrade
 * was refused or the kernel was simply unreachable. RFC 6455 §7.1.7 requires a client that fails the
 * connection to not "convey the failure information to scripts in a way that would allow a script to
 * distinguish" a refused handshake from an unreachable server, and Effect's own WebSocket wiring
 * reflects exactly that: an `error` event before the socket opened becomes
 * `SocketOpenError{kind: "Unknown"}` carrying the bare `Event`, with no status on it
 * (`effect/unstable/socket/Socket.ts`, `onError`). So the page cannot branch on the cause; it bounds
 * the run instead, and the refusal it lands on names both readings rather than inventing one.
 *
 * The one cause the page *can* read is a policy close: the server closes with 1008 when the two ends
 * disagree about the wire, and so does this page (`../shell/transport/client.ts`). Attaching again
 * repeats it byte for byte, so that arm refuses at once.
 */

import {Duration, Effect, Fiber, Option, Schema, type Scope, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import {useEffect, useState} from "react";
import type {ProcessId} from "../process/process.ts";
import type {ShellMsg} from "../shell/core/index.ts";
import type {AttachedProcess, PageAttachment} from "../shell/transport/browser.ts";
import {attach, SHELL_PROGRAM_ID} from "../shell/transport/browser.ts";

const LAUNCH_ENDPOINT = "/__tuval/launch";

/** The page has no kernel to attach to. Retryable: the page server may simply not be up yet. */
class NoLaunchUrl extends Schema.TaggedError<NoLaunchUrl>()("tuval/page/NoLaunchUrl", {
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return `${LAUNCH_ENDPOINT} did not answer with a launch URL: ${String(this.cause)}`;
	}
}

/** The kernel answered, but runs no shell — there is no desk to mount. */
class NoShellProcess extends Schema.TaggedError<NoShellProcess>()("tuval/page/NoShellProcess", {}) {
	override get message(): string {
		return "this kernel is running no shell process";
	}
}

/** The close code both ends send when a frame did not decode — the one refusal a page can read. */
const POLICY_CLOSE = 1008;

/** What ended an attempt, as far as the answer changes. */
export type DropKind =
	/** The socket never opened: a refused handshake and an unreachable kernel are one thing here. */
	| "never-opened"
	/** The two ends disagree about the wire. Attaching again repeats it. */
	| "protocol"
	/** The socket was working and went away, or the kernel had nothing to attach to yet. */
	| "dropped";

export const dropKind = (error: unknown): DropKind => {
	if (!Socket.SocketError.is(error)) return "dropped";
	if (error.reason._tag === "SocketOpenError") return "never-opened";
	return error.reason._tag === "SocketCloseError" && error.reason.code === POLICY_CLOSE
		? "protocol"
		: "dropped";
};

export interface Recovery {
	readonly firstDelayMillis: number;
	/** The ceiling the backoff climbs to. A gap is bounded by this, never by the doubling. */
	readonly maxDelayMillis: number;
	/** Consecutive failed attempts before the page stops and says why. `0` never retries. */
	readonly attempts: number;
}

/**
 * Fast enough that a blip is invisible, patient enough to outlast a laptop waking up: at these
 * numbers a run of 30 spans a little over two minutes before the page gives up and says so.
 */
export const defaultRecovery: Recovery = {
	firstDelayMillis: 250,
	maxDelayMillis: 5_000,
	attempts: 30,
};

/** No recovery at all — the control the browser proof's negative arm runs the same page under. */
export const noRecovery: Recovery = {firstDelayMillis: 0, maxDelayMillis: 0, attempts: 0};

export type NextAttempt =
	| {readonly _tag: "Wait"; readonly delayMillis: number}
	| {readonly _tag: "Refuse"; readonly reason: string};

/** `failures` counts consecutive failed attempts, this one included, and resets on a working link. */
export const nextAttempt = (
	recovery: Recovery,
	kind: DropKind,
	failures: number,
	reason: string,
): NextAttempt => {
	if (kind === "protocol") {
		return {
			_tag: "Refuse",
			reason: `this page and the kernel disagree about the wire (${reason}). Reload the page to pick up the kernel's own version.`,
		};
	}
	if (failures >= recovery.attempts) {
		return {
			_tag: "Refuse",
			reason:
				kind === "never-opened"
					? `the kernel refused or did not answer ${failures} attempt(s) (${reason}). It may have stopped, or this page's launch token is no longer the one it minted — open the kernel's own launch URL again.`
					: `the connection dropped ${failures} time(s) without recovering (${reason}). Reload the page.`,
		};
	}
	const doubled = recovery.firstDelayMillis * 2 ** (failures - 1);
	return {_tag: "Wait", delayMillis: Math.min(recovery.maxDelayMillis, doubled)};
};

/** One link to the kernel: the socket's own handles, plus the shell process the desk mounts over. */
export interface PageLink {
	readonly page: PageAttachment;
	readonly shell: AttachedProcess<unknown, ShellMsg>;
}

const launchUrl = Effect.tryPromise({
	try: () =>
		fetch(LAUNCH_ENDPOINT).then((response) => response.json() as Promise<{readonly url: string}>),
	catch: (cause) => new NoLaunchUrl({cause}),
}).pipe(Effect.map((answer) => answer.url));

/** The shell's process id, read off the table — the page assumes none (#7556). */
const shellProcessOf = (
	rows: Stream.Stream<ReadonlyArray<{readonly id: string; readonly programId: string}>>,
) =>
	Stream.runHead(
		Stream.flatMap(rows, (list) => {
			const shell = list.find((row) => row.programId === SHELL_PROGRAM_ID);
			return shell === undefined ? Stream.empty : Stream.succeed(shell.id);
		}),
	);

/**
 * Open one link. The shell lookup races the socket ending because `rows` never completes: a socket
 * that goes away mid-lookup would otherwise leave this waiting for a row no one will send.
 */
const openLink = Effect.fn("tuval.page.openLink")(function* () {
	const url = yield* launchUrl;
	const page = yield* attach(url);
	const lost = Effect.flatMap(page.closed, (error) => Effect.fail(error));
	const shellProcess = yield* Effect.raceFirst(shellProcessOf(page.rows), lost);
	if (Option.isNone(shellProcess)) return yield* Effect.fail(new NoShellProcess());
	const shell = yield* page.attachProcess<unknown, ShellMsg>(shellProcess.value as ProcessId);
	return {page, shell} satisfies PageLink;
});

/**
 * How the loop opens a link. Every failure it can carry reads as a sentence, and that sentence is
 * all the loop wants — the one cause it branches on it reads off the socket error itself.
 */
type OpenLink = Effect.Effect<
	PageLink,
	{readonly message: string},
	Scope.Scope | Socket.WebSocketConstructor
>;

/** The page's own: the launch endpoint, the socket, and the shell process off the kernel's table. */
const openPageLink: OpenLink = openLink();

/** Whether an attempt ever became a working link decides whether the failure run starts over. */
type Outcome =
	| {readonly _tag: "Ended"; readonly error: unknown}
	| {readonly _tag: "NeverLinked"; readonly error: {readonly message: string}};

export interface Driver<R = never> {
	readonly recovery: Recovery;
	/** Called once per working link, with the one the page should render from now on. */
	readonly onLink: (link: PageLink) => void;
	/** Called once, when the page has stopped trying. The reason is what a founder reads. */
	readonly onRefusal: (reason: string) => void;
	/** How a link is opened. A test supplies its own, and drives the whole loop without a socket. */
	readonly open: Effect.Effect<PageLink, {readonly message: string}, Scope.Scope | R>;
}

const oneAttempt = <R>(driver: Driver<R>): Effect.Effect<Outcome, never, R> =>
	driver.open.pipe(
		Effect.flatMap((link) =>
			Effect.andThen(
				Effect.sync(() => driver.onLink(link)),
				Effect.map(link.page.closed, (error) => ({_tag: "Ended", error}) as const),
			),
		),
		Effect.scoped,
		Effect.catch((error) => Effect.succeed({_tag: "NeverLinked", error} as const)),
	);

const reasonOf = (error: unknown): string =>
	typeof error === "object" && error !== null && "message" in error
		? String((error as {readonly message: unknown}).message)
		: String(error);

/**
 * The loop. It ends only when the page stops trying; a caller runs it forked and interrupts it when
 * the page goes away, which is what closes the last link's scope.
 */
export const drive = <R>(driver: Driver<R>): Effect.Effect<void, never, R> =>
	Effect.gen(function* () {
		let failures = 0;
		for (;;) {
			const outcome = yield* oneAttempt(driver);
			failures = outcome._tag === "Ended" ? 1 : failures + 1;
			const next = nextAttempt(
				driver.recovery,
				dropKind(outcome.error),
				failures,
				reasonOf(outcome.error),
			);
			if (next._tag === "Refuse") return yield* Effect.sync(() => driver.onRefusal(next.reason));
			yield* Effect.sleep(Duration.millis(next.delayMillis));
		}
	});

export interface PageConnection {
	/** The link to render from. `null` before the first one; never `null` again once one has landed. */
	readonly link: PageLink | null;
	/** Set once the page has stopped trying, and never unset. A retained desk is stale from here on. */
	readonly refusal: string | null;
}

const disconnected: PageConnection = {link: null, refusal: null};

/**
 * Run the lifecycle for as long as the component lives. `recovery` must be a stable value — the loop
 * restarts when it changes, and a fresh object every render would restart it every render.
 */
export const usePageConnection = (recovery: Recovery): PageConnection => {
	const [state, setState] = useState<PageConnection>(disconnected);

	useEffect(() => {
		let live = true;
		const fiber = Effect.runFork(
			drive({
				recovery,
				open: openPageLink,
				onLink: (link) => {
					if (live) setState((current) => ({...current, link}));
				},
				onRefusal: (reason) => {
					if (live) setState((current) => ({...current, refusal: reason}));
				},
			}).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal), Effect.scoped),
		);
		return () => {
			live = false;
			void Effect.runFork(Fiber.interrupt(fiber));
		};
	}, [recovery]);

	return state;
};
