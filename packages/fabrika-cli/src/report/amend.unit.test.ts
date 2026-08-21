import {describe, expect, it} from "vitest";
import {compose, heading, SEPARATOR} from "./amend.ts";

const ON = new Date("2026-08-21T03:31:36Z");

describe("compose", () => {
	it("keeps the prior body verbatim above the envelope", () => {
		const prior = "## Summary\n\nThe editor loses focus after a save.";
		expect(compose(prior, "Reproduces on the streaming path too.", ON).body).toBe(
			`${prior}\n\n---\n\n## Amendment — 2026-08-21\n\nReproduces on the streaming path too.\n`,
		);
	});

	it("composes the separator and the dated heading itself", () => {
		const {appended} = compose("prior", "note", ON);
		expect(appended).toBe(`${SEPARATOR}\n\n${heading(ON)}\n\nnote\n`);
	});

	it("dates the heading in UTC, never the running machine's zone", () => {
		expect(heading(new Date("2026-08-21T23:59:59Z"))).toBe("## Amendment — 2026-08-21");
	});

	it("omits the separator on a blank prior body — a rule over nothing rules off nothing", () => {
		expect(compose("   \n\n", "note", ON).body).toBe("## Amendment — 2026-08-21\n\nnote\n");
	});

	it("normalises the seam so a prior body's trailing newlines cannot stack blank lines", () => {
		expect(compose("prior\n\n\n", "note", ON).body).toBe(compose("prior", "note", ON).body);
	});

	it("appends rather than nests — a second amendment leaves the first one standing", () => {
		const once = compose("prior", "first", ON).body;
		const twice = compose(once, "second", ON).body;
		expect(twice.startsWith(once.trimEnd())).toBe(true);
		expect(twice.split("## Amendment").length - 1).toBe(2);
	});
});
