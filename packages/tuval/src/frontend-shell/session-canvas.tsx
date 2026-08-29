import {
	Background,
	BaseEdge,
	type EdgeProps,
	type EdgeTypes,
	Handle,
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
import {Badge} from "../../../../apps/web/src/components/ui/Badge.js";
import {Button} from "../../../../apps/web/src/components/ui/Button.js";
import {Card} from "../../../../apps/web/src/components/ui/Card.js";
import {MetaRow} from "../../../../apps/web/src/components/ui/MetaRow.js";
import type {LineageNode} from "../shared/lineage.js";
import type {SessionCanvasNode, SessionRelationshipEdge} from "./canvas-adapter.js";
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
	"node.a11yDescription.keyboardDisabled": "Bu oturum çalışma alanında seçilebilir.",
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
}

export function SessionCanvas({
	nodes,
	edges,
	onNodesChange,
	onEdgesChange,
	onSelect,
}: SessionCanvasProps) {
	return (
		<ReactFlow<SessionCanvasNode, SessionRelationshipEdge>
			nodes={[...nodes]}
			edges={[...edges]}
			onNodesChange={onNodesChange}
			onEdgesChange={onEdgesChange}
			onNodeClick={(_, node) => onSelect(node.data.session)}
			onSelectionChange={({nodes: selectedNodes}) =>
				onSelect(selectedNodes.at(-1)?.data.session ?? null)
			}
			nodeTypes={nodeTypes}
			edgeTypes={edgeTypes}
			ariaLabelConfig={ariaLabelConfig}
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
		</ReactFlow>
	);
}
