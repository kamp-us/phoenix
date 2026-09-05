/**
 * The wire's own proof: every frame this transport speaks survives a round trip, and a frame that
 * does not decode is refused with the reason the socket closes on — never silently dropped and
 * never guessed at.
 */

import {Option} from "effect";
import {describe, expect, it} from "vitest";
import type {ProcessId} from "../../process/process.ts";
import type {ProgramId} from "../../registry/program.ts";
import type {TableRow} from "../../table/row.ts";
import {
	ATTACH_KIND,
	ATTACH_REFUSED_KIND,
	type ClientFrame,
	DETACH_KIND,
	DISPATCH_KIND,
	DISPATCHED_KIND,
	decodeClientFrame,
	decodeServerFrame,
	encodeFrame,
	fromWireRow,
	PROCESS_STATE_KIND,
	type ServerFrame,
	TABLE_KIND,
	tableFrame,
	toWireRow,
} from "./wire.ts";

const processId = (id: string) => id as ProcessId;

const row: TableRow = {
	id: processId("shell"),
	programId: "tuval/shell" as ProgramId,
	parentId: Option.some(processId("root")),
	ports: {ticks: {kind: "count/v1", direction: "out"}},
	stateSummary: {lifecycle: "running", revision: 3},
};

const clientFrames: ReadonlyArray<ClientFrame> = [
	{kind: ATTACH_KIND, processId: processId("counter")},
	{kind: DETACH_KIND, processId: processId("counter")},
	{kind: DISPATCH_KIND, seq: 0, processId: processId("counter"), msg: {type: "tick"}},
];

const serverFrames: ReadonlyArray<ServerFrame> = [
	{kind: TABLE_KIND, event: "spawned", row: toWireRow(row)},
	{
		kind: PROCESS_STATE_KIND,
		processId: processId("counter"),
		view: {_tag: "Live", lifecycle: "running", revision: 2, state: {count: 2}},
	},
	{kind: PROCESS_STATE_KIND, processId: processId("counter"), view: {_tag: "ProcessGone"}},
	{
		kind: ATTACH_REFUSED_KIND,
		processId: processId("painter"),
		refusal: {reason: "placement-unsupported", placement: "browser"},
	},
	{
		kind: ATTACH_REFUSED_KIND,
		processId: processId("ghost"),
		refusal: {reason: "no-such-process"},
	},
	{kind: DISPATCHED_KIND, seq: 4, result: {_tag: "Delivered"}},
	{kind: DISPATCHED_KIND, seq: 5, result: {_tag: "ProcessGone", processId: processId("counter")}},
];

describe("the transport wire", () => {
	it("every client frame round trips", () => {
		const decoded = clientFrames.map((frame) => decodeClientFrame(encodeFrame(frame)));
		expect(decoded).toEqual(clientFrames.map((frame) => ({_tag: "Frame", frame})));
	});

	it("every server frame round trips", () => {
		const decoded = serverFrames.map((frame) => decodeServerFrame(encodeFrame(frame)));
		expect(decoded).toEqual(serverFrames.map((frame) => ({_tag: "Frame", frame})));
	});

	it("a table row's parent survives the trip through JSON as an Option again", () => {
		const orphan: TableRow = {...row, parentId: Option.none()};
		expect([fromWireRow(toWireRow(row)), fromWireRow(toWireRow(orphan))]).toEqual([row, orphan]);
		expect(tableFrame({kind: "state-changed", row})).toEqual({
			kind: TABLE_KIND,
			event: "state-changed",
			row: toWireRow(row),
		});
	});

	it("a frame that is not JSON, names no kind this end serves, or carries a bad payload is refused with its reason", () => {
		expect([
			decodeClientFrame("{not json"),
			decodeClientFrame(JSON.stringify({kind: "tuval/transport/nonsense/v1"})),
			decodeClientFrame(JSON.stringify({kind: ATTACH_KIND})),
			decodeClientFrame(JSON.stringify({kind: DISPATCH_KIND, seq: 1.5, processId: "a", msg: {}})),
			decodeServerFrame("[]"),
			decodeServerFrame(JSON.stringify({kind: TABLE_KIND, event: "invented", row: toWireRow(row)})),
		]).toEqual([
			{_tag: "Undecodable", reason: "not-json"},
			{_tag: "Undecodable", reason: "unknown-kind"},
			{_tag: "Undecodable", reason: "malformed-payload"},
			{_tag: "Undecodable", reason: "malformed-payload"},
			{_tag: "Undecodable", reason: "unknown-kind"},
			{_tag: "Undecodable", reason: "malformed-payload"},
		]);
	});

	it("each end refuses the other end's frames: the kinds do not overlap", () => {
		expect(serverFrames.map((frame) => decodeClientFrame(encodeFrame(frame))._tag)).toEqual(
			serverFrames.map(() => "Undecodable"),
		);
		expect(clientFrames.map((frame) => decodeServerFrame(encodeFrame(frame))._tag)).toEqual(
			clientFrames.map(() => "Undecodable"),
		);
	});

	it("no frame kind is the shell's: the shell's state travels the same path as any process's", () => {
		const kinds = [...clientFrames, ...serverFrames].map((frame) => frame.kind);
		expect(kinds.filter((kind) => kind.includes("shell"))).toEqual([]);
		// And the state frame carries a process id like any other, with no arm naming the shell.
		expect(
			serverFrames.filter((frame) => frame.kind === PROCESS_STATE_KIND).map((frame) => frame.kind),
		).toEqual([PROCESS_STATE_KIND, PROCESS_STATE_KIND]);
	});
});
