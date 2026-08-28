// @vitest-environment jsdom

import {cleanup, render, waitFor} from "@testing-library/react";
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {toRelationshipEdges, toSessionNodes} from "../../src/frontend-shell/canvas-adapter.js";
import {SessionCanvas} from "../../src/frontend-shell/session-canvas.js";
import type {DiscoveredSession} from "../../src/shared/discovery.js";

const session = (id: string, parentSessionId?: string): DiscoveredSession => ({
	identity: `pi:${id}` as DiscoveredSession["identity"],
	piSessionId: id,
	createdAt: 1,
	updatedAt: 2,
	cwd: `/work/${id}`,
	sourceFile: `/fixtures/${id}.jsonl`,
	...(parentSessionId === undefined ? {} : {parentSessionId}),
});

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
	it("renders named focusable nodes, a named edge, and matching relationship handles", async () => {
		const sessions = [session("root"), session("child", "root")];
		const view = render(
			<div style={{width: 800, height: 600}}>
				<SessionCanvas
					nodes={toSessionNodes(sessions)}
					edges={toRelationshipEdges(sessions)}
					onNodesChange={vi.fn()}
					onEdgesChange={vi.fn()}
					onSelect={vi.fn()}
				/>
			</div>,
		);

		await waitFor(() => {
			expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(2);
			expect(view.container.querySelectorAll(".react-flow__edge")).toHaveLength(1);
		});
		const root = view.container.querySelector<HTMLElement>('[data-id="pi:root"]');
		const edge = view.container.querySelector<HTMLElement>(
			'[data-id="relationship:pi:root:pi:child"]',
		);
		expect(root?.getAttribute("aria-label")).toBe("root oturumu, root");
		expect(root?.getAttribute("tabindex")).toBe("0");
		expect(root?.querySelector(".session-node.kp-card")).not.toBeNull();
		expect(edge?.getAttribute("aria-label")).toBe("root oturumundan child oturumuna ilişki");
		expect(edge?.getAttribute("tabindex")).toBe("0");
		expect(
			view.container.querySelector('[data-nodeid="pi:root"][data-handleid="relation-out"]'),
		).not.toBeNull();
		expect(
			view.container.querySelector('[data-nodeid="pi:child"][data-handleid="relation-in"]'),
		).not.toBeNull();
		expect(view.container.querySelectorAll(".canvas-controls .kp-btn")).toHaveLength(3);
		expect(view.container.querySelectorAll(".canvas-controls .lucide")).toHaveLength(3);
	});
});
