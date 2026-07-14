/**
 * The priority-surface selection core (issue #2961 AC 3): the founder-decided set
 * resolves to concrete capture surfaces in order, route params are substituted, and
 * an ill-formed set (unfilled param, bad order, duplicate) fails closed.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	PRIORITY_SURFACES,
	resolvePrioritySurfaces,
	substituteRouteParams,
} from "./priority-surfaces.ts";

describe("PRIORITY_SURFACES — the founder-decided set (#2944)", () => {
	it("is the three surfaces in the founder order: shell+subnav, sözlük term, pano feed", () => {
		assert.deepStrictEqual(
			PRIORITY_SURFACES.map((s) => [s.order, s.key]),
			[
				[1, "global-shell-subnav"],
				[2, "sozluk-term"],
				[3, "pano-feed"],
			],
		);
	});

	it("every surface carries a non-empty bless intent (the pointer records it)", () => {
		for (const s of PRIORITY_SURFACES) {
			assert.isAbove(s.intent.trim().length, 0);
		}
	});
});

describe("substituteRouteParams", () => {
	it("substitutes a :param path segment", () => {
		assert.strictEqual(
			substituteRouteParams("/sozluk/:slug", {slug: "amortisman"}),
			"/sozluk/amortisman",
		);
	});

	it("leaves a param-free route untouched", () => {
		assert.strictEqual(substituteRouteParams("/pano", {}), "/pano");
	});

	it("url-encodes the substituted value", () => {
		assert.strictEqual(substituteRouteParams("/sozluk/:slug", {slug: "a b"}), "/sozluk/a%20b");
	});

	it("fails closed on an unfilled param — never renders a live :param route", () => {
		assert.throws(() => substituteRouteParams("/sozluk/:slug", {}), /route param ":slug"/);
	});
});

describe("resolvePrioritySurfaces", () => {
	it("resolves the founder set to concrete surfaces in order, term slug filled", () => {
		const resolved = resolvePrioritySurfaces({termSlug: "amortisman"});
		assert.deepStrictEqual(
			resolved.map((r) => [r.order, r.surface.surface]),
			[
				[1, "/sozluk"],
				[2, "/sozluk/amortisman"],
				[3, "/pano"],
			],
		);
	});

	it("carries order/title/intent onto each resolved surface", () => {
		const [first] = resolvePrioritySurfaces({termSlug: "x"});
		assert.strictEqual(first?.key, "global-shell-subnav");
		assert.strictEqual(first?.title, "Global shell + product subnav");
		assert.isAbove((first?.intent ?? "").length, 0);
	});

	it("assembles a :state suffix onto the surface-id", () => {
		const resolved = resolvePrioritySurfaces({termSlug: "x"}, [
			{
				order: 1,
				key: "sozluk-term",
				title: "T",
				route: "/sozluk/:slug",
				state: "empty",
				intent: "t",
			},
		]);
		assert.strictEqual(resolved[0]?.surface.surface, "/sozluk/x:empty");
		assert.strictEqual(resolved[0]?.surface.route, "/sozluk/x");
		assert.strictEqual(resolved[0]?.surface.state, "empty");
	});

	it("sorts by order before validating (input order-independent)", () => {
		const resolved = resolvePrioritySurfaces({termSlug: "x"}, [
			{order: 2, key: "pano-feed", title: "B", route: "/pano", intent: "b"},
			{order: 1, key: "global-shell-subnav", title: "A", route: "/sozluk", intent: "a"},
		]);
		assert.deepStrictEqual(
			resolved.map((r) => r.order),
			[1, 2],
		);
	});

	it("fails closed on a non-contiguous order", () => {
		assert.throws(
			() =>
				resolvePrioritySurfaces({termSlug: "x"}, [
					{order: 1, key: "global-shell-subnav", title: "A", route: "/sozluk", intent: "a"},
					{order: 3, key: "pano-feed", title: "C", route: "/pano", intent: "c"},
				]),
			/contiguous/,
		);
	});

	it("fails closed on a duplicate surface-id", () => {
		assert.throws(
			() =>
				resolvePrioritySurfaces({termSlug: "x"}, [
					{order: 1, key: "global-shell-subnav", title: "A", route: "/pano", intent: "a"},
					{order: 2, key: "pano-feed", title: "B", route: "/pano", intent: "b"},
				]),
			/duplicate surface-id/,
		);
	});

	it("fails closed on an empty priority set", () => {
		assert.throws(() => resolvePrioritySurfaces({termSlug: "x"}, []), /empty priority set/);
	});
});
