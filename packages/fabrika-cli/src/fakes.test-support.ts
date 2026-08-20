/**
 * Scripted stand-ins for the two IO seams, so every verb's refusal path is as testable as its
 * answer path — including the ones a real broken tree cannot be asked to produce on demand.
 *
 * Both are **substituted platform layers**, not hand-rolled doubles: `FileSystem.layerNoop` for the
 * filesystem and a canned `ChildProcessSpawner` for subprocesses, per
 * [.patterns/effect-platform-access.md](../../../.patterns/effect-platform-access.md) and
 * [.patterns/effect-process-cli-shell.md](../../../.patterns/effect-process-cli-shell.md). The seam
 * a test replaces is therefore the same seam production uses.
 */
import {Effect, FileSystem, Layer, Option, Path, PlatformError, Sink, Stream} from "effect";
import type * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {ChildProcessSpawner} from "effect/unstable/process";
import type {ExecResult} from "./io/exec.ts";

const enc = new TextEncoder();

const notFound = (method: string, path: string) =>
	Effect.fail(
		PlatformError.systemError({
			_tag: "NotFound",
			module: "FileSystem",
			method,
			pathOrDescriptor: path,
		}),
	);

const denied = (method: string, path: string) =>
	Effect.fail(
		PlatformError.systemError({
			_tag: "PermissionDenied",
			module: "FileSystem",
			method,
			pathOrDescriptor: path,
		}),
	);

/** Only `type` is read by anything under test; the rest of `File.Info` is filler the shape demands. */
const info = (type: "File" | "Directory"): FileSystem.File.Info => ({
	type,
	mtime: Option.none(),
	atime: Option.none(),
	birthtime: Option.none(),
	dev: 0,
	ino: Option.none(),
	mode: 0,
	nlink: Option.none(),
	uid: Option.none(),
	gid: Option.none(),
	rdev: Option.none(),
	size: FileSystem.Size(0),
	blksize: Option.none(),
	blocks: Option.none(),
});

export interface FakeFsOptions {
	/** Directory path → base names. An absent or `null` entry makes the directory unreadable. */
	readonly dirs?: Readonly<Record<string, ReadonlyArray<string> | null>>;
	/** File path → contents. An absent or `null` entry makes the file **absent** (`NotFound`). */
	readonly files?: Readonly<Record<string, string | null>>;
	/**
	 * Paths whose read fails for a reason other than absence — `PermissionDenied`.
	 *
	 * Distinct from an absent file on purpose: a caller that folds the two together turns "I could
	 * not open it" into "it was deleted", which is the fail-open direction (#5304).
	 */
	readonly unreadable?: ReadonlyArray<string>;
	/** Paths whose writes fail. */
	readonly unwritable?: ReadonlyArray<string>;
	/** Paths whose existence check itself fails — distinct from a path that is absent. */
	readonly unprobeable?: ReadonlyArray<string>;
	/** Symlink path → the path it really is. Anything unlisted is its own real path. */
	readonly real?: Readonly<Record<string, string>>;
	/**
	 * Directories that exist without holding a listed file — a workspace root, say.
	 *
	 * Separate from {@link FakeFsOptions.dirs}, which answers `readDirectory`: a caller asking
	 * whether a directory is *there* is asking a different question from one asking what is in it,
	 * and a fake that answered the first from the second would make an unlistable directory absent.
	 */
	readonly directories?: ReadonlyArray<string>;
	/** Paths whose removal fails — distinct from a removal that lands and leaves the path behind. */
	readonly unremovable?: ReadonlyArray<string>;
	/** Paths a removal is scripted to NOT actually remove, so the re-probe has something to catch. */
	readonly survivesRemoval?: ReadonlyArray<string>;
}

export interface FakeFs {
	readonly layer: Layer.Layer<FileSystem.FileSystem | Path.Path>;
	/** Everything the verb under test actually wrote — `size === 0` is "nothing was written". */
	readonly written: Map<string, string>;
}

