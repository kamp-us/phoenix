import {
	applyEdgeChanges,
	applyNodeChanges,
	Background,
	BaseEdge,
	Controls,
	type EdgeProps,
	type EdgeTypes,
	getBezierPath,
	Handle,
	type NodeProps,
	type NodeTypes,
	type OnEdgesChange,
	type OnNodesChange,
	Position,
	ReactFlow,
} from "@xyflow/react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import type {DiscoveredSession, DiscoveryOutcome, DiscoveryProblem} from "../shared/discovery.js";
import type {LiveSessionView} from "../shared/live-session.js";
import {
	reconcileSessionNodes,
	type SessionCanvasNode,
	type SessionRelationshipEdge,
	toRelationshipEdges,
} from "./canvas-adapter.js";
import {ChatPane, type PaneConnection, type SendResult} from "./chat-pane.js";
import {
	attachLiveSession,
	decodeLiveEvent,
	discoverSessions,
	promptLiveSession,
	releaseLiveSession,
} from "./fate-client.js";
import "@xyflow/react/dist/style.css";
import "./styles.css";

interface PaneState {
	readonly connection: PaneConnection;
	readonly session: LiveSessionView | null;
	readonly message?: string;
}

interface DiscoveryView {
	readonly tone: string;
	readonly label: string;
	readonly description: string;
	readonly state?: {
		readonly eyebrow: string;
		readonly title: string;
		readonly description: string;
		readonly action: string;
		readonly details: ReadonlyArray<string>;
	};
}

const basename = (path: string): string => {
	const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
	return parts.at(-1) ?? path;
};

const problemDetails = (problems: ReadonlyArray<DiscoveryProblem>): ReadonlyArray<string> =>
	problems.map((problem) => `${basename(problem.source)}: ${problem.message}`);

const discoveryView = (outcome: DiscoveryOutcome | null): DiscoveryView => {
	if (outcome === null) {
		return {
			tone: "loading",
			label: "Oturumlar aranıyor",
			description: "Yapılandırılmış pi oturum kaynakları okunuyor",
			state: {
				eyebrow: "Keşif sürüyor",
				title: "Etkin çalışmalar bulunuyor",
				description: "Tuval yerel pi aracından oturumları isterken çalışma alanı açık kalır.",
				action: "Yeniden tara",
				details: [],
			},
		};
	}
	if (outcome._tag === "ready") {
		return {
			tone: "ready",
			label: "Bağlı",
			description: `${outcome.sessions.length} oturum çalışma alanında`,
		};
	}
	if (outcome._tag === "empty") {
		return {
			tone: "empty",
			label: "Oturum yok",
			description: "Keşif başarıyla tamamlandı",
			state: {
				eyebrow: "Çalışma alanı açık",
				title: "Oturum bulunamadı",
				description: "Bir pi kodlama oturumu başlat, ardından Tuval'i yeniden tara.",
				action: "Yeniden tara",
				details: [],
			},
		};
	}
	if (outcome._tag === "partial-source") {
		return {
			tone: "warning",
			label: "Kısmi kaynak",
			description: `${outcome.sessions.length} oturum hazır; ${outcome.problems.length} kaynak incelenmeli`,
			state: {
				eyebrow: "Bazı oturumlar hazır",
				title: "Bir kaynak okunamadı",
				description: "Geçerli oturumlar korunuyor. Kaynağı düzeltip yeniden tara.",
				action: "Keşfi yinele",
				details: problemDetails(outcome.problems),
			},
		};
	}
	if (outcome._tag === "transport") {
		return {
			tone: "danger",
			label: "Bağlantı kesildi",
			description: "Pi keşif taşıması kullanılamıyor",
			state: {
				eyebrow: "Bağlantı yok",
				title: "Tuval pi'ye ulaşamıyor",
				description: "Pi aracının çalıştığını doğrula; eski oturumlar gösterilmiyor.",
				action: "Yeniden bağlan",
				details: [outcome.message],
			},
		};
	}
	return {
		tone: "danger",
		label: "Başlatma engellendi",
		description: "Yapılandırılmış oturum kaynağı kullanılamıyor",
		state: {
			eyebrow: "Keşif başlayamadı",
			title: "Oturum kaynağını denetle",
			description: "Yapılandırılmış pi oturum dizininin okunabilir olduğunu doğrula.",
			action: "Yeniden dene",
			details: [outcome.message, ...problemDetails(outcome.problems)],
		},
	};
};

function SessionNodeCard({data, selected}: NodeProps<SessionCanvasNode>) {
	return (
		<article className="session-node" data-selected={selected ? "true" : "false"}>
			<Handle id="relation-in" type="target" position={Position.Left} isConnectable={false} />
			<span className="session-node__signal" aria-hidden="true" />
			<strong className="session-node__title">{data.title}</strong>
			<span className="session-node__id">{data.session.piSessionId}</span>
			<span className="session-node__path">{data.session.cwd}</span>
			<span className="session-node__relation">
				{data.session.parentSessionId === undefined ? "Kök oturum" : "Alt oturum"}
			</span>
			<Handle id="relation-out" type="source" position={Position.Right} isConnectable={false} />
		</article>
	);
}

