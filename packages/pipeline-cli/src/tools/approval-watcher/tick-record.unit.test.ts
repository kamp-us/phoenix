import {describe, expect, it} from "vitest";
import {
	digestOf,
	formatDisposition,
	parseDisposition,
	parseTick,
	parseWatchSpec,
	planTickWrite,
	renderTick,
	type TickRecord,
} from "./tick-record.ts";

const at = (s: string) => `2026-07-26T${s}Z`;

describe("parseDisposition — the three-way distinction never collapses", () => {
	it("reads the three sanctioned tokens", () => {
		expect(parseDisposition("fired")).toEqual({_tag: "fired"});
		expect(parseDisposition("definite-stop:no approval at current head")).toEqual({
			_tag: "definite-stop",
			reason: "no approval at current head",
		});
		expect(parseDisposition("unknown:reviews")).toEqual({_tag: "unknown", input: "reviews"});
	});

	it("reads an UNRECOGNIZED token as unknown, never as a definite stop (#3715/#4108 class)", () => {
		const d = parseDisposition("no approval");
		expect(d._tag).toBe("unknown");
	});

	it("reads an empty or reasonless token as unknown", () => {
		expect(parseDisposition("")._tag).toBe("unknown");
		expect(parseDisposition("definite-stop:")._tag).toBe("unknown");
		expect(parseDisposition("unknown:")).toEqual({_tag: "unknown", input: "unnamed input"});
	});

	it("round-trips through formatDisposition", () => {
		for (const token of ["fired", "definite-stop:machine gates not green", "unknown:head"]) {
			expect(formatDisposition(parseDisposition(token))).toBe(token);
		}
	});
});

describe("parseWatchSpec — the derived watch set, empty included", () => {
	it("parses one entry per line and sorts by PR", () => {
		const {entries, malformed} = parseWatchSpec("4231=unknown:reviews\n#4224=fired\n");
		expect(malformed).toEqual([]);
		expect(entries).toEqual([
			{pr: 4224, disposition: {_tag: "fired"}},
			{pr: 4231, disposition: {_tag: "unknown", input: "reviews"}},
		]);
	});

	it("parses an EMPTY spec as an empty derived set, not as an error", () => {
		expect(parseWatchSpec("")).toEqual({entries: [], malformed: []});
		expect(parseWatchSpec("\n  \n")).toEqual({entries: [], malformed: []});
	});

	it("keeps an unreadable line verbatim instead of dropping it silently", () => {
		const {entries, malformed} = parseWatchSpec("4224=fired\nnot-a-pr\nabc=fired");
		expect(entries.map((e) => e.pr)).toEqual([4224]);
		expect(malformed).toEqual(["not-a-pr", "abc=fired"]);
	});

	it("keeps the colons inside a disposition (the separator is `=`, not `:`)", () => {
		const {entries} = parseWatchSpec("4224=definite-stop:machine gates not green (read OK)");
		expect(entries[0]?.disposition).toEqual({
			_tag: "definite-stop",
			reason: "machine gates not green (read OK)",
		});
	});
});

describe("digestOf — coalescing key over the set, not the clock", () => {
	it("ignores entry order and timestamps", () => {
		const a = parseWatchSpec("4224=fired\n4231=unknown:reviews");
		const b = parseWatchSpec("4231=unknown:reviews\n4224=fired");
		expect(digestOf(a.entries, a.malformed)).toBe(digestOf(b.entries, b.malformed));
	});

	it("separates an empty set from any non-empty one", () => {
		const empty = digestOf([], []);
		const one = parseWatchSpec("4224=fired");
		expect(empty).not.toBe(digestOf(one.entries, one.malformed));
	});

	it("separates two sets that differ only in one PR's disposition", () => {
		const stop = parseWatchSpec("4224=definite-stop:no approval at current head");
		const unknown = parseWatchSpec("4224=unknown:reviews");
		expect(digestOf(stop.entries, stop.malformed)).not.toBe(
			digestOf(unknown.entries, unknown.malformed),
		);
	});
});

describe("renderTick / parseTick — the record survives the round trip through a comment", () => {
	const record: TickRecord = {
		firstAt: at("08:00:00"),
		lastAt: at("09:00:00"),
		ticks: 7,
		sessions: ["session-a"],
		watch: [
			{pr: 4224, disposition: {_tag: "definite-stop", reason: "no approval at current head"}},
		],
		malformed: [],
	};

	it("round-trips", () => {
		expect(parseTick(renderTick(record))).toEqual(record);
	});

	it("says EMPTY out loud for an empty derived set, and still round-trips it", () => {
		const empty = {...record, watch: []};
		const body = renderTick(empty);
		expect(body).toContain("derived watch set EMPTY");
		expect(parseTick(body)?.watch).toEqual([]);
	});

	it("returns null for a comment that is not a tick record", () => {
		expect(parseTick("claim: abc · 2026-07-26T00:00:00Z")).toBeNull();
		expect(parseTick("approval-watcher-tick: but no payload")).toBeNull();
	});
});

describe("planTickWrite — one record per distinct outcome, not one per tick", () => {
	const tick = (time: string, spec: string, session = "session-a") => {
		const {entries, malformed} = parseWatchSpec(spec);
		return {at: at(time), session, watch: entries, malformed};
	};

	it("posts a new record when the ledger has none", () => {
		const plan = planTickWrite(null, tick("08:00:00", "4224=fired"));
		expect(plan._tag).toBe("post");
		expect(plan.record.ticks).toBe(1);
		expect(plan.record.firstAt).toBe(plan.record.lastAt);
	});

	it("coalesces a repeated identical outcome, bumping the count and extending the span", () => {
		const first = planTickWrite(null, tick("08:00:00", ""));
		const second = planTickWrite(
			{commentId: 99, record: first.record},
			tick("08:05:00", "", "session-b"),
		);
		expect(second._tag).toBe("coalesce");
		if (second._tag !== "coalesce") throw new Error("unreachable");
		expect(second.commentId).toBe(99);
		expect(second.record.ticks).toBe(2);
		expect(second.record.firstAt).toBe(at("08:00:00"));
		expect(second.record.lastAt).toBe(at("08:05:00"));
		expect(second.record.sessions).toEqual(["session-a", "session-b"]);
	});

	it("posts a NEW record the moment the derived set or a disposition changes", () => {
		const first = planTickWrite(null, tick("08:00:00", ""));
		const changed = planTickWrite(
			{commentId: 99, record: first.record},
			tick("08:05:00", "4224=fired"),
		);
		expect(changed._tag).toBe("post");
		expect(changed.record.ticks).toBe(1);
	});

	it("does not coalesce an empty set into a non-empty one (the distinction #4290 needs)", () => {
		const nonEmpty = planTickWrite(
			null,
			tick("08:00:00", "4224=definite-stop:no approval at current head"),
		);
		const empty = planTickWrite({commentId: 99, record: nonEmpty.record}, tick("08:05:00", ""));
		expect(empty._tag).toBe("post");
		expect(empty.record.watch).toEqual([]);
	});
});
