import {strict as assert} from "node:assert";
import {describe, it} from "@effect/vitest";
import {
	reconcileSessionNodes,
	toRelationshipEdges,
	toSessionNodes,
} from "../../src/frontend-shell/canvas-adapter.js";
import type {DiscoveredSession} from "../../src/shared/discovery.js";

const session = (id: string, cwd: string, parentSessionId?: string): DiscoveredSession => ({
	identity: `pi:${id}` as DiscoveredSession["identity"],
	piSessionId: id,
	createdAt: 1,
	updatedAt: 2,
	cwd,
	sourceFile: `/fixtures/${id}.jsonl`,
	...(parentSessionId === undefined ? {} : {parentSessionId}),
});

describe("Tuval React Flow adapter", () => {
	it("keeps interaction fields while refreshing domain-derived session data", () => {
		const [initial] = toSessionNodes([session("alpha", "/work/alpha")]);
		assert.ok(initial);
		const moved = {
			...initial,
			position: {x: 384, y: -96},
			selected: true,
			dragging: false,
			measured: {width: 248, height: 132},
		};
		const [updated] = reconcileSessionNodes([moved], [session("alpha", "/work/renamed")]);
		assert.ok(updated);
		assert.deepEqual(updated.position, moved.position);
		assert.equal(updated.selected, true);
		assert.deepEqual(updated.measured, moved.measured);
		assert.equal(updated.data.title, "renamed");
	});

	it("projects stable accessible relationship edges through matching handles", () => {
		const root = session("root", "/work/root");
		const child = session("child", "/work/child", "root");
		assert.deepEqual(toRelationshipEdges([root, child]), [
			{
				id: "relationship:pi:root:pi:child",
				type: "relationship",
				source: root.identity,
				target: child.identity,
				sourceHandle: "relation-out",
				targetHandle: "relation-in",
				ariaLabel: "root oturumundan child oturumuna ilişki",
				data: {},
			},
		]);
	});
});
