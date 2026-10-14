import {describe, expect, it} from "vitest";
import {ProjectLabels} from "./labels.ts";

const KAMP_US = "-Users-ada-code-github.com-kamp_-us-phoenix";
const USIRIN = "-Users-ada-code-github.com-usirin-phoenix";

const shorten = (local: string) => (local.length > 8 ? `${local.slice(0, 8)}…` : local);

describe("ProjectLabels.displayId", () => {
	const projects = ProjectLabels.of([{key: KAMP_US, label: "phoenix"}]);

	it("shows a scoped id under its project's label, never the path key", () => {
		expect(projects.displayId(`${KAMP_US}/counter`)).toBe("phoenix/counter");
	});

	it("shows a bare global id unchanged", () => {
		expect(projects.displayId("module-counter")).toBe("module-counter");
	});

	it("shortens only the local part, so the label survives a short form", () => {
		const id = `${KAMP_US}/7f3a9c2e-1b4d-4e8a-9c61-2d5f0e8b7a14`;
		expect(projects.displayId(id, shorten)).toBe("phoenix/7f3a9c2e…");
		expect(projects.displayId("p-module-counter", shorten)).toBe("p-module…");
	});

	it("tells apart two projects that share a folder name by their disambiguated labels", () => {
		const clashing = ProjectLabels.of([
			{key: KAMP_US, label: "kamp-us/phoenix"},
			{key: USIRIN, label: "usirin/phoenix"},
		]);
		expect(clashing.displayId(`${KAMP_US}/counter`)).toBe("kamp-us/phoenix/counter");
		expect(clashing.displayId(`${USIRIN}/counter`)).toBe("usirin/phoenix/counter");
	});

	it("keeps a scope no open project labels, since it is all that tells such rows apart", () => {
		expect(ProjectLabels.none.displayId("-code-gone/counter")).toBe("-code-gone/counter");
	});
});
