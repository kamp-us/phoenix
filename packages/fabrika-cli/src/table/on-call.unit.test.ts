/**
 * The on-call board's pure core: the routing rule over origin, type and labels, the response target
 * each item gets, and the project shape that carries a Response target where the table has a Size.
 */
import {describe, expect, it} from "vitest";
import {type Route, SHIPPED_ON_CALL} from "../config/keys/boards.ts";
import {boardOf, onCallBoard, onCallShape, responseTargetOf} from "./on-call.ts";

const ROUTE: Route = {origins: ["customer"], types: ["bug"], labels: ["ci-broken"]};

describe("boardOf", () => {
	it("sends an issue to on-call by its origin", () => {
		expect(boardOf({origins: ["customer"], labels: []}, ROUTE)).toBe("on-call");
		expect(boardOf({origins: ["driver pick"], labels: []}, ROUTE)).toBe("product");
		expect(boardOf({origins: [], labels: []}, ROUTE)).toBe("product");
	});

	it("routes on any one origin, so a lane's Origin does not hide the customer who filed it", () => {
		expect(boardOf({origins: ["driver pick", "customer"], labels: []}, ROUTE)).toBe("on-call");
	});

	it("sends an issue to on-call by its type label", () => {
		expect(boardOf({origins: [], labels: ["type:bug"]}, ROUTE)).toBe("on-call");
		expect(boardOf({origins: [], labels: ["type:feature"]}, ROUTE)).toBe("product");
		expect(boardOf({origins: [], labels: ["bug"]}, ROUTE)).toBe("product");
	});

	it("sends an issue to on-call by any label it carries", () => {
		expect(boardOf({origins: [], labels: ["p1", "ci-broken"]}, ROUTE)).toBe("on-call");
		expect(boardOf({origins: [], labels: ["p1"]}, ROUTE)).toBe("product");
	});

	it("sends an issue matching every rule to product when the route names no rule", () => {
		const everything = {origins: ["customer"], labels: ["type:bug", "ci-broken"]};
		expect(boardOf(everything, {origins: [], types: [], labels: []})).toBe("product");
	});
});

describe("responseTargetOf", () => {
	const targets = {
		byLabel: [
			{name: "now", hours: 2, labels: ["outage"]},
			{name: "today", hours: 8, labels: ["p0", "outage"]},
		],
		otherwise: {name: "this week", hours: 168},
	};

	it("takes the first labeled target the item carries a label of, else the fallback", () => {
		expect(responseTargetOf(["p0", "outage"], targets)).toEqual({name: "now", hours: 2});
		expect(responseTargetOf(["p0"], targets)).toEqual({name: "today", hours: 8});
		expect(responseTargetOf(["p2"], targets)).toEqual({name: "this week", hours: 168});
	});
});

describe("the on-call project", () => {
	const shape = onCallShape(SHIPPED_ON_CALL, "acme/widgets", "widgets on-call");

	it("carries a Response target field with each target as an option, and no Size or Week", () => {
		const names = shape.fields.map((field) => field.name);
		expect(names).toEqual(["Response target", "In plain words"]);
		const target = shape.fields[0];
		expect(target?._tag === "SingleSelect" ? target.options.map((one) => one.name) : []).toEqual([
			"same day",
			"this week",
		]);
		expect(shape.views.map((view) => view.name)).toEqual(["Queue"]);
		expect(shape.readme.body).toContain("## Response target");
		expect(shape.readme.body).toContain("20%");
	});

	it("is found by its own title and config key", () => {
		expect(onCallBoard("acme/widgets", SHIPPED_ON_CALL)).toEqual({
			title: "widgets on-call",
			project: {owner: null, number: null},
			key: "boards.onCall.project",
		});
	});
});
