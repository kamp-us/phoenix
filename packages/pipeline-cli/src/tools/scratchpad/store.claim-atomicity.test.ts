/**
 * The claim window (#4864): a run that loses the race to a peer STILL PUBLISHING its owner
 * stamp must be refused `ForeignNamespace` (exit 4) — someone else owns this — and never
 * `NamespaceUnavailable` (exit 6), which says the namespace is broken and is not a condition
 * a caller can retry on.
 *
 * These are deterministic because the mock below reproduces the platform behaviour the defect
 * rests on rather than approximating it. `writeFileSync(path, <utf8 string>)` takes Node's C++
 * fast path (`lib/fs.js`) into `WriteFileUtf8` (`src/node_file.cc`), which is a `uv_fs_open`
 * followed by a SEPARATE `uv_fs_write` loop — so the mock is an `openSync`, a hook, then the
 * write. The hook IS the ordinary preemption point between those two syscalls, held open long
 * enough for a peer's whole `openNamespace` to run inside it; a loaded batch runner widens the
 * same window by descheduling the writer, which is why the failure showed up in a merge-queue
 * batch and not on an idle machine. Load is the trigger, not the defect.
 */
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, assert, beforeEach, describe, it} from "@effect/vitest";
import {vi} from "vitest";
import {OWNER_FILE, parseOwner, type Resolved} from "./scratchpad.ts";
import {openNamespace} from "./store.ts";

const hooks = vi.hoisted(() => ({atOpenWriteBoundary: null as (() => void) | null}));

vi.mock("node:fs", async () => {
	const real = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...real,
		writeFileSync: (
			file: Parameters<typeof real.writeFileSync>[0],
			data: Parameters<typeof real.writeFileSync>[1],
			options?: Parameters<typeof real.writeFileSync>[2],
		) => {
			const flag =
				typeof options === "object" && options !== null && typeof options.flag === "string"
					? options.flag
					: "w";
			const fd = real.openSync(file as string, flag);
			try {
				// Fires ONCE: the peer that runs inside the boundary must not re-enter it on its
				// own writes, or the two runs would recurse into each other instead of racing.
				const hook = hooks.atOpenWriteBoundary;
				hooks.atOpenWriteBoundary = null;
				hook?.();
				real.writeFileSync(fd, data);
			} finally {
				real.closeSync(fd);
			}
		},
	};
});

// Synthetic run identities — never a real machine/session value in a fixture (#4018).
const SESSION = "cccccccc-0000-4000-8000-00000000000c";
const SLUG = "review-doc-3951";

let root: string;

beforeEach(() => {
	hooks.atOpenWriteBoundary = null;
	root = mkdtempSync(join(tmpdir(), "scratchpad-claim-"));
});

afterEach(() => {
	hooks.atOpenWriteBoundary = null;
	rmSync(root, {recursive: true, force: true});
});

// Two concurrent runs of ONE session on ONE slug, told apart only by pid — the exact shape
// the eight-way process race takes, held at the single interleaving that matters.
const input = (pid: string) => ({tmpdir: root, session: SESSION, pid, slug: SLUG});

const ownerFile = () => join(root, "kampus-run", SESSION, SLUG, OWNER_FILE);

const tagOf = (resolved: Resolved<unknown>): string => (resolved.ok ? "ok" : resolved.error._tag);

describe("openNamespace — a peer racing the claim (#4864)", () => {
	it("refuses the loser as ForeignNamespace, not NamespaceUnavailable", () => {
		const outcomes: Resolved<unknown>[] = [];
		hooks.atOpenWriteBoundary = () => {
			outcomes.push(openNamespace(input("pid-peer")));
		};

		outcomes.push(openNamespace(input("pid-first")));
		assert.strictEqual(
			outcomes.length,
			2,
			"the peer must have raced inside the claim's open/write window",
		);
		assert.strictEqual(
			outcomes.filter((outcome) => outcome.ok).length,
			1,
			`exactly one racer may win, got [${outcomes.map(tagOf).join(" ")}]`,
		);
		const loser = outcomes.find((outcome) => !outcome.ok);
		assert.strictEqual(
			loser === undefined ? "none" : tagOf(loser),
			"ForeignNamespace",
			"a run that lost to a peer mid-claim owns exit 4 (someone else holds it), not exit 6 (the namespace is broken)",
		);
	});

	it("never lets the owner stamp be observed in a partial state", () => {
		// The property underneath the exit code: at ANY moment a peer can look, the stamp is
		// either absent or complete. A present-but-unparseable stamp is what made a routine lost
		// race read as an unreadable claim.
		let observed: "absent" | "complete" | "partial" = "absent";
		hooks.atOpenWriteBoundary = () => {
			if (!existsSync(ownerFile())) return;
			observed = parseOwner(readFileSync(ownerFile(), "utf8")) === null ? "partial" : "complete";
		};

		openNamespace(input("pid-first"));
		assert.notStrictEqual(
			observed,
			"partial",
			"the stamp name must never exist without its content",
		);
	});
});
