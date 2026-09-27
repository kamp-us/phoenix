/**
 * The creation lock's verdicts and its release, on a real filesystem in a temp dir. The one thing
 * injected is {@link LockHost}: which pids count as alive, and what time it is.
 */
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {Effect, FileSystem, Option} from "effect";
import {afterAll, describe, expect, it} from "vitest";
import {
	acquireCreationLock,
	HOLD_HORIZON_MS,
	type Holder,
	holderIsLive,
	type LockHost,
	lockDirFor,
	parseStamp,
	processAlive,
	releaseCreationLock,
	STAMP_GRACE_MS,
	stampOf,
	withCreationLock,
} from "./creation-lock.ts";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, {recursive: true, force: true});
});

const freshLock = (): string => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-creation-lock-"));
	roots.push(root);
	return lockDirFor(root);
};

const NOW = 1_800_000_000_000;

const host = (alive: ReadonlyArray<number>, now = NOW): LockHost => ({
	pid: 4242,
	host: "this-host",
	now: () => now,
	alive: (pid) => alive.includes(pid),
});

const plant = (lockDir: string, holder: Holder): void => {
	mkdirSync(lockDir, {recursive: true});
	writeFileSync(join(lockDir, "holder"), stampOf(holder));
};

const sibling = (over: Partial<Holder> = {}): Holder => ({
	id: "sibling",
	pid: 777,
	host: "this-host",
	at: NOW - 1_000,
	...over,
});

const withFs = <A>(program: (fs: FileSystem.FileSystem) => Effect.Effect<A>): Promise<A> =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* program(yield* FileSystem.FileSystem);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

describe("a holder's liveness", () => {
	it("is its process's on this host", () => {
		expect(holderIsLive(sibling(), host([777]))).toBe(true);
		expect(holderIsLive(sibling(), host([]))).toBe(false);
	});

	it("ends at the horizon even while its pid answers, since the harness ended that hook", () => {
		const old = sibling({at: NOW - HOLD_HORIZON_MS - 1});
		expect(holderIsLive(old, host([777]))).toBe(false);
	});

	it("is judged by age alone on another host, whose pids name nothing here", () => {
		expect(holderIsLive(sibling({host: "elsewhere"}), host([]))).toBe(true);
		expect(
			holderIsLive(sibling({host: "elsewhere", at: NOW - HOLD_HORIZON_MS - 1}), host([])),
		).toBe(false);
	});

	it("reads this process as alive and an exited one as gone", () => {
		expect(processAlive(process.pid)).toBe(true);
		// Well above any pid_max a CI runner or a Mac hands out.
		expect(processAlive(2 ** 30)).toBe(false);
	});

	it("parses only stamps this module wrote", () => {
		expect(parseStamp(stampOf(sibling()))).toEqual(Option.some(sibling()));
		expect(parseStamp("abc 123")).toEqual(Option.none());
		expect(parseStamp(JSON.stringify({id: "x", pid: "7", host: "h", at: 1}))).toEqual(
			Option.none(),
		);
	});
});

describe("taking the lock", () => {
	it("takes a vacant lock and stamps it with this process", async () => {
		const lockDir = freshLock();
		const got = await withFs((fs) => acquireCreationLock(fs, lockDir, host([]), 0));

		expect(got._tag).toBe("Held");
		const stamp = parseStamp(readFileSync(join(lockDir, "holder"), "utf8"));
		expect(Option.map(stamp, (s) => s.pid)).toEqual(Option.some(4242));
	});

	it("waits on a live holder and answers Busy naming it", async () => {
		const lockDir = freshLock();
		plant(lockDir, sibling());

		const got = await withFs((fs) => acquireCreationLock(fs, lockDir, host([777]), 0));

		expect(got).toEqual({_tag: "Busy", holder: Option.some(sibling())});
		expect(parseStamp(readFileSync(join(lockDir, "holder"), "utf8"))).toEqual(
			Option.some(sibling()),
		);
	});

	it("takes over a lock whose holder's process is gone, however young its stamp", async () => {
		const lockDir = freshLock();
		plant(lockDir, sibling({at: NOW}));

		const got = await withFs((fs) => acquireCreationLock(fs, lockDir, host([]), 0));

		expect(got._tag).toBe("Held");
		const stamp = parseStamp(readFileSync(join(lockDir, "holder"), "utf8"));
		expect(Option.map(stamp, (s) => s.pid)).toEqual(Option.some(4242));
	});

	it("leaves an unstamped lock alone inside the grace, and takes it after", async () => {
		const young = freshLock();
		mkdirSync(young, {recursive: true});
		const waited = await withFs((fs) => acquireCreationLock(fs, young, host([], Date.now()), 0));
		expect(waited._tag).toBe("Busy");

		const old = freshLock();
		mkdirSync(old, {recursive: true});
		const later = host([], Date.now() + STAMP_GRACE_MS + 1_000);
		const taken = await withFs((fs) => acquireCreationLock(fs, old, later, 0));
		expect(taken._tag).toBe("Held");
	});

	it("answers Unplaceable when the lock's parent cannot be created", async () => {
		const root = mkdtempSync(join(tmpdir(), "fabrika-creation-lock-"));
		roots.push(root);
		writeFileSync(join(root, "fabrika"), "a file where the directory would go");

		const got = await withFs((fs) => acquireCreationLock(fs, lockDirFor(root), host([]), 0));

		expect(got._tag).toBe("Unplaceable");
	});
});

describe("releasing the lock", () => {
	it("frees it only while the stamp is still this holder's", async () => {
		const lockDir = freshLock();
		plant(lockDir, sibling());

		await withFs((fs) =>
			releaseCreationLock(fs, lockDir, {id: "me", pid: 4242, host: "this-host", at: NOW}),
		);

		expect(existsSync(lockDir)).toBe(true);
	});

	it.each([
		["an answer", Effect.succeed("done")],
		["a defect", Effect.die(new Error("boom"))],
	])("releases it when the body ends in %s", async (_label, body) => {
		const lockDir = freshLock();
		await withFs((fs) =>
			Effect.exit(
				withCreationLock(fs, lockDir, host([]), body, {
					onBusy: () => "busy",
					onUnplaceable: () => "unplaceable",
				}),
			),
		);

		expect(existsSync(lockDir)).toBe(false);
	});

	it("holds it for exactly the body", async () => {
		const lockDir = freshLock();
		const inside = await withFs((fs) =>
			withCreationLock(
				fs,
				lockDir,
				host([]),
				Effect.sync(() => existsSync(lockDir)),
				{onBusy: () => false, onUnplaceable: () => false},
			),
		);

		expect(inside).toBe(true);
		expect(existsSync(lockDir)).toBe(false);
	});
});
