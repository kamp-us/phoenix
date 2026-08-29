import {
	Background,
	BaseEdge,
	type EdgeChange,
	type EdgeProps,
	type EdgeTypes,
	Handle,
	type NodeChange,
	type NodeProps,
	type NodeTypes,
	type OnEdgesChange,
	type OnNodesChange,
	Panel,
	Position,
	ReactFlow,
	useReactFlow,
} from "@xyflow/react";
import {
	Activity,
	AlertTriangle,
	CheckCircle2,
	CircleDashed,
	Database,
	History,
	Link2Off,
	Radio,
	RotateCcw,
	Scan,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import {useLayoutEffect, useMemo, useRef} from "react";
import {Badge} from "../../../../apps/web/src/components/ui/Badge.js";
import {Button} from "../../../../apps/web/src/components/ui/Button.js";
import {Card} from "../../../../apps/web/src/components/ui/Card.js";
import {MetaRow} from "../../../../apps/web/src/components/ui/MetaRow.js";
import type {LineageNode} from "../shared/lineage.js";
import type {SessionCanvasNode, SessionRelationshipEdge} from "./canvas-adapter.js";
import {
	type ContributionCanvasEdge,
	type ContributionCanvasNode,
	type ContributionDiagnostic,
	ContributionPanels,
	ContributionRegistry,
	contributionEdgeTypes,
	contributionNodeTypes,
} from "./contribution-registry.js";
import {includesNodeDetail, nodeStatus, thinkingLabel} from "./node-detail.js";

const incomingLabel = (kinds: SessionCanvasNode["data"]["incomingKinds"]): string => {
	if (kinds.length === 0) return "Kök oturum";
	return kinds.map((kind) => (kind === "spawn" ? "Oluşturma" : "Dallanma")).join(" + ");
};

const statusIcon = (kind: ReturnType<typeof nodeStatus>["kind"]) => {
	if (kind === "running") return <Activity size={16} aria-hidden="true" />;
	if (kind === "stalled") return <CircleDashed size={16} aria-hidden="true" />;
	if (kind === "failed") return <AlertTriangle size={16} aria-hidden="true" />;
	if (kind === "disconnected") return <Link2Off size={16} aria-hidden="true" />;
	if (kind === "pending") return <Radio size={16} aria-hidden="true" />;
	if (kind === "unknown") return <CircleDashed size={16} aria-hidden="true" />;
	return <CheckCircle2 size={16} aria-hidden="true" />;
};

const metadataTimestamp = (timestamp: number): string =>
	new Intl.DateTimeFormat("tr-TR", {dateStyle: "short", timeStyle: "short"}).format(
		new Date(timestamp),
	);

export function SessionNodeCard({data, selected}: NodeProps<SessionCanvasNode>) {
	const status = nodeStatus(data.session, data.attachment);
	const showMeta = includesNodeDetail(data.detailLevel, "meta");
	const showLive = includesNodeDetail(data.detailLevel, "live");
	const showFull = includesNodeDetail(data.detailLevel, "full");
	const liveSession = data.attachment?.session;
	const unjoined = data.session.sourceFiles.length === 0;
	return (
		<Card
			as="article"
			className="session-node"
			data-detail-level={data.detailLevel}
			data-status={status.kind}
			data-selected={selected ? "true" : "false"}
		>
			<Handle id="relation-in" type="target" position={Position.Left} isConnectable={false} />
			<header className="session-node__header">
				<strong className="session-node__title">{data.title}</strong>
				<span
					className="session-node__status"
					data-status={status.kind}
					role="status"
					aria-live="polite"
					aria-atomic="true"
				>
					{statusIcon(status.kind)}
					{status.label}
				</span>
			</header>
			{showMeta ? (
				<>
					<span className="session-node__id">{data.session.piSessionId}</span>
					<span className="session-node__path">{data.session.cwd}</span>
					<MetaRow className="session-node__metadata">
						<Database size={12} aria-hidden="true" />
						<span>Metadata</span>
						<MetaRow.Dot />
						<time dateTime={new Date(data.session.updatedAt).toISOString()}>
							{metadataTimestamp(data.session.updatedAt)}
						</time>
					</MetaRow>
				</>
			) : null}
			{showLive ? (
				<MetaRow className="session-node__live" data-source={status.source}>
					<Radio size={12} aria-hidden="true" />
					<strong>{status.sourceLabel}</strong>
					<MetaRow.Dot />
					<span>{status.detail}</span>
				</MetaRow>
			) : null}
			{showFull ? (
				<>
					{liveSession === null || liveSession === undefined ? null : (
						<MetaRow className="session-node__runtime">
							<span>{liveSession.model.id}</span>
							<MetaRow.Dot />
							<span>düşünme {thinkingLabel(liveSession.thinkingLevel)}</span>
							<MetaRow.Dot />
							<span>r{liveSession.revision}</span>
						</MetaRow>
					)}
					<div className="session-node__history">
						<span className="session-node__history-label">
							<History size={12} aria-hidden="true" />
							Kalıcı geçmiş
						</span>
						<Badge>{unjoined ? "Geçmişe katılmadı" : incomingLabel(data.incomingKinds)}</Badge>
						{data.continuity.length === 0 ? null : (
							<Badge>
								<RotateCcw size={12} aria-hidden="true" />
								{data.continuity.length} devam
							</Badge>
						)}
					</div>
				</>
			) : null}
			<Handle id="relation-out" type="source" position={Position.Right} isConnectable={false} />
		</Card>
	);
}

export function RelationshipEdgeView({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	markerEnd,
	data,
	selected,
}: EdgeProps<SessionRelationshipEdge>) {
	const laneOffset = data?.laneOffset ?? 0;
	const distance = Math.abs(targetX - sourceX);
	const control = Math.max(48, distance * 0.42);
	const sourceControlX = sourcePosition === Position.Left ? sourceX - control : sourceX + control;
	const targetControlX = targetPosition === Position.Right ? targetX + control : targetX - control;
	const routeY = data?.routeY;
	const path =
		routeY === null || routeY === undefined
			? `M ${sourceX} ${sourceY} C ${sourceControlX} ${sourceY + laneOffset}, ${targetControlX} ${targetY + laneOffset}, ${targetX} ${targetY}`
			: `M ${sourceX} ${sourceY} C ${sourceX + 48} ${sourceY}, ${sourceX + 48} ${routeY + laneOffset}, ${sourceX + 96} ${routeY + laneOffset} L ${targetX - 96} ${routeY + laneOffset} C ${targetX - 48} ${routeY + laneOffset}, ${targetX - 48} ${targetY}, ${targetX} ${targetY}`;
	const kind = data?.kind ?? "spawn";
	return (
		<BaseEdge
			id={id}
			path={path}
			{...(markerEnd === undefined ? {} : {markerEnd})}
			style={{
				color: selected ? "var(--accent)" : "var(--border-strong)",
				stroke: "currentColor",
				strokeWidth: selected ? 4 : 3,
				strokeLinecap: "round",
			}}
			className={`relationship-edge relationship-edge--${kind}`}
		/>
	);
}

const nodeTypes = {session: SessionNodeCard} satisfies NodeTypes;
const edgeTypes = {relationship: RelationshipEdgeView} satisfies EdgeTypes;

export const ariaLabelConfig = {
	"node.a11yDescription.default":
		"Bir oturumu açmak için Enter veya Boşluk tuşuna bas. Seçiliyken ok tuşları oturumu taşır; Escape seçimi kaldırır.",
	"node.a11yDescription.keyboardDisabled":
		"Bir oturumu açmak için Enter veya Boşluk tuşuna bas. Seçiliyken ok tuşları oturumu taşır; Escape seçimi kaldırır.",
	"node.a11yDescription.ariaLiveMessage": ({
		direction,
		x,
		y,
	}: {
		direction: string;
		x: number;
		y: number;
	}) => `Oturum ${direction} yönünde taşındı. Yeni konum x ${Math.round(x)}, y ${Math.round(y)}.`,
	"edge.a11yDescription.default":
		"Bu ilişki bağlantısını seçmek için Enter veya Boşluk tuşuna bas.",
	"controls.ariaLabel": "Tuval yakınlaştırma denetimleri",
	"controls.zoomIn.ariaLabel": "Yakınlaştır",
	"controls.zoomOut.ariaLabel": "Uzaklaştır",
	"controls.fitView.ariaLabel": "Tüm oturumları göster",
	"controls.interactive.ariaLabel": "Oturum etkileşimini aç veya kapat",
	"minimap.ariaLabel": "Oturum haritası",
	"handle.ariaLabel": "Oturum ilişkisi bağlantısı",
};

function CanvasLegend() {
	return (
		<Panel position="bottom-left">
			<Card as="section" className="canvas-legend" aria-label="Oturum bağı göstergesi">
				<strong>Bağ türleri</strong>
				<span data-kind="spawn">
					<i aria-hidden="true" /> Oluşturma · düz ok
				</span>
				<span data-kind="fork">
					<i aria-hidden="true" /> Dallanma · kesik çizgi
				</span>
			</Card>
		</Panel>
	);
}

function CanvasControls() {
	const {fitView, zoomIn, zoomOut} = useReactFlow();
	return (
		<Panel className="canvas-controls" position="top-left" aria-label="Tuval görünüm denetimleri">
			<Button
				type="button"
				variant="secondary"
				icon={<ZoomIn size={16} />}
				onClick={() => void zoomIn()}
			>
				Yakınlaştır
			</Button>
			<Button
				type="button"
				variant="secondary"
				icon={<ZoomOut size={16} />}
				onClick={() => void zoomOut()}
			>
				Uzaklaştır
			</Button>
			<Button
				type="button"
				variant="secondary"
				icon={<Scan size={16} />}
				onClick={() => void fitView()}
			>
				Tümünü göster
			</Button>
		</Panel>
	);
}

export interface SessionCanvasProps {
	readonly nodes: ReadonlyArray<SessionCanvasNode>;
	readonly edges: ReadonlyArray<SessionRelationshipEdge>;
	readonly onNodesChange: OnNodesChange<SessionCanvasNode>;
	readonly onEdgesChange: OnEdgesChange<SessionRelationshipEdge>;
	readonly onSelect: (session: LineageNode | null) => void;
	readonly contributions?: ContributionRegistry;
	readonly onContributionFailure?: (failure: ContributionDiagnostic) => void;
}

type CanvasNode = SessionCanvasNode | ContributionCanvasNode;
type CanvasEdge = SessionRelationshipEdge | ContributionCanvasEdge;

const isSessionCanvasNode = (node: CanvasNode): node is SessionCanvasNode =>
	!node.id.startsWith("package:") && "session" in node.data;

type SessionNodeChange = Parameters<OnNodesChange<SessionCanvasNode>>[0][number];
type SessionEdgeChange = Parameters<OnEdgesChange<SessionRelationshipEdge>>[0][number];

const isSessionNodeChange = (change: NodeChange<CanvasNode>): change is SessionNodeChange => {
	if (change.type === "add" || change.type === "replace") {
		return isSessionCanvasNode(change.item);
	}
	return !change.id.startsWith("package:");
};

const isSessionEdgeChange = (change: EdgeChange<CanvasEdge>): change is SessionEdgeChange => {
	if (change.type === "add" || change.type === "replace") {
		return !change.item.id.startsWith("package:");
	}
	return !change.id.startsWith("package:");
};

export function SessionCanvas({
	nodes,
	edges,
	onNodesChange,
	onEdgesChange,
	onSelect,
	contributions = ContributionRegistry.empty(),
	onContributionFailure = () => undefined,
}: SessionCanvasProps) {
	const keyboardSelection = useRef<string | null>(nodes.find(({selected}) => selected)?.id ?? null);
	const keyboardFocus = useRef<string | null>(null);
	const externallySelected = nodes.find(({selected}) => selected)?.id;
	if (externallySelected !== undefined) keyboardSelection.current = externallySelected;
	const keyboardContext = useRef({nodes, edges, onNodesChange, onEdgesChange, onSelect});
	keyboardContext.current = {nodes, edges, onNodesChange, onEdgesChange, onSelect};
	const horizontal = nodes.map(({position}) => position.x);
	const vertical = nodes.map(({position}) => position.y);
	const contributionOrigin = {
		x: horizontal.length === 0 ? 0 : (Math.min(...horizontal) + Math.max(...horizontal)) / 2,
		y: vertical.length === 0 ? 0 : (Math.min(...vertical) + Math.max(...vertical)) / 2,
	};
	const packageNodes: ReadonlyArray<ContributionCanvasNode> = [...contributions.nodes.values()].map(
		(entry, index) => ({
			id: `package:${entry.packageName}:${entry.key}`,
			type: entry.key,
			position: {x: contributionOrigin.x + index * 360, y: contributionOrigin.y},
			initialWidth: 280,
			initialHeight: 112,
			draggable: false,
			selectable: true,
			ariaLabel: `${entry.packageName} paketinden ${entry.key} özel düğümü`,
			data: {packageName: entry.packageName, contributionKey: entry.key},
		}),
	);
	const packageEdgeEntries = [...contributions.edges.values()];
	const packageEdgeNodes: ReadonlyArray<SessionCanvasNode> = packageEdgeEntries.flatMap(
		(entry, index) => {
			const source = nodes.at(index % nodes.length);
			const target = nodes.at((index + 1) % nodes.length);
			if (source === undefined || target === undefined) return [];
			const identity = `package:${entry.packageName}:${entry.key}`;
			const y = contributionOrigin.y + 180 + index * 140;
			return [
				{
					...source,
					id: `${identity}:source`,
					position: {x: contributionOrigin.x - 200, y},
					draggable: false,
					selectable: false,
					focusable: false,
					ariaLabel: `${entry.packageName} paketinden ${entry.key} bağı başlangıcı`,
					data: {...source.data, title: `${entry.key} başlangıcı`, detailLevel: "bare"},
				},
				{
					...target,
					id: `${identity}:target`,
					position: {x: contributionOrigin.x + 200, y},
					draggable: false,
					selectable: false,
					focusable: false,
					ariaLabel: `${entry.packageName} paketinden ${entry.key} bağı bitişi`,
					data: {...target.data, title: `${entry.key} bitişi`, detailLevel: "bare"},
				},
			];
		},
	);
	const packageEdges: ReadonlyArray<ContributionCanvasEdge> = packageEdgeEntries.flatMap(
		(entry) => {
			const identity = `package:${entry.packageName}:${entry.key}`;
			if (!packageEdgeNodes.some(({id}) => id === `${identity}:source`)) return [];
			return [
				{
					id: identity,
					type: entry.key,
					source: `${identity}:source`,
					target: `${identity}:target`,
					sourceHandle: "relation-out",
					targetHandle: "relation-in",
					selectable: true,
					focusable: true,
					ariaLabel: `${entry.packageName} paketinden ${entry.key} özel bağı`,
					data: {packageName: entry.packageName, contributionKey: entry.key},
				},
			];
		},
	);
	const allNodeTypes = useMemo(
		() =>
			({
				...nodeTypes,
				...contributionNodeTypes(contributions, onContributionFailure),
			}) satisfies NodeTypes,
		[contributions.revision, onContributionFailure],
	);
	const allEdgeTypes = useMemo(
		() =>
			({
				...edgeTypes,
				...contributionEdgeTypes(contributions, onContributionFailure),
			}) satisfies EdgeTypes,
		[contributions.revision, onContributionFailure],
	);
	useLayoutEffect(() => {
		const handleKeyboard = (event: KeyboardEvent): void => {
			if (event.key === "Tab") {
				keyboardFocus.current = null;
				return;
			}
			if (!(document.activeElement instanceof Element)) return;
			const focused = document.activeElement;
			const directId = focused.closest<HTMLElement>(".react-flow__node-session")?.dataset.id;
			const id =
				directId ??
				(focused.matches(".react-flow__nodesselection-rect") || focused === document.body
					? (keyboardFocus.current ?? undefined)
					: undefined);
			const context = keyboardContext.current;
			const stop = (): void => {
				event.preventDefault();
				event.stopImmediatePropagation();
			};
			const edgeId = focused.closest<SVGGElement>(".react-flow__edge")?.dataset.id;
			if (
				edgeId !== undefined &&
				(event.key === "Enter" || event.key === " " || event.key === "Escape")
			) {
				stop();
				context.onEdgesChange(
					context.edges.map((edge) => ({
						type: "select" as const,
						id: edge.id,
						selected: event.key === "Escape" ? false : edge.id === edgeId,
					})),
				);
				return;
			}
			const node =
				id === undefined ? undefined : context.nodes.find((candidate) => candidate.id === id);
			if (node === undefined) return;
			if (event.key === "Enter" || event.key === " ") {
				stop();
				keyboardSelection.current = node.id;
				keyboardFocus.current = null;
				context.onNodesChange(
					context.nodes.map((candidate) => ({
						type: "select" as const,
						id: candidate.id,
						selected: candidate.id === node.id,
					})),
				);
				context.onSelect(node.data.session);
				return;
			}
			if (event.key === "Escape") {
				stop();
				keyboardSelection.current = null;
				keyboardFocus.current = null;
				context.onNodesChange(
					context.nodes.map((candidate) => ({
						type: "select" as const,
						id: candidate.id,
						selected: false,
					})),
				);
				context.onSelect(null);
				return;
			}
			const direction = {
				ArrowLeft: {x: -1, y: 0},
				ArrowRight: {x: 1, y: 0},
				ArrowUp: {x: 0, y: -1},
				ArrowDown: {x: 0, y: 1},
			}[event.key];
			if (direction === undefined || keyboardSelection.current !== node.id) return;
			stop();
			const factor = event.shiftKey ? 4 : 1;
			context.onNodesChange([
				{
					type: "position",
					id: node.id,
					position: {
						x: node.position.x + direction.x * factor,
						y: node.position.y + direction.y * factor,
					},
				},
			]);
		};
		const clearKeyboardFocus = (event: PointerEvent): void => {
			if (
				event.target instanceof HTMLElement &&
				event.target.closest(".react-flow__node-session") === null
			) {
				keyboardFocus.current = null;
			}
		};
		const preserveKeyboardFocus = (event: FocusEvent): void => {
			const id = keyboardFocus.current;
			if (
				id === null ||
				!(event.target instanceof HTMLElement) ||
				event.target.closest(".react-flow__node-session") !== null ||
				document.querySelector('[role="dialog"]') !== null
			) {
				return;
			}
			queueMicrotask(() => {
				if (keyboardFocus.current !== id) return;
				document
					.querySelector<HTMLElement>(`.react-flow__node-session[data-id="${CSS.escape(id)}"]`)
					?.focus({preventScroll: true});
			});
		};
		window.addEventListener("keydown", handleKeyboard, {capture: true});
		window.addEventListener("pointerdown", clearKeyboardFocus, {capture: true});
		window.addEventListener("focusin", preserveKeyboardFocus, {capture: true});
		return () => {
			window.removeEventListener("keydown", handleKeyboard, {capture: true});
			window.removeEventListener("pointerdown", clearKeyboardFocus, {capture: true});
			window.removeEventListener("focusin", preserveKeyboardFocus, {capture: true});
		};
	}, []);
	useLayoutEffect(() => {
		const frame = requestAnimationFrame(() => {
			const id = keyboardFocus.current;
			if (id === null || document.querySelector('[role="dialog"]') !== null) return;
			if (
				document.activeElement instanceof HTMLElement &&
				document.activeElement.closest<HTMLElement>(".react-flow__node-session")?.dataset.id === id
			) {
				return;
			}
			document
				.querySelector<HTMLElement>(`.react-flow__node-session[data-id="${CSS.escape(id)}"]`)
				?.focus({preventScroll: true});
		});
		return () => cancelAnimationFrame(frame);
	});
	return (
		<ReactFlow<CanvasNode, CanvasEdge>
			nodes={[...nodes, ...packageNodes, ...packageEdgeNodes]}
			edges={[...edges, ...packageEdges]}
			onFocusCapture={(event) => {
				if (!(event.target instanceof HTMLElement)) return;
				const id = event.target.closest<HTMLElement>(".react-flow__node-session")?.dataset.id;
				if (id === undefined) return;
				keyboardFocus.current = id;
			}}
			onNodesChange={(changes) => onNodesChange(changes.filter(isSessionNodeChange))}
			onEdgesChange={(changes) => onEdgesChange(changes.filter(isSessionEdgeChange))}
			onNodeClick={(_, node) => {
				if (!isSessionCanvasNode(node)) return;
				keyboardSelection.current = node.id;
				onSelect(node.data.session);
			}}
			nodeTypes={allNodeTypes}
			edgeTypes={allEdgeTypes}
			ariaLabelConfig={ariaLabelConfig}
			disableKeyboardA11y
			nodesConnectable={false}
			deleteKeyCode={null}
			fitView
			fitViewOptions={{padding: 0.2, maxZoom: 1}}
			minZoom={0.35}
			maxZoom={1.8}
			colorMode="dark"
			proOptions={{hideAttribution: true}}
		>
			<Background color="var(--border-faint)" gap={24} size={1} />
			<CanvasControls />
			<CanvasLegend />
			<ContributionPanels registry={contributions} onFailure={onContributionFailure} />
		</ReactFlow>
	);
}