/** An in-memory filesystem layer that can be told to fail a specific read, probe or write. */
export const fakeFs = (options: FakeFsOptions): FakeFs => {
	const dirs: Record<string, ReadonlyArray<string> | null> = {...options.dirs};
	const files: Record<string, string | null> = {...options.files};
	const written = new Map<string, string>();
	const directories = new Set(options.directories ?? []);
	const decoder = new TextDecoder();
	const layer = Layer.merge(
		FileSystem.layerNoop({
			readDirectory: (path: string) => {
				const names = dirs[path];
				return names === undefined || names === null
					? notFound("readDirectory", path)
					: Effect.succeed([...names]);
			},
			readFileString: (path: string) => {
				if (options.unreadable?.includes(path) === true) return denied("readFileString", path);
				const text = files[path];
				return text === undefined || text === null
					? notFound("readFileString", path)
					: Effect.succeed(text);
			},
			exists: (path: string) =>
				options.unprobeable?.includes(path) === true
					? notFound("exists", path)
					: Effect.succeed(
							(Object.hasOwn(files, path) && files[path] !== null) || directories.has(path),
						),
			stat: (path: string) => {
				if (options.unprobeable?.includes(path) === true) return notFound("stat", path);
				if (directories.has(path) || dirs[path] != null) return Effect.succeed(info("Directory"));
				return Object.hasOwn(files, path) && files[path] !== null
					? Effect.succeed(info("File"))
					: notFound("stat", path);
			},
			makeDirectory: (path: string) => {
				if (options.unwritable?.includes(path) === true) return notFound("makeDirectory", path);
				directories.add(path);
				return Effect.void;
			},
			realPath: (path: string) => Effect.succeed(options.real?.[path] ?? path),
			remove: (path: string) => {
				if (options.unremovable?.includes(path) === true) return denied("remove", path);
				if (options.survivesRemoval?.includes(path) === true) return Effect.void;
				directories.delete(path);
				for (const key of Object.keys(files)) {
					if (key === path || key.startsWith(`${path}/`)) delete files[key];
				}
				return Effect.void;
			},
			writeFileString: (
				path: string,
				data: string,
				opts?: {readonly flag?: string | undefined},
			) => {
				if (options.unwritable?.includes(path) === true) return notFound("writeFileString", path);
				// An append flag appends here too, because a caller that appends and one that overwrites
				// leave different bytes on disk and a fake that flattened them would hide the difference.
				const appending = opts?.flag?.startsWith("a") === true;
				const next = appending ? `${files[path] ?? ""}${data}` : data;
				files[path] = next;
				written.set(path, next);
				return Effect.void;
			},
			writeFile: (path: string, data: Uint8Array) => {
				if (options.unwritable?.includes(path) === true) return notFound("writeFile", path);
				const text = decoder.decode(data);
				files[path] = text;
				written.set(path, text);
				return Effect.void;
			},
		}),
		Path.layer,
	);
	return {layer, written};
};

export interface FakeShell {
	readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
	/** Every command line spawned, in order — how a test asserts the fetch preceded the read. */
	readonly calls: ReadonlyArray<string>;
	/**
	 * What was piped to each spawned command's stdin, aligned with {@link FakeShell.calls}; `""` when
	 * nothing was.
	 *
	 * Without it, a caller that hands bytes to a child through stdin is indistinguishable from one
	 * that hands it nothing — the argv is identical (`git commit -F -`) either way — so the whole
	 * file-free carrying path would be untestable at this seam (#5484).
	 */
	readonly inputs: ReadonlyArray<string>;
}

/** The bytes a command's `stdin` option carries, decoded; `""` for a mode string or no option. */
const pipedInput = (stdin: unknown): Effect.Effect<string> => {
	if (stdin === undefined || typeof stdin === "string") return Effect.succeed("");
	const source =
		typeof stdin === "object" && stdin !== null && "stream" in stdin
			? (stdin as {readonly stream: unknown}).stream
			: stdin;
	if (source === undefined || typeof source === "string") return Effect.succeed("");
	return Stream.decodeText(source as Stream.Stream<Uint8Array, unknown>).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);
};

/**
 * A spawner scripted on the joined `file arg arg …` command line.
 *
 * The script speaks in {@link ExecResult}s because that is what a caller reads; the spawner maps
 * `ok: false` onto a non-zero exit with the reason on stderr, which is the shape `execCapture`
 * lowers back into the same record.
 *
 * `unstartable` is the third answer, and it is not expressible as an `ExecResult`: a binary absent
 * from `PATH` never runs at all, and the spawn fails with a `PlatformError` where a child that runs
 * and exits non-zero does not. A caller that tells a red from an UNKNOWN reads exactly that
 * difference, so a test over it needs the two scripted apart ({@link faultingShell} fails every
 * spawn, which cannot express "`git` works and `actionlint` is not installed").
 */
