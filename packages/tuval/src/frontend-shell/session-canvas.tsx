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
import {useEffect, useMemo} from "react";
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
import type {SessionWorkingSetFilter} from "./session-working-set.js";

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
	"controls.fitView.ariaLabel": "Çalışma kümesini göster",
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

function CanvasControls({minFitZoom}: {readonly minFitZoom: number}) {
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
				onClick={() => void fitView({minZoom: minFitZoom, maxZoom: 1})}
			>
				Çalışma kümesini göster
			</Button>
		</Panel>
	);
}

export interface SessionArchiveControls {
	readonly query: string;
	readonly filter: SessionWorkingSetFilter;
	readonly visibleCount: number;
	readonly totalCount: number;
	readonly matchedCount: number;
	readonly hiddenCount: number;
	readonly pageStart: number;
	readonly pageEnd: number;
	readonly hasNewer: boolean;
	readonly hasOlder: boolean;
	readonly viewRevision: number;
	readonly onQueryChange: (query: string) => void;
	readonly onFilterChange: (filter: SessionWorkingSetFilter) => void;
	readonly onNewer: () => void;
	readonly onOlder: () => void;
}

function ArchiveControls({archive}: {readonly archive: SessionArchiveControls}) {
	return (
		<div className="session-archive-panel">
			<Card as="section" className="session-archive" aria-labelledby="session-archive-title">
				<strong id="session-archive-title">Oturum arşivi</strong>
				<label htmlFor="session-archive-search">Oturum ara</label>
				<input
					id="session-archive-search"
					className="nodrag nopan nowheel"
					type="search"
					value={archive.query}
					placeholder="Kimlik veya çalışma dizini"
					onChange={(event) => archive.onQueryChange(event.currentTarget.value)}
				/>
				<label htmlFor="session-archive-filter">Filtre</label>
				<select
					id="session-archive-filter"
					className="nodrag nopan nowheel"
					value={archive.filter}
					onChange={(event) =>
						archive.onFilterChange(event.currentTarget.value as SessionWorkingSetFilter)
					}
				>
					<option value="all">Tüm oturumlar</option>
					<option value="lineage">Bağı olanlar</option>
					<option value="roots">Kök oturumlar</option>
				</select>
				<output id="session-working-set-summary" aria-live="polite">
					<strong>{archive.visibleCount}</strong> / {archive.totalCount} oturum tuvalde
					<span>
						{archive.matchedCount} eşleşme · {archive.hiddenCount} arşivde · {archive.pageStart}–
						{archive.pageEnd}
					</span>
				</output>
				<div className="session-archive__paging">
					<Button
						type="button"
						variant="secondary"
						disabled={!archive.hasNewer}
						onClick={archive.onNewer}
					>
						Daha yeni
					</Button>
					<Button
						type="button"
						variant="secondary"
						disabled={!archive.hasOlder}
						onClick={archive.onOlder}
					>
						Daha eski
					</Button>
				</div>
			</Card>
		</div>
	);
}

function WorkingSetFit({
	revision,
	minFitZoom,
}: {
	readonly revision: number;
	readonly minFitZoom: number;
}) {
	const {fitView} = useReactFlow();
	useEffect(() => {
		if (revision === 0) return;
		let fitFrame: number | undefined;
		const layoutFrame = requestAnimationFrame(() => {
			fitFrame = requestAnimationFrame(
				() => void fitView({padding: 0.1, minZoom: minFitZoom, maxZoom: 1}),
			);
		});
		return () => {
			cancelAnimationFrame(layoutFrame);
			if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
		};
	}, [fitView, minFitZoom, revision]);
	return null;
}

export interface SessionCanvasProps {
	readonly nodes: ReadonlyArray<SessionCanvasNode>;
	readonly edges: ReadonlyArray<SessionRelationshipEdge>;
	readonly onNodesChange: OnNodesChange<SessionCanvasNode>;
	readonly onEdgesChange: OnEdgesChange<SessionRelationshipEdge>;
	readonly onSelect: (session: LineageNode | null) => void;
	readonly archive?: SessionArchiveControls;
	readonly fitRevision?: number;
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
	archive,
	fitRevision = 0,
	contributions = ContributionRegistry.empty(),
	onContributionFailure = () => undefined,
}: SessionCanvasProps) {
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
	const minFitZoom = archive === undefined ? 0.35 : 0.9;
	const allEdgeTypes = useMemo(
		() =>
			({
				...edgeTypes,
				...contributionEdgeTypes(contributions, onContributionFailure),
			}) satisfies EdgeTypes,
		[contributions.revision, onContributionFailure],
	);
	return (
		<div
			className="session-canvas-root"
			data-has-archive={archive === undefined ? "false" : "true"}
		>
			<div className="session-canvas-flow">
				<ReactFlow<CanvasNode, CanvasEdge>
					nodes={[...nodes, ...packageNodes, ...packageEdgeNodes]}
					edges={[...edges, ...packageEdges]}
					onNodesChange={(changes) => {
						const sessionChanges = changes.filter(isSessionNodeChange);
						onNodesChange(sessionChanges);
						const selectedChange = sessionChanges.findLast(
							(change) => change.type === "select" && change.selected,
						);
						if (selectedChange?.type === "select") {
							const selectedNode = nodes.find(({id}) => id === selectedChange.id);
							if (selectedNode !== undefined) onSelect(selectedNode.data.session);
							return;
						}
						const clearedSelectedNode = sessionChanges.some(
							(change) =>
								change.type === "select" &&
								!change.selected &&
								nodes.some(({id, selected}) => id === change.id && selected),
						);
						if (clearedSelectedNode) onSelect(null);
					}}
					onEdgesChange={(changes) => onEdgesChange(changes.filter(isSessionEdgeChange))}
					nodeTypes={allNodeTypes}
					edgeTypes={allEdgeTypes}
					ariaLabelConfig={ariaLabelConfig}
					nodesConnectable={false}
					deleteKeyCode={null}
					fitView
					fitViewOptions={{
						padding: archive === undefined ? 0.2 : 0.1,
						minZoom: minFitZoom,
						maxZoom: 1,
					}}
					minZoom={0.35}
					maxZoom={1.8}
					colorMode="dark"
					proOptions={{hideAttribution: true}}
				>
					<Background color="var(--border-faint)" gap={24} size={1} />
					<CanvasControls minFitZoom={minFitZoom} />
					<WorkingSetFit
						revision={Math.max(fitRevision, archive?.viewRevision ?? 0)}
						minFitZoom={minFitZoom}
					/>
					<CanvasLegend />
					<ContributionPanels registry={contributions} onFailure={onContributionFailure} />
				</ReactFlow>
			</div>
			{archive === undefined ? null : <ArchiveControls archive={archive} />}
		</div>
	);
}
