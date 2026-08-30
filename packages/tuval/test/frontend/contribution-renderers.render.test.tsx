// @vitest-environment jsdom

import {cleanup, fireEvent, render, waitFor} from "@testing-library/react";
import {Background, type Edge, Handle, type Node, Panel, Position, ReactFlow} from "@xyflow/react";
import type {createElement} from "react";
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {
	type ContributionDiagnostic,
	type ContributionModuleTransport,
	ContributionPanels,
	ContributionRegistry,
	contributionEdgeTypes,
	contributionNodeTypes,
} from "../../src/frontend-shell/contribution-registry.js";

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
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(248);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(132);
});

afterEach(cleanup);
afterAll(() => vi.restoreAllMocks());

const assets = {
	node: "/api/contribution-assets/v1-0000000000000000000000000000000000000000000000000000000000000000.js",
	edge: "/api/contribution-assets/v1-1111111111111111111111111111111111111111111111111111111111111111.js",
	panel:
		"/api/contribution-assets/v1-2222222222222222222222222222222222222222222222222222222222222222.js",
} as const;

const catalog = {
	contractVersion: 1,
	frontend: (Object.entries(assets) as ReadonlyArray<["node" | "edge" | "panel", string]>).map(
		([kind, asset]) => ({
			packageName: "render-throw-package",
			kind,
			key: `throw.${kind}`,
			asset,
		}),
	),
	diagnostics: [],
};

const loadRegistry = async (throwing: {value: boolean}) => {
	const modules = Object.fromEntries(
		(Object.entries(assets) as ReadonlyArray<["node" | "edge" | "panel", string]>).map(
			([kind, asset]) => [
				asset,
				{
					default: {
						contractVersion: 1,
						kind,
						render: (_props: object, api: {readonly createElement: typeof createElement}) => {
							if (throwing.value) throw new Error(`${kind} render failed`);
							return api.createElement("span", null, `${kind} katkısı sağlıklı`);
						},
					},
				},
			],
		),
	);
	const transport: ContributionModuleTransport = {
		read: vi.fn(async () => ({ok: true, contentType: "text/javascript"})),
		importModule: vi.fn(async (asset) => modules[asset]),
	};
	return ContributionRegistry.load(catalog, ContributionRegistry.empty(), transport);
};

const HealthyNode = () => (
	<>
		<Handle type="target" position={Position.Left} />
		<button type="button">Yerleşik düğüm çalışıyor</button>
		<Handle type="source" position={Position.Right} />
	</>
);
const HealthyEdge = () => <path data-testid="healthy-edge" />;

function Harness({
	registry,
	onFailure,
	onHealthyAction,
}: {
	readonly registry: ContributionRegistry;
	readonly onFailure: (failure: ContributionDiagnostic) => void;
	readonly onHealthyAction: () => void;
}) {
	const nodes: Array<Node> = [
		{
			id: "healthy-a",
			type: "healthy",
			position: {x: 0, y: 0},
			initialWidth: 248,
			initialHeight: 132,
			data: {},
		},
		{
			id: "healthy-b",
			type: "healthy",
			position: {x: 440, y: 0},
			initialWidth: 248,
			initialHeight: 132,
			data: {},
		},
		...[...registry.nodes.values()].map((entry) => ({
			id: `package:${entry.packageName}:${entry.key}`,
			type: entry.key,
			position: {x: 220, y: 180},
			initialWidth: 248,
			initialHeight: 132,
			data: {packageName: entry.packageName, contributionKey: entry.key},
		})),
	];
	const edges: Array<Edge> = [
		{id: "healthy-edge", source: "healthy-a", target: "healthy-b", type: "healthy"},
		...[...registry.edges.values()].map((entry) => ({
			id: `package:${entry.packageName}:${entry.key}`,
			source: "healthy-a",
			target: "healthy-b",
			type: entry.key,
			data: {packageName: entry.packageName, contributionKey: entry.key},
		})),
	];
	return (
		<div style={{width: 800, height: 600}}>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={{healthy: HealthyNode, ...contributionNodeTypes(registry, onFailure)}}
				edgeTypes={{healthy: HealthyEdge, ...contributionEdgeTypes(registry, onFailure)}}
				fitView
			>
				<Background />
				<Panel position="bottom-left">
					<button type="button" onClick={onHealthyAction}>
						Yerleşik panel çalışıyor
					</button>
				</Panel>
				<ContributionPanels registry={registry} onFailure={onFailure} />
			</ReactFlow>
		</div>
	);
}

describe("contribution render isolation", () => {
	it("contains node, edge, and panel throws and resets each package entry after unload/reload", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const throwing = {value: true};
		const failed = await loadRegistry(throwing);
		const onFailure = vi.fn<(failure: ContributionDiagnostic) => void>();
		const onHealthyAction = vi.fn();
		const view = render(
			<Harness registry={failed} onFailure={onFailure} onHealthyAction={onHealthyAction} />,
		);

		for (const kind of ["node", "edge", "panel"] as const) {
			const message = `render-throw-package paketi: Katkı throw.${kind} çizilirken durduruldu`;
			await waitFor(() =>
				expect(view.getByText(message).getAttribute("data-package")).toBe("render-throw-package"),
			);
		}
		expect(view.getAllByRole("button", {name: "Yerleşik düğüm çalışıyor"})).toHaveLength(2);
		expect(view.getByTestId("healthy-edge")).not.toBeNull();
		fireEvent.click(view.getByRole("button", {name: "Yerleşik panel çalışıyor"}));
		expect(onHealthyAction).toHaveBeenCalledOnce();
		expect(onFailure.mock.calls.map(([failure]) => failure.kind)).toEqual(
			expect.arrayContaining(["node", "edge", "panel"]),
		);

		view.rerender(
			<Harness
				registry={ContributionRegistry.empty()}
				onFailure={onFailure}
				onHealthyAction={onHealthyAction}
			/>,
		);
		await waitFor(() => expect(view.queryAllByRole("status")).toHaveLength(0));

		throwing.value = false;
		const recovered = await loadRegistry(throwing);
		view.rerender(
			<Harness registry={recovered} onFailure={onFailure} onHealthyAction={onHealthyAction} />,
		);
		for (const kind of ["node", "edge", "panel"] as const) {
			await waitFor(() => expect(view.getByText(`${kind} katkısı sağlıklı`)).not.toBeNull());
		}
	});
});