export const fakeShell = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	fallback: ExecResult = {ok: false, stdout: "", reason: "unscripted command"},
	unstartable: ReadonlyArray<RegExp> = [],
): FakeShell => {
	const calls: string[] = [];
	const inputs: string[] = [];
	const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const line =
					cmd._tag === "StandardCommand" ? [cmd.command, ...cmd.args].join(" ") : "<piped>";
				calls.push(line);
				inputs.push(
					yield* pipedInput(cmd._tag === "StandardCommand" ? cmd.options.stdin : undefined),
				);
				if (unstartable.some((pattern) => pattern.test(line))) {
					return yield* Effect.fail(
						PlatformError.badArgument({
							module: "ChildProcess",
							method: "spawn",
							description: `spawn ${cmd._tag === "StandardCommand" ? cmd.command : line} ENOENT`,
						}),
					);
				}
				const result = script.find(([pattern]) => pattern.test(line))?.[1] ?? fallback;
				return ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(1),
					stdin: Sink.drain,
					stdout: Stream.fromIterable([enc.encode(result.ok ? result.stdout : "")]),
					stderr: Stream.fromIterable([enc.encode(result.ok ? "" : result.reason)]),
					all: Stream.fromIterable([enc.encode(result.ok ? result.stdout : result.reason)]),
					exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.ok ? 0 : 1)),
					isRunning: Effect.succeed(false),
					kill: () => Effect.void,
					getInputFd: () => Sink.drain,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				});
			}),
		),
	);
	return {layer, calls, inputs};
};

/**
 * A spawner whose spawn itself fails with a `PlatformError` — the "`git`/`gh` not on PATH" fault
 * `execCapture` folds into `ok: false`. Distinct from a command that ran and exited non-zero.
 */
export const faultingShell: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
)(
	ChildProcessSpawner.make(() =>
		Effect.fail(
			PlatformError.badArgument({
				module: "ChildProcess",
				method: "spawn",
				description: "spawn git ENOENT",
			}),
		),
	),
);

/**
 * The `PlatformError` `NodeChildProcessSpawner` really fails a signal-killed child's `exitCode` with
 * — reproduced through the same `PlatformError.systemError` constructor and the same nested `cause`,
 * so a test over it binds to the dependency's shape rather than to a literal string (#4792).
 */
export const signalledExitError = (
	signal: NodeJS.Signals,
	commandLine: string,
): PlatformError.PlatformError =>
	PlatformError.systemError({
		_tag: "Unknown",
		module: "ChildProcess",
		method: "exitCode",
		pathOrDescriptor: commandLine,
		cause: new globalThis.Error(`Process interrupted due to receipt of signal: '${signal}'`),
	});

/** A spawner that spawns fine and whose child is then killed by `signal`. */
export const signalledShell = (
	signal: NodeJS.Signals,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make((command) =>
			Effect.succeed(
				ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(1),
					stdin: Sink.drain,
					stdout: Stream.empty,
					stderr: Stream.empty,
					all: Stream.empty,
					exitCode: Effect.fail(
						signalledExitError(
							signal,
							command._tag === "StandardCommand"
								? [command.command, ...command.args].join(" ")
								: "<piped>",
						),
					),
					isRunning: Effect.succeed(false),
					kill: () => Effect.void,
					getInputFd: () => Sink.drain,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				}),
			),
		),
	);

/**
 * A pattern that matches at most once, so a script can answer the *same* command line differently on
 * successive calls.
 *
 * {@link fakeShell} resolves each call by the first entry whose pattern matches, which cannot express
 * a seam that is read twice on purpose — a reconcile reads the issue, writes, then re-reads the very
 * same endpoint. Without this, the observed state and the read-back are forced to be identical, and
 * every read-back test would be asserting against the input it already knew.
 */
export const once = (source: RegExp): RegExp => {
	const pattern = new RegExp(source.source, source.flags);
	let spent = false;
	pattern.test = (line: string): boolean => {
		if (spent) return false;
		spent = RegExp.prototype.test.call(pattern, line);
		return spent;
	};
	return pattern;
};

