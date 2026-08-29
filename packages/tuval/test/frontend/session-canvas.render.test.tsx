// @vitest-environment jsdom

import {cleanup, render, waitFor} from "@testing-library/react";
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {toLineageEdges, toSessionNodes} from "../../src/frontend-shell/canvas-adapter.js";
import {SessionCanvas} from "../../src/frontend-shell/session-canvas.js";
import type {LineageProjection} from "../../src/shared/lineage.js";

const node = (id: string) => ({
	id: `pi:${id}` as LineageProjection["graph"]["nodes"][number]["id"],
	piSessionId: id,
	createdAt: 1,
	updatedAt: 2,
	cwd: `/work/${id}`,
	sourceFiles: [`/fixtures/${id}.jsonl`],
});

const projection: LineageProjection = {
	graph: {
		version: 2,
		nodes: [node("root"), node("spawned"), node("forked")],
		edges: [
			{
				id: "spawn:spawn-run",
				kind: "spawn",
				parent: node("root").id,
				child: node("spawned").id,
				runId: "spawn-run",
				observedAt: 10,
			},
			{
				id: `fork:${node("forked").id}`,
				kind: "fork",
				parent: node("root").id,
				child: node("forked").id,
				source: "header",
			},
		],
		continuity: [
			{
				id: "resume:resume-run",
				runId: "resume-run",
				session: node("spawned").id,
				parent: node("root").id,
				observedAt: 20,
			},
		],
		ownership: [],
	},
	problems: [],
};

const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

const dimensions = {
	x: 0,
	y: 0,
	top: 0,
	left: 0,
	right: 800,
	bottom: 600,
	width: 800,
	height: 600,
	toJSON: () => ({}),
};

beforeAll(() => {
	vi.stubGlobal(
		"DOMMatrixReadOnly",
		class {
			readonly m22 = 1;
		},
	);
	vi.stubGlobal(
		"ResizeObserver",
		class TestResizeObserver implements ResizeObserver {
			readonly callback: ResizeObserverCallback;

			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
			}

			observe(target: Element): void {
				queueMicrotask(() =>
					this.callback(
						[{target, contentRect: dimensions as DOMRectReadOnly} as ResizeObserverEntry],
						this,
					),
				);
			}

			unobserve(): void {}
			disconnect(): void {}
		},
	);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(dimensions as DOMRect);
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {configurable: true, get: () => 248});
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get: () => 132,
	});
});

afterEach(cleanup);
afterAll(() => {
	vi.restoreAllMocks();
	if (offsetWidth !== undefined) {
		Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
	}
	if (offsetHeight !== undefined) {
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
	}
});

describe("SessionCanvas", () => {
	it("renders named typed edges, resume continuity, and matching relationship handles", async () => {
		const view = render(
			<div style={{width: 800, height: 600}}>
				<SessionCanvas
					nodes={toSessionNodes(projection)}
					edges={toLineageEdges(projection)}
					onNodesChange={vi.fn()}
					onEdgesChange={vi.fn()}
					onSelect={vi.fn()}
				/>
			</div>,
		);

		await waitFor(() => {
			expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(3);
			expect(view.container.querySelectorAll(".react-flow__edge")).toHaveLength(2);
		});
		const root = view.container.querySelector<HTMLElement>('[data-id="pi:root"]');
		const spawn = view.container.querySelector<HTMLElement>('[data-id="spawn:spawn-run"]');
		const fork = view.container.querySelector<HTMLElement>('[data-id="fork:pi:forked"]');
		expect(root?.getAttribute("aria-label")).toBe("root oturumu, root");
		expect(root?.getAttribute("tabindex")).toBe("0");
		expect(root?.querySelector(".session-node.kp-card")).not.toBeNull();
		expect(spawn?.getAttribute("aria-label")).toContain("oluşturma ilişkisi");
		expect(fork?.getAttribute("aria-label")).toContain("dallanma ilişkisi");
		expect(spawn?.getAttribute("tabindex")).toBe("0");
		expect(fork?.getAttribute("tabindex")).toBe("0");
		expect(view.getAllByText("Oluşturma").length).toBeGreaterThan(0);
		expect(view.getAllByText("Dallanma").length).toBeGreaterThan(0);
		expect(view.getByText("1 devam")).toBeTruthy();
		expect(view.container.querySelectorAll('[data-id^="resume:"]')).toHaveLength(0);
		expect(
			view.container.querySelector('[data-nodeid="pi:root"][data-handleid="relation-out"]'),
		).not.toBeNull();
		expect(
			view.container.querySelector('[data-nodeid="pi:forked"][data-handleid="relation-in"]'),
		).not.toBeNull();
		expect(view.container.querySelectorAll(".canvas-controls .kp-btn")).toHaveLength(3);
	});
});
