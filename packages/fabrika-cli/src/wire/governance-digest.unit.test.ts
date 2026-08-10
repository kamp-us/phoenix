import {describe, expect, it} from "vitest";
import {
	emit,
	emitFromFields,
	HEADING,
	KINDS,
	parseFields,
	read,
	readToLines,
} from "./governance-digest.ts";

const artifact = (...rows: ReadonlyArray<string>): string =>
	`${HEADING}\n\n\`\`\`governance-digest\n${rows.join("\n")}\n\`\`\`\n`;

const ROW = "row\t0398\ttension\tsits against ADR 0173 on whether a pending check blocks admission";

describe("read", () => {
	it("finds the rows in file order", () => {
		const result = read(artifact(ROW, "row\t0396\troutine\tno tension found"));
		expect(result).toMatchObject({
			_tag: "Found",
			value: [
				{id: "0398", kind: "tension"},
				{id: "0396", kind: "routine"},
			],
		});
	});

	it("admits every kind in the closed set and nothing else", () => {
		for (const kind of KINDS) {
			expect(read(artifact(`row\t0398\t${kind}\tnote`))._tag).toBe("Found");
		}
		expect(read(artifact("row\t0398\turgent\tnote"))._tag).toBe("Malformed");
	});

	it("is Absent over an artifact that reaches for nothing", () => {
		expect(read("Nothing landed this week, as far as I can tell.\n")).toMatchObject({
			_tag: "Absent",
		});
	});

	it("is MALFORMED, never Absent, on a drifted heading level", () => {
		const drifted = artifact(ROW).replace(HEADING, "### Governance readout");
		expect(read(drifted)).toMatchObject({_tag: "Malformed"});
	});

	it("is Malformed on a fence holding prose instead of rows", () => {
		expect(read(artifact("Nothing much landed."))).toMatchObject({_tag: "Malformed"});
	});

	it("is Malformed on a fence under no heading, and a heading over no fence", () => {
		expect(read(`\`\`\`governance-digest\n${ROW}\n\`\`\`\n`)).toMatchObject({_tag: "Malformed"});
		expect(read(`${HEADING}\n\nnothing here\n`)).toMatchObject({_tag: "Malformed"});
	});

	it("is Malformed on a non-four-digit id and on a fourth field", () => {
		expect(read(artifact("row\t398\troutine\tnote"))).toMatchObject({_tag: "Malformed"});
		expect(read(artifact("row\t0398\troutine\tnote\tmore"))).toMatchObject({_tag: "Malformed"});
	});

	it("is Malformed on a fence with no row at all — an empty digest is not a digest", () => {
		expect(read(`${HEADING}\n\n\`\`\`governance-digest\n\`\`\`\n`)).toMatchObject({
			_tag: "Malformed",
		});
	});

	it("names which line drifted, so a broken artifact points at itself", () => {
		const result = read(artifact(ROW, "row\t0396\tsomething\tnote"));
		expect(result).toMatchObject({_tag: "Malformed", evidence: expect.stringContaining("line 5")});
	});
});

describe("emit", () => {
	it("round-trips through read", () => {
		const parsed = parseFields(`${ROW}\nrow\t0396\troutine\tno tension found\n`);
		expect(parsed._tag).toBe("Fields");
		if (parsed._tag !== "Fields") return;
		expect(read(emit(parsed.rows))).toMatchObject({_tag: "Found"});
	});

	it("refuses to compose from no rows rather than emitting an empty block", () => {
		expect(emitFromFields("\n  \n")).toMatchObject({_tag: "Unusable"});
	});

	it("refuses an off-vocabulary kind at compose time, naming the line", () => {
		expect(emitFromFields("row\t0398\turgent\tnote")).toMatchObject({
			_tag: "Unusable",
			reason: expect.stringContaining("line 1"),
		});
	});

	it("pipes its own read output straight back into emit", () => {
		const back = readToLines(artifact(ROW));
		expect(back._tag).toBe("Found");
		if (back._tag !== "Found") return;
		expect(emitFromFields(back.value.join("\n"))).toMatchObject({_tag: "Composed"});
	});
});