function RelationshipEdgeView({
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

const ariaLabelConfig = {
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

const sessionsOf = (outcome: DiscoveryOutcome | null): ReadonlyArray<DiscoveredSession> => {
	if (outcome?._tag === "ready" || outcome?._tag === "partial-source") return outcome.sessions;
	return [];
};

const focusCanvasNode = (identity: string): void => {
	requestAnimationFrame(() => {
		for (const element of document.querySelectorAll<HTMLElement>(".react-flow__node")) {
			if (element.dataset.id === identity) {
				element.focus();
				break;
			}
		}
	});
};

export function TuvalApp() {
	const [outcome, setOutcome] = useState<DiscoveryOutcome | null>(null);
	const [nodes, setNodes] = useState<ReadonlyArray<SessionCanvasNode>>([]);
	const [edges, setEdges] = useState<ReadonlyArray<SessionRelationshipEdge>>([]);
	const [selected, setSelected] = useState<DiscoveredSession | null>(null);
	const [pane, setPane] = useState<PaneState>({connection: "pending", session: null});
	const discoveryGeneration = useRef(0);
	const ignoreSelectionChange = useRef(false);
	const selectedRef = useRef<DiscoveredSession | null>(null);
	selectedRef.current = selected;
	const view = discoveryView(outcome);
	const sessions = useMemo(() => sessionsOf(outcome), [outcome]);

	useEffect(() => {
		setNodes((current) =>
			reconcileSessionNodes(current, sessions).map((node) => ({
				...node,
				selected: node.id === selected?.identity,
			})),
		);
		setEdges(toRelationshipEdges(sessions));
		if (selected !== null && !sessions.some((session) => session.identity === selected.identity)) {
			setSelected(null);
		}
	}, [selected, sessions]);

	const discover = useCallback(async (): Promise<void> => {
		const generation = ++discoveryGeneration.current;
		setOutcome(null);
		try {
			const next = await discoverSessions();
			if (generation === discoveryGeneration.current) setOutcome(next);
		} catch (error) {
			if (generation !== discoveryGeneration.current) return;
			setOutcome({
				_tag: "transport",
				message: error instanceof Error ? error.message : String(error),
				retryable: true,
			});
		}
	}, []);

	useEffect(() => void discover(), [discover]);

	useEffect(() => {
		if (selected === null) return;
		let active = true;
		let eventSource: EventSource | undefined;
		let lastSequence = 0;
		setPane({connection: "pending", session: null});

		void attachLiveSession(selected.piSessionId)
			.then((attached) => {
				if (!active) return;
				if (attached._tag === "refused") {
					setPane({
						connection: attached.code === "disconnected" ? "disconnected" : "refused",
						session: null,
						message: attached.reason,
					});
					return;
				}
				lastSequence = attached.session.lastEventSequence;
				setPane({connection: "attached", session: attached.session});
				eventSource = new EventSource(`/fate/live?afterSequence=${lastSequence}`);
				eventSource.onopen = () => {
					if (!active) return;
					setPane((current) =>
						current.session?._tag === "attached"
							? {connection: "attached", session: current.session}
							: current,
					);
				};
				eventSource.onmessage = (message) => {
					if (!active) return;
					let raw: unknown;
					try {
						raw = JSON.parse(message.data);
					} catch {
						setPane((current) => ({
							...current,
							connection: "malformed",
							message: "Canlı akış geçerli JSON taşımadı.",
						}));
						eventSource?.close();
						return;
					}
					const event = decodeLiveEvent(raw);
					if (event === undefined) {
						setPane((current) => ({
							...current,
							connection: "malformed",
							message: "Canlı akış olayı doğrulanamadı.",
						}));
						eventSource?.close();
						return;
					}
					if (event.sequence <= lastSequence) return;
					lastSequence = event.sequence;
					if (event._tag === "session" && event.session.sessionId === selected.piSessionId) {
						setPane({
							connection: event.session._tag === "attached" ? "attached" : "disconnected",
							session: event.session,
							...(event.session._tag === "disconnected" ? {message: event.session.reason} : {}),
						});
					} else if (
						event._tag === "prompt" &&
						event.outcome._tag === "acknowledged" &&
						event.outcome.session.sessionId === selected.piSessionId
					) {
						setPane({connection: "attached", session: event.outcome.session});
					} else if (event._tag === "released" && event.sessionId === selected.piSessionId) {
						setPane((current) => ({
							...current,
							connection: "disconnected",
							message: "Oturum sahipliği bırakıldı.",
						}));
					} else if (
						event._tag === "diagnostic" &&
						(event.sessionId === null || event.sessionId === selected.piSessionId)
					) {
						setPane((current) => ({
							...current,
							connection: "malformed",
							message: event.message,
						}));
					}
				};
				eventSource.onerror = () => {
					if (!active) return;
					setPane((current) => ({
						...current,
						connection: "disconnected",
						message: "Canlı olay bağlantısı kesildi; yeniden bağlanma bekleniyor.",
					}));
				};
			})
			.catch((error) => {
				if (!active) return;
				setPane({
					connection: "disconnected",
					session: null,
					message: error instanceof Error ? error.message : "Oturuma bağlanılamadı.",
				});
			});

		return () => {
			active = false;
			eventSource?.close();
		};
	}, [selected]);

	const onNodesChange = useCallback<OnNodesChange<SessionCanvasNode>>(
		(changes) => setNodes((current) => applyNodeChanges(changes, [...current])),
		[],
	);
	const onEdgesChange = useCallback<OnEdgesChange<SessionRelationshipEdge>>(
		(changes) => setEdges((current) => applyEdgeChanges(changes, [...current])),
		[],
	);

	const closePane = (): void => {
		if (selected === null) return;
		const identity = selected.identity;
		ignoreSelectionChange.current = true;
		setNodes((current) => current.map((node) => ({...node, selected: false})));
		setSelected(null);
		void releaseLiveSession().catch(() => undefined);
		requestAnimationFrame(() => {
			ignoreSelectionChange.current = false;
			focusCanvasNode(identity);
		});
	};

	const sendPrompt = async (text: string): Promise<SendResult> => {
		const target = selectedRef.current;
		if (target === null) return {ok: false, message: "Açık bir oturum yok."};
		try {
			const response = await promptLiveSession(crypto.randomUUID(), text);
			if (selectedRef.current?.identity !== target.identity) {
				return {ok: false, message: "İleti gönderilirken başka bir oturuma geçildi."};
			}
			if (response._tag === "acknowledged") {
				setPane({connection: "attached", session: response.session});
				return {ok: true, message: "İleti pi tarafından onaylandı."};
			}
			if (response.code === "lease-refused") {
				setPane((current) => ({...current, connection: "refused", message: response.reason}));
			} else if (response.code === "disconnected") {
				setPane((current) => ({...current, connection: "disconnected", message: response.reason}));
			}
			return {ok: false, message: response.reason};
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : "İleti gönderilemedi.",
			};
		}
	};

	return (
		<div className="tuval-shell">
			<header className="topbar">
				<div className="brand">
					<div className="brand__mark" aria-hidden="true">
						TV
					</div>
					<div className="brand__copy">
						<h1>Tuval</h1>
						<p>Yerel pi oturum alanı</p>
					</div>
				</div>
				<div className="status-badge" data-tone={view.tone} role="status" aria-live="polite">
					<strong id="status-label">{view.label}</strong>
					<span id="status-description">{view.description}</span>
				</div>
				<button
					id="refresh-sessions"
					className="control-button"
					type="button"
					onClick={() => void discover()}
				>
					Oturumları yenile
				</button>
			</header>

			<main className="workspace" aria-label="Tuval oturum çalışma alanı">
				<section id="canvas" className="canvas" aria-label="Serbest kaydırılabilir oturum tuvali">
					<div id="canvas-stage" className="canvas-stage">
						<ReactFlow<SessionCanvasNode, SessionRelationshipEdge>
							nodes={[...nodes]}
							edges={[...edges]}
							onNodesChange={onNodesChange}
							onEdgesChange={onEdgesChange}
							onNodeClick={(_, node) => setSelected(node.data.session)}
							onSelectionChange={({nodes: selectedNodes}) => {
								if (ignoreSelectionChange.current) return;
								const node = selectedNodes.at(-1);
								if (node !== undefined) setSelected(node.data.session);
							}}
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
							<Controls showInteractive={false} />
						</ReactFlow>
					</div>

					{view.state === undefined ? null : (
						<section
							id="discovery-state"
							className="state-panel"
							data-tone={view.tone}
							aria-labelledby="state-title"
						>
							<p className="state-panel__eyebrow">{view.state.eyebrow}</p>
							<h2 id="state-title">{view.state.title}</h2>
							<p>{view.state.description}</p>
							{view.state.details.length === 0 ? null : (
								<ul className="state-panel__details">
									{view.state.details.map((detail) => (
										<li key={detail}>{detail}</li>
									))}
								</ul>
							)}
							<button
								id="state-action"
								className="control-button control-button--primary"
								type="button"
								onClick={() => void discover()}
							>
								{view.state.action}
							</button>
						</section>
					)}

					<p className="canvas-help">
						Sürükleyerek kaydır · tekerlekle yakınlaştır · <kbd>Tab</kbd> ile oturumlara geç
					</p>
				</section>

				{selected === null ? null : (
					<ChatPane
						selected={selected}
						connection={pane.connection}
						session={pane.session}
						{...(pane.message === undefined ? {} : {message: pane.message})}
						onClose={closePane}
						onSend={sendPrompt}
					/>
				)}
			</main>
		</div>
	);
}

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Tuval root element is missing");
createRoot(root).render(<TuvalApp />);