export const okOut = (stdout: string): ExecResult => ({ok: true, stdout, reason: ""});

export const errOut = (reason: string): ExecResult => ({ok: false, stdout: "", reason});

/**
 * A tree with no `.fabrika.jsonc` in it — every config key resolves to its shipped default.
 *
 * The layer a verb needs once it reads the path surface (#6296) and the test is not about the
 * config. It is `fakeFs`'s empty case rather than a second noop layer so a test that later *does*
 * declare a config swaps this for a `fakeFs({files: {…}})` and nothing else changes.
 */
export const unconfigured: Layer.Layer<FileSystem.FileSystem | Path.Path> = fakeFs({}).layer;

/** `git ls-tree --name-only` output: one name per line. */
export const tree = (...names: ReadonlyArray<string>): string => names.join("\n");

/** A minimal well-formed record. */
export const record = (id: string, status: string, extra = ""): string =>
	`---
id: ${id}
title: A decision about ${id}
status: ${status}
date: 2026-01-01
tags: []
---

# ${id} — A decision about ${id}

## Decision

**Something is decided.** ${extra}
`;

/** One scripted HTTP answer. `headers` is where a `Link` completeness proof is scripted. */
export interface HttpReply {
	readonly status: number;
	readonly body: string;
	readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface FakeHttp {
	readonly layer: Layer.Layer<HttpClient.HttpClient>;
	/** Every request issued, as `METHOD url`, in order — how a test asserts a read never happened. */
	readonly calls: ReadonlyArray<string>;
	/** What each request carried as its body, aligned with {@link FakeHttp.calls}; `""` when none. */
	readonly bodies: ReadonlyArray<string>;
	/** What each request carried as headers, aligned with {@link FakeHttp.calls}. */
	readonly headers: ReadonlyArray<Readonly<Record<string, string>>>;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

const requestBody = (body: HttpBody.HttpBody): string => {
	if (body._tag === "Uint8Array") return new TextDecoder().decode(body.body);
	if (body._tag === "Raw") return typeof body.body === "string" ? body.body : "";
	return "";
};

/**
 * An `HttpClient` scripted on `METHOD url`, substituting the **service** the production path uses —
 * the same move {@link fakeShell} makes for `ChildProcessSpawner`, so the seam a test replaces is
 * the seam production runs on rather than a hand-rolled function double.
 *
 * `unreachable` is the third answer and it is not expressible as a reply: a transport fault produces
 * no status at all, where a served `500` does. A caller that tells "GitHub said no" from "GitHub was
 * never reached" reads exactly that difference.
 */
export const fakeHttp = (
	script: ReadonlyArray<readonly [RegExp, HttpReply]>,
	fallback: HttpReply = {status: 500, body: '{"message":"unscripted request"}'},
	unreachable: ReadonlyArray<RegExp> = [],
): FakeHttp => {
	const calls: string[] = [];
	const bodies: string[] = [];
	const headers: Array<Readonly<Record<string, string>>> = [];
	const layer = Layer.succeed(HttpClient.HttpClient)(
		HttpClient.make((request, url) => {
			const line = `${request.method} ${url.toString()}`;
			calls.push(line);
			bodies.push(requestBody(request.body));
			headers.push(request.headers);
			if (unreachable.some((pattern) => pattern.test(line))) {
				return Effect.fail(
					new HttpClientError.HttpClientError({
						reason: new HttpClientError.TransportError({
							request,
							cause: new Error(`${url.host} could not be reached`),
						}),
					}),
				);
			}
			const reply = script.find(([pattern]) => pattern.test(line))?.[1] ?? fallback;
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					// undici throws on a body at a null-body status, so `204` — what GitHub answers a
					// successful delete with — is only scriptable if the body is dropped here.
					new Response(NULL_BODY_STATUSES.has(reply.status) ? null : reply.body, {
						status: reply.status,
						headers: {...reply.headers},
					}),
				),
			);
		}),
	);
	return {layer, calls, bodies, headers};
};

/** A served page of a bare-array read, with the `Link` header that says another page follows. */
export const linkNext = (url: string): Record<string, string> => ({link: `<${url}>; rel="next"`});
