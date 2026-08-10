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
import {Effect, FileSystem, Layer, Path, PlatformError, Sink, Stream} from "effect";
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
					: Effect.succeed(Object.hasOwn(files, path) && files[path] !== null),
			makeDirectory: () => Effect.void,
			realPath: (path: string) => Effect.succeed(options.real?.[path] ?? path),
			writeFileString: (path: string, data: string) => {
				if (options.unwritable?.includes(path) === true) return notFound("writeFileString", path);
				files[path] = data;
				written.set(path, data);
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
}

/**
 * A spawner scripted on the joined `file arg arg …` command line.
 *
 * The script speaks in {@link ExecResult}s because that is what a caller reads; the spawner maps
 * `ok: false` onto a non-zero exit with the reason on stderr, which is the shape `execCapture`
 * lowers back into the same record.
 */
export const fakeShell = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	fallback: ExecResult = {ok: false, stdout: "", reason: "unscripted command"},
): FakeShell => {
	const calls: string[] = [];
	const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const line =
					cmd._tag === "StandardCommand" ? [cmd.command, ...cmd.args].join(" ") : "<piped>";
				calls.push(line);
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
	return {layer, calls};
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
