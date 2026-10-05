/**
 * The on-call board's pure core: the routing rules over origin, type and labels, the response target
 * each item gets, and the project shape that carries a Response target where the table has a Size.
 */
import {describe, expect, it} from "vitest";
import {type Route, SHIPPED_ON_CALL} from "../config/keys/boards.ts";
import {boardOf, onCallBoard, onCallShape, responseTargetOf} from "./on-call.ts";

/** A narrower declared route: a bug at p0 or p1, and a bug a customer reported at any priority. */
const NARROW: Route = [
	{types: ["bug"], labels: ["p0", "p1"]},
	{types: ["bug"], origins: ["customer"]},
];

/** The shipped rules plus one incident label, each alone. */
const ANY_ONE: Route = [...SHIPPED_ON_CALL.route, {labels: ["ci-broken"]}];

describe("boardOf under the shipped route", () => {
	const SHIPPED = SHIPPED_ON_CALL.route;

	it("sends every bug to on-call, at any priority, whoever filed it", () => {
		expect(boardOf({origins: [], labels: ["type:bug", "p2"]}, SHIPPED)).toBe("on-call");
		expect(boardOf({origins: ["driver pick"], labels: ["type:bug"]}, SHIPPED)).toBe("on-call");
	});

	it("sends every customer report to on-call, whatever its type or none", () => {
		expect(boardOf({origins: ["customer"], labels: ["type:feature"]}, SHIPPED)).toBe("on-call");
		expect(boardOf({origins: ["customer"], labels: []}, SHIPPED)).toBe("on-call");
	});

	it("keeps an issue nobody outside filed, of any other type, on the product board", () => {
		expect(boardOf({origins: ["driver pick"], labels: ["type:feature", "p0"]}, SHIPPED)).toBe(
			"product",
		);
	});
});

describe("boardOf under a narrower declared route", () => {
	it("sends a bug at p0 or p1 to on-call, whoever filed it", () => {
		expect(boardOf({origins: [], labels: ["type:bug", "p0"]}, NARROW)).toBe("on-call");
		expect(boardOf({origins: ["driver pick"], labels: ["type:bug", "p1"]}, NARROW)).toBe("on-call");
	});

	it("sends a bug a customer reported to on-call at any priority, or none", () => {
		expect(boardOf({origins: ["customer"], labels: ["type:bug", "p2"]}, NARROW)).toBe("on-call");
		expect(boardOf({origins: ["customer"], labels: ["type:bug"]}, NARROW)).toBe("on-call");
	});

	it("routes on any one origin, so a lane's Origin does not hide the customer who filed it", () => {
		expect(boardOf({origins: ["driver pick", "customer"], labels: ["type:bug"]}, NARROW)).toBe(
			"on-call",
		);
	});

	it("keeps a p2 bug with no customer origin on the product board", () => {
		expect(boardOf({origins: [], labels: ["type:bug", "p2"]}, NARROW)).toBe("product");
		expect(boardOf({origins: ["found mid-lane"], labels: ["type:bug"]}, NARROW)).toBe("product");
	});

	it("keeps a customer's issue of any other type on the product board", () => {
		expect(boardOf({origins: ["customer"], labels: ["type:feature", "p0"]}, NARROW)).toBe(
			"product",
		);
	});

	it("keeps an issue with no type label off on-call, whoever filed it", () => {
		expect(boardOf({origins: ["customer"], labels: []}, NARROW)).toBe("product");
		expect(boardOf({origins: ["customer"], labels: ["status:needs-triage", "p0"]}, NARROW)).toBe(
			"product",
		);
		expect(boardOf({origins: [], labels: ["p0"]}, NARROW)).toBe("product");
	});

	it("reads a type only off its `type:` label", () => {
		expect(boardOf({origins: ["customer"], labels: ["bug", "p0"]}, NARROW)).toBe("product");
	});
});

describe("boardOf under a declared route", () => {
	it("sends an issue when any one single-attribute rule matches", () => {
		expect(boardOf({origins: ["customer"], labels: ["type:feature"]}, ANY_ONE)).toBe("on-call");
		expect(boardOf({origins: [], labels: ["type:bug", "p2"]}, ANY_ONE)).toBe("on-call");
		expect(boardOf({origins: [], labels: ["p1", "ci-broken"]}, ANY_ONE)).toBe("on-call");
		expect(boardOf({origins: ["driver pick"], labels: ["p1"]}, ANY_ONE)).toBe("product");
	});

	it("matches a rule only when every attribute it names matches", () => {
		const rule: Route = [{types: ["bug"], labels: ["p0"], origins: ["customer"]}];
		expect(boardOf({origins: ["customer"], labels: ["type:bug", "p0"]}, rule)).toBe("on-call");
		expect(boardOf({origins: [], labels: ["type:bug", "p0"]}, rule)).toBe("product");
		expect(boardOf({origins: ["customer"], labels: ["type:bug"]}, rule)).toBe("product");
	});

	it("sends nothing to on-call when the route names no rule", () => {
		const everything = {origins: ["customer"], labels: ["type:bug", "p0", "ci-broken"]};
		expect(boardOf(everything, [])).toBe("product");
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

	it("says in its README which issues the route sends there", () => {
		expect(shape.readme.body).toContain(
			[
				"## What sends an issue here",
				"An issue comes here when it matches any one of these; everything else stays on the table.",
				"- An issue with the origin `customer`.",
				"- An issue typed `bug`.",
			].join("\n"),
		);
		expect(
			onCallShape({...SHIPPED_ON_CALL, route: NARROW}, "acme/widgets", "widgets on-call").readme
				.body,
		).toContain(
			[
				"- An issue typed `bug`, and labeled one of `p0`, `p1`.",
				"- An issue typed `bug`, and with the origin `customer`.",
			].join("\n"),
		);
		expect(
			onCallShape({...SHIPPED_ON_CALL, route: []}, "acme/widgets", "widgets on-call").readme.body,
		).toContain("No rule sends an issue here");
	});

	it("is found by its own title and config key", () => {
		expect(onCallBoard("acme/widgets", SHIPPED_ON_CALL)).toEqual({
			title: "widgets on-call",
			project: {owner: null, number: null},
			key: "boards.onCall.project",
		});
	});
});
