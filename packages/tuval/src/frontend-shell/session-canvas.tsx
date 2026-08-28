import {
	Background,
	BaseEdge,
	type EdgeProps,
	type EdgeTypes,
	getBezierPath,
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
import {Scan, ZoomIn, ZoomOut} from "lucide-react";
import {Button} from "../../../../apps/web/src/components/ui/Button.js";
import {Card} from "../../../../apps/web/src/components/ui/Card.js";
import type {DiscoveredSession} from "../shared/discovery.js";
import type {SessionCanvasNode, SessionRelationshipEdge} from "./canvas-adapter.js";

export function SessionNodeCard({data, selected}: NodeProps<SessionCanvasNode>) {
	return (
		<Card as="article" className="session-node" data-selected={selected ? "true" : "false"}>
			<Handle id="relation-in" type="target" position={Position.Left} isConnectable={false} />
			<span className="session-node__signal" aria-hidden="true" />
			<strong className="session-node__title">{data.title}</strong>
			<span className="session-node__id">{data.session.piSessionId}</span>
			<span className="session-node__path">{data.session.cwd}</span>
			<span className="session-node__relation">
				{data.session.parentSessionId === undefined ? "Kök oturum" : "Alt oturum"}
			</span>
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
}: EdgeProps<SessionRelationshipEdge>) {
	const [path] = getBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
	});
	return <BaseEdge id={id} path={path} className="relationship-edge" />;
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
	readonly onSelect: (session: DiscoveredSession | null) => void;
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
			minZoom={0.55}
			maxZoom={1.8}
			colorMode="dark"
			proOptions={{hideAttribution: true}}
		>
			<Background color="var(--border-faint)" gap={24} size={1} />
			<CanvasControls />
		</ReactFlow>
	);
}
