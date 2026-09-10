import {Result, Schema} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import {type PortSchema, ProgramId} from "../registry/program.ts";
import {
	compilePort,
	compilePorts,
	DEFAULT_PORT_BOUND,
	type PortPayload,
	type PortReply,
	port,
	portKind,
} from "./port.ts";

const counter = ProgramId.make("counter");

const Count = Schema.Number;
const Review = Schema.Struct({pr: Schema.Number, urgent: Schema.Boolean});

describe("authoring.port", () => {
	it("compiles the three kinds into the port record a registry row carries", () => {
		const ports = compilePorts(counter, {
			ticks: port.in(Count),
			announced: port.out(Count),
			review: port.request(Review, Count),
		});
		// The row's own `ports` type; a compiled port the row would refuse fails here, at compile time.
		const asRow: Readonly<Record<string, PortSchema>> = ports;
		expect(Object.keys(asRow).sort()).toEqual(["announced", "review", "ticks"]);
		expect(ports.ticks.direction).toBe("in");
		expect(ports.announced.direction).toBe("out");
		// A request port is an arrival on the declaring side, so the row carries it as an in-port.
		expect(ports.review.direction).toBe("in");
	});

	it("admits a payload the schema accepts and refuses one it rejects", () => {
		const ticks = compilePort(counter, "ticks", port.in(Count));
		expect(ticks.accepts(3)).toBe(true);
		expect(ticks.accepts("3")).toBe(false);

		const review = compilePort(counter, "review", port.request(Review, Count));
		expect(review.accepts({pr: 8726, urgent: false})).toBe(true);
		expect(review.accepts({pr: "8726", urgent: false})).toBe(false);
		expect(review.accepts(null)).toBe(false);
	});

	it("derives the kind from the program id and the port name, with no version segment", () => {
		const ports = compilePorts(counter, {ticks: port.in(Count), announced: port.out(Count)});
		expect(ports.ticks.kind).toBe("counter/ticks");
		expect(ports.announced.kind).toBe("counter/announced");
		expect(portKind(counter, "ticks")).toBe("counter/ticks");
		for (const compiled of Object.values<PortSchema>(ports)) {
			expect(compiled.kind).not.toContain("@");
		}
	});

	it("bounds an in-port by default, takes the author's override, and leaves an out-port unbounded", () => {
		const defaulted = compilePort(counter, "ticks", port.in(Count));
		const overridden = compilePort(
			counter,
			"ticks",
			port.in(Count, {bound: {capacity: 1, overflow: "sliding"}}),
		);
		const announced = compilePort(counter, "announced", port.out(Count));
		expect(defaulted.bound).toEqual(DEFAULT_PORT_BOUND);
		expect(DEFAULT_PORT_BOUND).toEqual({capacity: 16, overflow: "suspend"});
		expect(overridden.bound).toEqual({capacity: 1, overflow: "sliding"});
		expect(announced).not.toHaveProperty("bound");
	});

	it("retains both schemas on a request port", () => {
		const asked = port.request(Review, Count);
		expect(Result.isSuccess(Schema.decodeUnknownResult(asked.input)({pr: 1, urgent: true}))).toBe(
			true,
		);
		expect(Result.isSuccess(Schema.decodeUnknownResult(asked.input)(1))).toBe(false);
		expect(Result.isSuccess(Schema.decodeUnknownResult(asked.output)(1))).toBe(true);
		expect(Result.isSuccess(Schema.decodeUnknownResult(asked.output)({pr: 1}))).toBe(false);
	});

	it("carries the request port's output schema onto the row as `answers`", () => {
		const review = compilePort(counter, "review", port.request(Review, Count));
		const ticks = compilePort(counter, "ticks", port.in(Count));
		// The row is what the kernel checks an answer against, so the predicate has to survive the
		// compile — dropping it is what left an `ask` unanswerable (#8756).
		expect(review.answers?.(4)).toBe(true);
		expect(review.answers?.("4")).toBe(false);
		// A one-way in-port answers nothing, and its absence here is what says so.
		expect(ticks.answers).toBeUndefined();
	});

	it("infers the payload type at the declaration site from the schema", () => {
		const ticks = port.in(Count);
		const announced = port.out(Review);
		const review = port.request(Review, Count);
		expectTypeOf<PortPayload<typeof ticks>>().toEqualTypeOf<number>();
		expectTypeOf<PortPayload<typeof announced>>().toEqualTypeOf<{
			readonly pr: number;
			readonly urgent: boolean;
		}>();
		expectTypeOf<PortPayload<typeof review>>().toEqualTypeOf<{
			readonly pr: number;
			readonly urgent: boolean;
		}>();
		expectTypeOf<PortReply<typeof review>>().toEqualTypeOf<number>();
		expectTypeOf<PortReply<typeof ticks>>().toEqualTypeOf<never>();

		// The compiled predicate narrows to the schema's type, not `unknown`.
		const compiled = compilePort(counter, "ticks", ticks);
		const payload: unknown = 3;
		if (compiled.accepts(payload)) {
			expectTypeOf(payload).toEqualTypeOf<number>();
		}
	});
});
