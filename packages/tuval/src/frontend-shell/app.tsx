import {
	applyEdgeChanges,
	applyNodeChanges,
	type OnEdgesChange,
	type OnNodesChange,
} from "@xyflow/react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import {Button} from "../../../../apps/web/src/components/ui/Button.js";
import {Surface} from "../../../../apps/web/src/components/ui/Card.js";
import type {DiscoveredSession, DiscoveryOutcome, DiscoveryProblem} from "../shared/discovery.js";
import type {LiveSessionView} from "../shared/live-session.js";
import {
	reconcileRelationshipEdges,
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
	const [discovering, setDiscovering] = useState(false);
	const discoveryGeneration = useRef(0);
	const discoveryInFlight = useRef(false);
	const selectionGeneration = useRef(0);
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
		setEdges((current) => reconcileRelationshipEdges(current, sessions));
	}, [selected, sessions]);

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
				setPane((current) => ({
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
			setSelected(null);
			setOutcome(next);
			requestAnimationFrame(() => {
				ignoreSelectionChange.current = false;
				document.querySelector<HTMLElement>("#canvas")?.focus();
			});
		},
		[],
	);

	const discover = useCallback(async (): Promise<void> => {
		if (discoveryInFlight.current) return;
		discoveryInFlight.current = true;
		setDiscovering(true);
		const generation = ++discoveryGeneration.current;
		try {
			await applyDiscovery(await discoverSessions(), generation);
		} catch (error) {
			await applyDiscovery(
				{
					_tag: "transport",
					message: error instanceof Error ? error.message : String(error),
					retryable: true,
				},
				generation,
			);
		} finally {
			discoveryInFlight.current = false;
			setDiscovering(false);
		}
	}, [applyDiscovery]);

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
		selectionGeneration.current += 1;
		selectedRef.current = null;
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
		const targetGeneration = selectionGeneration.current;
		if (target === null) return {ok: false, message: "Açık bir oturum yok."};
		const isCurrentTarget = (): boolean =>
			targetGeneration === selectionGeneration.current &&
			selectedRef.current?.identity === target.identity;
		try {
			const response = await promptLiveSession(crypto.randomUUID(), text);
			if (!isCurrentTarget()) {
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
							onSelect={(session) => {
								if (ignoreSelectionChange.current) return;
								const current = selectedRef.current;
								if (session?.identity === current?.identity) return;
								if (session === null && current !== null) {
									void releaseLiveSession().catch(() => undefined);
								}
								selectionGeneration.current += 1;
								selectedRef.current = session;
								setSelected(session);
							}}
						/>
					</div>

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

				{selected === null ? null : (
					<ChatPane
						key={`${selected.identity}:${selectionGeneration.current}`}
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
