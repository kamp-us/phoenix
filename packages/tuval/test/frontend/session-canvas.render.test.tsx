// @vitest-environment jsdom

import {cleanup, render, waitFor} from "@testing-library/react";
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {toLineageEdges, toSessionNodes} from "../../src/frontend-shell/canvas-adapter.js";
import {SessionCanvas} from "../../src/frontend-shell/session-canvas.js";
import type {LineageProjection} from "../../src/shared/lineage.js";
import type {AttachedLiveSession, DisconnectedLiveSession} from "../../src/shared/live-session.js";

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
	it("renders coincident spawn and fork relations as different painted paths", async () => {
		const coincident: LineageProjection = {
			...projection,
			graph: {
				...projection.graph,
				edges: [
					projection.graph.edges[0]!,
					{
						...projection.graph.edges[1]!,
						parent: node("root").id,
						child: node("spawned").id,
					},
				],
			},
		};
		const view = render(
			<div style={{width: 800, height: 600}}>
				<SessionCanvas
					nodes={toSessionNodes(coincident)}
					edges={toLineageEdges(coincident)}
					onNodesChange={vi.fn()}
					onEdgesChange={vi.fn()}
					onSelect={vi.fn()}
				/>
			</div>,
		);

		await waitFor(() => {
			const paths = [...view.container.querySelectorAll<SVGPathElement>(".relationship-edge")];
			expect(paths).toHaveLength(2);
			expect(paths[0]?.getAttribute("d")).not.toBe(paths[1]?.getAttribute("d"));
		});
	});

	it("renders exactly the contract fields ruled for each detail level", async () => {
		const attached: AttachedLiveSession = {
			_tag: "attached",
			sessionId: "spawned",
			revision: 7,
			phase: "retry",
			model: {provider: "anthropic", id: "claude-sonnet"},
			thinkingLevel: "high",
			completion: "running",
			transcript: [],
			lastEventSequence: 12,
			connection: "connected",
			ownership: "exclusive",
		};
		const fieldsByLevel = {
			bare: ["spawned", "Takıldı"],
			meta: ["spawned", "/work/spawned", "Metadata"],
			live: ["Protokol canlı", "Takıldı", "Yeniden deniyor"],
			full: ["Kalıcı geçmiş", "1 devam", "claude-sonnet", "yüksek"],
		} as const;
		for (const level of ["bare", "meta", "live", "full"] as const) {
			const view = render(
				<div style={{width: 800, height: 600}}>
					<SessionCanvas
						nodes={toSessionNodes(projection, {
							detailLevel: level,
							attachments: new Map([
								[node("spawned").id, {connection: "attached", session: attached}],
							]),
						})}
						edges={toLineageEdges(projection)}
						onNodesChange={vi.fn()}
						onEdgesChange={vi.fn()}
						onSelect={vi.fn()}
					/>
				</div>,
			);
			await waitFor(() =>
				expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(3),
			);
			const card = view.container.querySelector<HTMLElement>('[data-id="pi:spawned"]');
			for (const expected of fieldsByLevel[level]) expect(card?.textContent).toContain(expected);
			if (level === "bare") {
				expect(card?.textContent).not.toContain("/work/spawned");
				expect(card?.textContent).not.toContain("Kalıcı geçmiş");
			}
			if (level !== "full") expect(card?.textContent).not.toContain("claude-sonnet");
			expect(card?.querySelector("textarea, [contenteditable], pre")).toBeNull();
			view.unmount();
		}
	});

	it("labels disconnected and unknown unattached state without claiming protocol-live data", async () => {
		const disconnected: DisconnectedLiveSession = {
			_tag: "disconnected",
			sessionId: "forked",
			revision: 4,
			phase: "idle",
			model: {provider: "anthropic", id: "claude-haiku"},
			thinkingLevel: "medium",
			completion: "disconnected",
			transcript: [],
			lastEventSequence: 8,
			connection: "disconnected",
			ownership: "none",
			reason: "socket closed",
		};
		const unknownProjection: LineageProjection = {
			...projection,
			graph: {
				...projection.graph,
				nodes: projection.graph.nodes.map((entry) =>
					entry.id === node("root").id ? {...entry, sourceFiles: []} : entry,
				),
			},
		};
		const view = render(
			<div style={{width: 800, height: 600}}>
				<SessionCanvas
					nodes={toSessionNodes(unknownProjection, {
						detailLevel: "full",
						attachments: new Map([
							[node("forked").id, {connection: "disconnected", session: disconnected}],
						]),
					})}
					edges={toLineageEdges(unknownProjection)}
					onNodesChange={vi.fn()}
					onEdgesChange={vi.fn()}
					onSelect={vi.fn()}
				/>
			</div>,
		);
		await waitFor(() =>
			expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(3),
		);
		const disconnectedCard = view.container.querySelector<HTMLElement>('[data-id="pi:forked"]');
		expect(disconnectedCard?.textContent).toContain("Bağlantı kesildi");
		expect(disconnectedCard?.textContent).not.toContain("Protokol canlı");
		const unknownCard = view.container.querySelector<HTMLElement>('[data-id="pi:root"]');
		expect(unknownCard?.textContent).toContain("Tazelik bilinmiyor");
		expect(unknownCard?.textContent).toContain("Geçmişe katılmadı");
		expect(unknownCard?.textContent).not.toContain("Protokol canlı");
	});

	it("renders failed and completed live states with text and drawn icons", async () => {
		const live = (sessionId: string, completion: "complete" | "error"): AttachedLiveSession => ({
			_tag: "attached",
			sessionId,
			revision: 2,
			phase: "idle",
			model: {provider: "anthropic", id: "claude-sonnet"},
			thinkingLevel: "medium",
			completion,
			transcript: [],
			lastEventSequence: 3,
			connection: "connected",
			ownership: "exclusive",
		});
		const view = render(
			<div style={{width: 800, height: 600}}>
				<SessionCanvas
					nodes={toSessionNodes(projection, {
						detailLevel: "live",
						attachments: new Map([
							[node("root").id, {connection: "attached", session: live("root", "complete")}],
							[node("spawned").id, {connection: "attached", session: live("spawned", "error")}],
						]),
					})}
					edges={toLineageEdges(projection)}
					onNodesChange={vi.fn()}
					onEdgesChange={vi.fn()}
					onSelect={vi.fn()}
				/>
			</div>,
		);
		await waitFor(() =>
			expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(3),
		);
		const completed = view.container.querySelector<HTMLElement>('[data-id="pi:root"]');
		const failed = view.container.querySelector<HTMLElement>('[data-id="pi:spawned"]');
		expect(completed?.textContent).toContain("Tamamlandı");
		expect(
			completed?.querySelector('.session-node__status[data-status="completed"] svg'),
		).not.toBeNull();
		expect(failed?.textContent).toContain("Başarısız");
		expect(failed?.querySelector('.session-node__status[data-status="failed"] svg')).not.toBeNull();
	});

	it("renders named typed edges, resume continuity, and matching relationship handles", async () => {
		const view = render(
			<div style={{width: 800, height: 600}}>
				<SessionCanvas
					nodes={toSessionNodes(projection, {detailLevel: "full"})}
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
