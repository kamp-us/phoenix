import {
	applyEdgeChanges,
	applyNodeChanges,
	type OnEdgesChange,
	type OnNodesChange,
} from "@xyflow/react";
import {useCallback, useEffect, useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import {Button} from "../../../../apps/web/src/components/ui/Button.js";
import {Card, Surface} from "../../../../apps/web/src/components/ui/Card.js";
import type {DiscoveredSession, DiscoveryOutcome, DiscoveryProblem} from "../shared/discovery.js";
import type {LineageNode, LineageProblem, LineageProjection} from "../shared/lineage.js";
import type {LiveSessionView} from "../shared/live-session.js";
import {
	reconcileLineageEdges,
	reconcileSessionNodes,
	type SessionCanvasNode,
	type SessionRelationshipEdge,
} from "./canvas-adapter.js";
import {ChatPane, type PaneConnection, type SendResult} from "./chat-pane.js";
import {
	attachLiveSession,
	decodeLiveEvent,
	discoverSessions,
	promptLiveSession,
	readLineage,
	releaseLiveSession,
} from "./fate-client.js";
import {SessionCanvas} from "./session-canvas.js";
import "@manti-ui/styles/index.css";
import "@xyflow/react/dist/style.css";
import "./styles.css";

interface PaneState {
	readonly connection: PaneConnection;
	readonly session: LiveSessionView | null;
	readonly message?: string;
}

type PaneSelection =
	| {readonly _tag: "closed"}
	| {
			readonly _tag: "open";
			readonly selected: DiscoveredSession;
			readonly generation: number;
			readonly pane: PaneState;
	  };

type PaneUpdate = PaneState | ((current: PaneState) => PaneState);

interface StreamCursor {
	readonly sessionId: string;
	readonly generation: number;
	readonly sequence: number;
	readonly revision: number;
}

const pendingPane = (): PaneState => ({connection: "pending", session: null});

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

const sessionsOf = (outcome: DiscoveryOutcome | null): ReadonlyArray<DiscoveredSession> => {
	if (outcome?._tag === "ready" || outcome?._tag === "partial-source") return outcome.sessions;
	return [];
};

const discoveredSessionFrom = (node: LineageNode): DiscoveredSession => ({
	identity: node.id,
	piSessionId: node.piSessionId,
	createdAt: node.createdAt,
	updatedAt: node.updatedAt,
	cwd: node.cwd,
	sourceFile: node.sourceFiles.at(0) ?? "",
});

const lineageProblemLabel = (problem: LineageProblem): string => {
	if (problem.code === "malformed-run" || problem.code === "malformed-session") {
		return "Bozuk kayıt";
	}
	if (problem.code === "unresolved-session") return "Birleşmemiş oturum";
	if (problem.code === "retention-loss") return "Kaynağı artık yok";
	if (problem.code === "protocol-unavailable") return "Protokol kullanılamıyor";
	return "Depo temizliği gerekli";
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
	const [lineage, setLineage] = useState<LineageProjection | null>(null);
	const [lineageFailure, setLineageFailure] = useState<string | null>(null);
	const [nodes, setNodes] = useState<ReadonlyArray<SessionCanvasNode>>([]);
	const [edges, setEdges] = useState<ReadonlyArray<SessionRelationshipEdge>>([]);
	const [paneSelection, setPaneSelection] = useState<PaneSelection>({_tag: "closed"});
	const [discovering, setDiscovering] = useState(false);
	const discoveryGeneration = useRef(0);
	const discoveryInFlight = useRef(false);
	const selectionGeneration = useRef(0);
	const ignoreSelectionChange = useRef(false);
	const selectedRef = useRef<DiscoveredSession | null>(null);
	const streamCursor = useRef<StreamCursor | null>(null);
	const selected = paneSelection._tag === "open" ? paneSelection.selected : null;
	const view = discoveryView(outcome);
	const lineageProblems = lineage?.problems ?? [];

	const updatePaneForSelection = useCallback(
		(identity: string, generation: number, update: PaneUpdate): void => {
			setPaneSelection((current) => {
				if (
					current._tag !== "open" ||
					current.selected.identity !== identity ||
					current.generation !== generation
				) {
					return current;
				}
				const pane = typeof update === "function" ? update(current.pane) : update;
				return {...current, pane};
			});
		},
		[],
	);

	useEffect(() => {
		if (lineage === null) return;
		setNodes((current) =>
			reconcileSessionNodes(current, lineage).map((node) => ({
				...node,
				selected: node.id === selected?.identity,
			})),
		);
		setEdges((current) => reconcileLineageEdges(current, lineage));
	}, [lineage, selected]);

	const applyDiscovery = useCallback(
		async (next: DiscoveryOutcome, generation: number): Promise<void> => {
			if (generation !== discoveryGeneration.current) return;
			const target = selectedRef.current;
			const targetGeneration = selectionGeneration.current;
			if (
				target === null ||
				sessionsOf(next).some((session) => session.identity === target.identity)
			) {
				setOutcome(next);
				return;
			}

			const isCurrentTarget = (): boolean =>
				generation === discoveryGeneration.current &&
				targetGeneration === selectionGeneration.current &&
				selectedRef.current?.identity === target.identity;

			try {
				await releaseLiveSession();
			} catch (error) {
				if (!isCurrentTarget()) return;
				updatePaneForSelection(target.identity, targetGeneration, (current) => ({
					...current,
					connection: "disconnected",
					message:
						error instanceof Error
							? error.message
							: "Oturum sahipliği bırakılamadı; sohbet açık tutuluyor.",
				}));
				return;
			}

			if (!isCurrentTarget()) return;
			ignoreSelectionChange.current = true;
			selectionGeneration.current += 1;
			selectedRef.current = null;
			streamCursor.current = null;
			setNodes((current) => current.map((node) => ({...node, selected: false})));
			setPaneSelection({_tag: "closed"});
			setOutcome(next);
			requestAnimationFrame(() => {
				document.querySelector<HTMLElement>("#canvas")?.focus();
			});
		},
		[updatePaneForSelection],
	);

	const discover = useCallback(async (): Promise<void> => {
		if (discoveryInFlight.current) return;
		discoveryInFlight.current = true;
		setDiscovering(true);
		const generation = ++discoveryGeneration.current;
		const discoveryResult = await discoverSessions().then(
			(value) => ({status: "fulfilled", value}) as const,
			(reason: unknown) => ({status: "rejected", reason}) as const,
		);
		const lineageResult = await readLineage().then(
			(value) => ({status: "fulfilled", value}) as const,
			(reason: unknown) => ({status: "rejected", reason}) as const,
		);
		try {
			await applyDiscovery(
				discoveryResult.status === "fulfilled"
					? discoveryResult.value
					: {
							_tag: "transport",
							message:
								discoveryResult.reason instanceof Error
									? discoveryResult.reason.message
									: String(discoveryResult.reason),
							retryable: true,
						},
				generation,
			);
			if (generation !== discoveryGeneration.current) return;
			if (lineageResult.status === "fulfilled") {
				setLineage(lineageResult.value);
				setLineageFailure(null);
			} else {
				setLineageFailure(
					lineageResult.reason instanceof Error
						? lineageResult.reason.message
						: String(lineageResult.reason),
				);
			}
			requestAnimationFrame(() => {
				ignoreSelectionChange.current = false;
			});
		} finally {
			discoveryInFlight.current = false;
			setDiscovering(false);
		}
	}, [applyDiscovery]);

	useEffect(() => void discover(), [discover]);

	useEffect(() => {
		if (selected === null) return;
		const targetGeneration = selectionGeneration.current;
		let active = true;
		let eventSource: EventSource | undefined;
		let lastSequence = 0;
		const setCurrentPane = (update: PaneUpdate): void =>
			updatePaneForSelection(selected.identity, targetGeneration, update);
		const advanceCursor = (sequence: number, revision?: number): void => {
			const current = streamCursor.current;
			if (current?.sessionId !== selected.piSessionId || current.generation !== targetGeneration) {
				return;
			}
			streamCursor.current = {
				...current,
				sequence: Math.max(current.sequence, sequence),
				revision: revision === undefined ? current.revision : Math.max(current.revision, revision),
			};
		};
		setCurrentPane(pendingPane());

		void attachLiveSession(selected.piSessionId)
			.then((attached) => {
				if (!active) return;
				if (attached._tag === "refused") {
					setCurrentPane({
						connection: attached.code === "disconnected" ? "disconnected" : "refused",
						session: null,
						message: attached.reason,
					});
					return;
				}
				lastSequence = attached.session.lastEventSequence;
				streamCursor.current = {
					sessionId: selected.piSessionId,
					generation: targetGeneration,
					sequence: lastSequence,
					revision: attached.session.revision,
				};
				setCurrentPane({connection: "attached", session: attached.session});
				eventSource = new EventSource(`/fate/live?afterSequence=${lastSequence}`);
				eventSource.onopen = () => {
					if (!active) return;
					setCurrentPane((current) =>
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
						setCurrentPane((current) => ({
							...current,
							connection: "malformed",
							message: "Canlı akış geçerli JSON taşımadı.",
						}));
						eventSource?.close();
						return;
					}
					const event = decodeLiveEvent(raw);
					if (event === undefined) {
						setCurrentPane((current) => ({
							...current,
							connection: "malformed",
							message: "Canlı akış olayı doğrulanamadı.",
						}));
						eventSource?.close();
						return;
					}
					if (event.sequence <= lastSequence) return;
					lastSequence = event.sequence;
					advanceCursor(event.sequence);
					if (event._tag === "session" && event.session.sessionId === selected.piSessionId) {
						advanceCursor(event.sequence, event.session.revision);
						setCurrentPane({
							connection: event.session._tag === "attached" ? "attached" : "disconnected",
							session: event.session,
							...(event.session._tag === "disconnected" ? {message: event.session.reason} : {}),
						});
					} else if (
						event._tag === "prompt" &&
						event.outcome._tag === "acknowledged" &&
						event.outcome.session.sessionId === selected.piSessionId
					) {
						advanceCursor(event.sequence, event.outcome.session.revision);
						setCurrentPane({connection: "attached", session: event.outcome.session});
					} else if (event._tag === "released" && event.sessionId === selected.piSessionId) {
						setCurrentPane((current) => ({
							...current,
							connection: "disconnected",
							message: "Oturum sahipliği bırakıldı.",
						}));
					} else if (
						event._tag === "diagnostic" &&
						(event.sessionId === null || event.sessionId === selected.piSessionId)
					) {
						setCurrentPane((current) => ({
							...current,
							connection: "malformed",
							message: event.message,
						}));
					}
				};
				eventSource.onerror = () => {
					if (!active) return;
					setCurrentPane((current) => ({
						...current,
						connection: "disconnected",
						message: "Canlı olay bağlantısı kesildi; yeniden bağlanma bekleniyor.",
					}));
				};
			})
			.catch((error) => {
				if (!active) return;
				setCurrentPane({
					connection: "disconnected",
					session: null,
					message: error instanceof Error ? error.message : "Oturuma bağlanılamadı.",
				});
			});

		return () => {
			active = false;
			eventSource?.close();
			const cursor = streamCursor.current;
			if (cursor?.sessionId === selected.piSessionId && cursor.generation === targetGeneration) {
				streamCursor.current = null;
			}
		};
	}, [selected, updatePaneForSelection]);

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
		selectionGeneration.current += 1;
		selectedRef.current = null;
		streamCursor.current = null;
		setNodes((current) => current.map((node) => ({...node, selected: false})));
		setPaneSelection({_tag: "closed"});
		void releaseLiveSession().catch(() => undefined);
		requestAnimationFrame(() => {
			ignoreSelectionChange.current = false;
			focusCanvasNode(identity);
		});
	};

	const sendPrompt = async (text: string): Promise<SendResult> => {
		const target = selectedRef.current;
		const targetGeneration = selectionGeneration.current;
		if (target === null) return {ok: false, message: "Açık bir oturum yok."};
		const isCurrentTarget = (): boolean =>
			targetGeneration === selectionGeneration.current &&
			selectedRef.current?.identity === target.identity;
		try {
			const correlationId = crypto.randomUUID();
			const response = await promptLiveSession(target.piSessionId, correlationId, text);
			if (!isCurrentTarget()) {
				return {ok: false, message: "İleti gönderilirken başka bir oturuma geçildi."};
			}
			if (response._tag === "acknowledged") {
				const cursor = streamCursor.current;
				if (
					cursor?.sessionId === target.piSessionId &&
					cursor.generation === targetGeneration &&
					response.session.lastEventSequence >= cursor.sequence &&
					response.session.revision >= cursor.revision
				) {
					streamCursor.current = {
						...cursor,
						sequence: response.session.lastEventSequence,
						revision: response.session.revision,
					};
					updatePaneForSelection(target.identity, targetGeneration, {
						connection: "attached",
						session: response.session,
					});
				}
				return {ok: true, message: "İleti pi tarafından onaylandı."};
			}
			if (response.code === "lease-refused") {
				updatePaneForSelection(target.identity, targetGeneration, (current) => ({
					...current,
					connection: "refused",
					message: response.reason,
				}));
			} else if (response.code === "disconnected") {
				updatePaneForSelection(target.identity, targetGeneration, (current) => ({
					...current,
					connection: "disconnected",
					message: response.reason,
				}));
			}
			return {ok: false, message: response.reason};
		} catch (error) {
			if (!isCurrentTarget()) {
				return {ok: false, message: "İleti gönderilirken başka bir oturuma geçildi."};
			}
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
				<Button
					id="refresh-sessions"
					variant="secondary"
					type="button"
					disabled={discovering}
					onClick={() => void discover()}
				>
					Oturumları yenile
				</Button>
			</header>

			<main className="workspace" aria-label="Tuval oturum çalışma alanı">
				<section
					id="canvas"
					className="canvas"
					aria-label="Serbest kaydırılabilir oturum tuvali"
					tabIndex={-1}
				>
					<div id="canvas-stage" className="canvas-stage">
						<SessionCanvas
							nodes={nodes}
							edges={edges}
							onNodesChange={onNodesChange}
							onEdgesChange={onEdgesChange}
							onSelect={(lineageSession) => {
								if (ignoreSelectionChange.current) return;
								const session =
									lineageSession === null ? null : discoveredSessionFrom(lineageSession);
								const current = selectedRef.current;
								if (session?.identity === current?.identity) return;
								if (session === null && current !== null) {
									void releaseLiveSession().catch(() => undefined);
								}
								const generation = selectionGeneration.current + 1;
								selectionGeneration.current = generation;
								selectedRef.current = session;
								streamCursor.current = null;
								setPaneSelection(
									session === null
										? {_tag: "closed"}
										: {_tag: "open", selected: session, generation, pane: pendingPane()},
								);
							}}
						/>
					</div>

					{lineageFailure === null && lineageProblems.length === 0 ? null : (
						<Card as="section" className="lineage-problems" role="status" aria-live="polite">
							<p className="lineage-problems__eyebrow">Oturum bağları</p>
							<h2>Bilinen geçmiş korunuyor</h2>
							<p>Yeni bağların bazıları katılamadı; kayıtlı oturumlar tuvalde kalır.</p>
							<ul>
								{lineageFailure === null ? null : (
									<li>
										<strong>Çakışan veya okunamayan bağ verisi</strong>
										<span>{lineageFailure}</span>
									</li>
								)}
								{lineageProblems.map((problem, index) => (
									<li key={`${problem.code}:${problem.source}:${index}`}>
										<strong>{lineageProblemLabel(problem)}</strong>
										<span>{problem.message}</span>
									</li>
								))}
							</ul>
						</Card>
					)}

					{view.state === undefined ? null : (
						<Surface
							as="section"
							id="discovery-state"
							className="state-panel"
							data-tone={view.tone}
							aria-labelledby="state-title"
							tone="default"
							elevation="overlay"
							radius="lg"
							padding="lg"
							border
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
							<Button
								id="state-action"
								variant="primary"
								type="button"
								disabled={discovering}
								onClick={() => void discover()}
							>
								{view.state.action}
							</Button>
						</Surface>
					)}

					<p className="canvas-help">
						Sürükleyerek kaydır · tekerlekle yakınlaştır · <kbd>Tab</kbd> ile oturumlara geç
					</p>
				</section>

				{paneSelection._tag === "closed" ? null : (
					<ChatPane
						key={`${paneSelection.selected.identity}:${paneSelection.generation}`}
						selected={paneSelection.selected}
						connection={paneSelection.pane.connection}
						session={paneSelection.pane.session}
						{...(paneSelection.pane.message === undefined
							? {}
							: {message: paneSelection.pane.message})}
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
