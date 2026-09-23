/**
 * The window's reading of a notifier, tested where it is decided, and the boundary that reading
 * depends on.
 *
 * `notifyView` is a pure function of state, so what a person sees when they open a notifier is a
 * value here rather than a rendered tree — and `./window.tsx` is left with nowhere to make a
 * decision of its own.
 *
 * The last `describe` is the other half: the window runs in a browser tab, and the kernel's
 * `node:crypto` chain cannot load there. `tsconfig.window.json` keeps that true at compile time by
 * including nothing but the window and its leaves; the import walk below keeps it true at *read*
 * time, by naming the three modules the browser half may reach and refusing everything else. Either
 * one alone can be defeated by a careless include; both together cannot be defeated by accident.
 */

import {readFileSync} from "node:fs";
import {dirname, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {
	type Delivery,
	DROPPED,
	EMPTY_OUTBOX,
	firstLine,
	HISTORY,
	isDelivery,
	isNotifyState,
	type NotifyState,
	notifyView,
	outcome,
	readable,
	sendEvent,
	statusLine,
	titleLine,
} from "./state.ts";

/** Seven in the morning, so the clock lines read the way a morning brief's do. */
const at = (hour: number, minute: number, second = 0): number =>
	new Date(2026, 8, 10, hour, minute, second).getTime();

const idle: NotifyState = {
	id: "phone",
	kind: "ntfy",
	outbox: EMPTY_OUTBOX,
	deliveries: [],
	seq: 0,
};

const sent = (
	hour: number,
	minute: number,
	text: string,
	rest: Omit<Delivery, "text" | "at"> = {ok: true, status: 200},
): Delivery => ({text, at: at(hour, minute), ...rest});

describe("what a window says about a notifier that has sent nothing", () => {
	it("names the notifier, its status, and the spell its composer stands in for", () => {
		const view = notifyView(idle);
		expect(view.heading).toBe("phone · ntfy");
		expect(view.status).toBe("idle");
		expect(view.spell).toBe(":phone send <text>");
		expect(view.log).toEqual([]);
		expect(view.sending).toBeNull();
		expect(view.empty).toBe("Nothing sent yet.");
	});

	it("says the first message is still going rather than that nothing has happened", () => {
		const view = notifyView({
			...idle,
			outbox: {
				inflight: {key: "phone-1", text: "the desk is up"},
				queue: [],
			},
		});
		expect(view.status).toBe("sending");
		expect(view.sending).toEqual({text: "the desk is up", waiting: 0});
		expect(view.empty).toBe("Nothing sent yet — the first message is still going.");
	});

	it("says how many are lined up behind the one on the wire", () => {
		const view = notifyView({
			...idle,
			outbox: {
				inflight: {key: "phone-1", text: "first"},
				queue: [
					{key: "phone-2", text: "second"},
					{key: "phone-3", text: "third"},
				],
			},
		});
		expect(view.sending).toEqual({text: "first", waiting: 2});
	});
});

describe("what a window says about a notifier that has sent something", () => {
	/**
	 * The chat shape, and the one thing about it that matters: the newest message is at the *bottom*,
	 * nearest the composer. State keeps deliveries newest-first because that is what a tile reads;
	 * the reversal is the view's, which is why it is asserted here and nowhere else.
	 */
	it("lists every message oldest first, so the newest is nearest the composer", () => {
		const view = notifyView({
			...idle,
			deliveries: [sent(7, 2, "third"), sent(7, 1, "second"), sent(7, 0, "first")],
		});
		expect(view.log.map((row) => [row.at, row.text])).toEqual([
			["07:00", "first"],
			["07:01", "second"],
			["07:02", "third"],
		]);
	});

	it("carries the text that actually went out, both paths into one log", () => {
		// `:phone send …` and a routed brief are the same arrival in the same cell, so the history does
		// not know which one it is looking at and neither does this list. There is no second section.
		const view = notifyView({
			...idle,
			deliveries: [
				sent(7, 1, "3 PRs merged on phoenix, 1 red on main"),
				sent(7, 0, "the desk is up"),
			],
		});
		expect(view.log.map((row) => row.text)).toEqual([
			"the desk is up",
			"3 PRs merged on phoenix, 1 red on main",
		]);
	});

	it("gives two messages in one minute two keys, so a list never collapses them", () => {
		const twice: NotifyState = {
			...idle,
			deliveries: [sent(7, 0, "second"), sent(7, 0, "first")],
		};
		const keys = notifyView(twice).log.map((row) => row.key);
		expect(new Set(keys).size).toBe(2);
	});

	it("shows at most HISTORY messages, whatever the state carries", () => {
		const many = Array.from({length: HISTORY + 5}, (_, index) => sent(7, 0, `msg ${index}`));
		expect(notifyView({...idle, deliveries: many}).log).toHaveLength(HISTORY);
	});

	it("draws the same two lines the tile does", () => {
		const state = {
			...idle,
			deliveries: [sent(7, 0, "boom", {ok: false, status: 500})],
		};
		expect(notifyView(state).status).toBe(statusLine(state));
		expect(notifyView(state).heading).toBe(titleLine(state));
	});
});

describe("how a row says a delivery ended", () => {
	it("reads `ok · 204` when there was an answer and `ok` when there was no status", () => {
		expect(outcome(sent(7, 0, "x", {ok: true, status: 204}))).toBe("ok · 204");
		// A `stdout` target answers `ok` with no status at all — there is no request to have one.
		expect(outcome(sent(7, 0, "x", {ok: true}))).toBe("ok");
	});

	it("reads `failed · <status>` for a receiver's bad day", () => {
		expect(outcome(sent(7, 0, "x", {ok: false, status: 500}))).toBe("failed · 500");
	});

	it("reads `failed · no answer` when the request never got one", () => {
		// A refused DNS lookup, a dropped socket and a timeout are one outcome here, and it has no
		// number — `target.ts` swallows the cause because the cause carries the URL.
		expect(outcome(sent(7, 0, "x", {ok: false}))).toBe("failed · no answer");
	});

	it("reads the reason when there was no request at all", () => {
		expect(outcome(sent(7, 0, "x", {ok: false, reason: DROPPED}))).toBe(`failed · ${DROPPED}`);
	});

	it("marks the row as failed, so the window can find it by eye", () => {
		const view = notifyView({
			...idle,
			deliveries: [sent(7, 0, "x", {ok: false, reason: DROPPED})],
		});
		expect(view.log[0]?.ok).toBe(false);
		expect(view.log[0]?.outcome).toBe(`failed · ${DROPPED}`);
	});
});

describe("a row is one line", () => {
	it("keeps a one-line message whole", () => {
		expect(firstLine("the desk is up")).toBe("the desk is up");
	});

	it("takes the first line of a brief and says there was more", () => {
		expect(firstLine("3 PRs merged\n1 red on main\nand a flake")).toBe("3 PRs merged …");
	});

	it("says nothing about trailing blank lines, which are not more of the message", () => {
		expect(firstLine("the desk is up\n\n")).toBe("the desk is up");
	});
});

describe("the predicate the page admits this renderer through", () => {
	it("admits a notifier's own state", () => {
		expect(isNotifyState(idle)).toBe(true);
		expect(
			isNotifyState({
				...idle,
				outbox: {inflight: {key: "phone-1", text: "x"}, queue: []},
				deliveries: [sent(7, 0, "x")],
			}),
		).toBe(true);
	});

	it("refuses a delivery from a kernel that predates the log", () => {
		// The honest answer to a skewed shape is the window's refusal placeholder, never a throw
		// inside React (ADR 0358). A checkpoint written before the record carried its text is exactly
		// that shape.
		const older = {
			...idle,
			deliveries: [{ok: true, status: 200, at: at(7, 0)}],
		};
		expect(isNotifyState(older)).toBe(false);
	});

	it("refuses anything that is not a state at all", () => {
		expect(isNotifyState(null)).toBe(false);
		expect(isNotifyState("phone")).toBe(false);
		expect(isNotifyState({...idle, outbox: {inflight: 42, queue: []}})).toBe(false);
	});
});

/**
 * The one migration this package has, and the reason it is a `filter` in `restored` rather than a
 * tolerated shape in the window: `admits` is all-or-nothing, so a handful of records written before
 * deliveries carried their text would make the window refuse to draw the fifty good ones behind
 * them.
 */
describe("a history this version cannot read", () => {
	/** What a checkpoint written before the log existed holds: a verdict, a clock, no message. */
	// biome-ignore lint/plugin: the cast IS the subject — proving `isDelivery` refuses the text-less record an older checkpoint holds means building one the current type already refuses. Permanent: the old shape has no current type to build it from.
	const beforeText = {
		ok: true,
		status: 200,
		at: at(7, 0),
	} as unknown as Delivery;

	it("does not admit a text-less record", () => {
		expect(isDelivery(beforeText)).toBe(false);
		expect(isDelivery(sent(7, 0, "the desk is up"))).toBe(true);
	});

	it("drops the text-less records and keeps every readable one", () => {
		const mixed = [sent(7, 5, "new"), beforeText, sent(7, 1, "older"), beforeText];
		expect(readable(mixed)).toEqual([sent(7, 5, "new"), sent(7, 1, "older")]);
	});

	it("leaves a history it can read entirely alone", () => {
		const whole = [sent(7, 5, "new"), sent(7, 1, "older")];
		expect(readable(whole)).toEqual(whole);
	});

	it("turns a wholly unreadable history into an empty one the window can draw", () => {
		const only = [beforeText, beforeText, beforeText];
		expect(readable(only)).toEqual([]);
		// Which is the point: the state that comes out is one `admits` says yes to, so the window
		// draws an empty log instead of its refusal placeholder.
		expect(isNotifyState({...idle, deliveries: readable(only)})).toBe(true);
		expect(isNotifyState({...idle, deliveries: only})).toBe(false);
	});
});

describe("the event the composer sends", () => {
	it("is the arrival `:<id> send <text>` puts on the `message` port, so both reach one cell", () => {
		expect(sendEvent("the desk is up")).toEqual({
			type: "message",
			payload: {text: "the desk is up", items: [], ok: true},
		});
	});

	it("is built fresh each time, so no caller holds a shared object", () => {
		expect(sendEvent("x")).not.toBe(sendEvent("x"));
	});
});

/**
 * The boundary, walked rather than asserted about. `./window.tsx` is loaded by a browser tab, so
 * every module reachable from it has to be loadable there — which rules out the kernel and rules
 * out `node:` outright.
 */
describe("the browser half reaches no kernel", () => {
	const here = dirname(fileURLToPath(import.meta.url));

	/**
	 * The three ways a module can name another one, because a walk that reads only the first is a
	 * walk with two doors left open.
	 *
	 * `CLAUSE` is `import … from "x"` and `export … from "x"`, with whether the whole clause is
	 * type-only. `SIDE_EFFECT` is `import "x";`, which names no binding and is the easiest edge to
	 * add without noticing. `DYNAMIC` is `await import("x")`, which is a runtime edge and therefore
	 * never type-only — a lazily imported kernel is still a kernel in the tab.
	 */
	const CLAUSE = /^\s*(?:import|export)\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm;
	const SIDE_EFFECT = /^\s*import\s+"([^"]+)";/gm;
	const DYNAMIC = /\bimport\s*\(\s*"([^"]+)"\s*\)/g;

	/** Every module reachable from `src/window.tsx`, and the bare specifiers each one imports. */
	const walk = () => {
		const seen = new Set<string>();
		const bare: Array<{from: string; spec: string; typeOnly: boolean}> = [];
		const queue = [resolve(here, "window.tsx")];
		while (queue.length > 0) {
			const file = queue.pop();
			if (file === undefined || seen.has(file)) continue;
			seen.add(file);
			const source = readFileSync(file, "utf8");
			const edges = [
				...[...source.matchAll(CLAUSE)].map((match) => ({
					spec: match[2] ?? "",
					typeOnly: match[1] !== undefined,
				})),
				// Neither of these can carry a `type` keyword, so both are runtime edges by construction.
				...[...source.matchAll(SIDE_EFFECT)].map((match) => ({
					spec: match[1] ?? "",
					typeOnly: false,
				})),
				...[...source.matchAll(DYNAMIC)].map((match) => ({
					spec: match[1] ?? "",
					typeOnly: false,
				})),
			];
			for (const {spec, typeOnly} of edges) {
				if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
				else bare.push({from: relative(here, file), spec, typeOnly});
			}
		}
		return {
			files: [...seen].map((file) => relative(here, file)).sort(),
			bare,
		};
	};

	it("reaches only the window, the state it draws and the leaf under that", () => {
		// `./notify.ts` and `./deliver.ts` are the two that must never appear: the first imports
		// `@kampus/tuval-sdk/authoring`, which reaches `node:crypto` through the kernel, and the second
		// sits under it. This list is the whole reachable set, so a new edge fails here by addition.
		// `./renderer-ref.ts` is not in it either, and should not be: the specifier is the *kernel*
		// half's to put on the row, and the browser half is what it names.
		expect(walk().files).toEqual(["state.ts", "target.ts", "window.tsx"]);
	});

	it("imports no `node:` builtin anywhere under the window", () => {
		expect(walk().bare.filter((entry) => entry.spec.startsWith("node:"))).toEqual([]);
	});

	it("imports at runtime only the browser-safe door, effect and react", () => {
		const runtime = walk()
			.bare.filter((entry) => !entry.typeOnly)
			.map((entry) => entry.spec);
		// `@kampus/tuval-sdk/window` is the browser-safe door, whose own import closure reaches no `node:`
		// builtin. `@kampus/tuval-sdk/authoring` is the one that would be a bug, and it is not in this set.
		expect([...new Set(runtime)].sort()).toEqual(["@kampus/tuval-sdk/window", "effect", "react"]);
	});

	it("takes its one turn type type-only, so the emit imports no port module", () => {
		// `verbatimModuleSyntax` emits nothing for an `import type`, so the built `state.js` a browser
		// loads has no import of `@kampus/tuval-sdk/ai-agent/ports` at all.
		const ports = walk().bare.filter((entry) =>
			entry.spec.startsWith("@kampus/tuval-sdk/ai-agent"),
		);
		expect(ports.length).toBeGreaterThan(0);
		expect(ports.every((entry) => entry.typeOnly)).toBe(true);
	});
});
