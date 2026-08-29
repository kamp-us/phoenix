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
import {ToggleGroup} from "../../../../apps/web/src/components/ui/ToggleGroup.js";
import type {DiscoveredSession, DiscoveryOutcome, DiscoveryProblem} from "../shared/discovery.js";
import type {LineageNode, LineageProblem, LineageProjection} from "../shared/lineage.js";
import type {
	ControlLiveSessionOutcome,
	LiveSessionView,
	ModelRef,
	ThinkingLevel,
} from "../shared/live-session.js";
import type {RestorationSnapshot} from "../shared/resilience.js";
import {
	reconcileLineageEdges,
	reconcileSessionNodes,
	type SessionCanvasNode,
	type SessionRelationshipEdge,
} from "./canvas-adapter.js";
import {ChatPane, type PaneConnection, type SendResult} from "./chat-pane.js";
import {ContributionStatus, useContributions} from "./contributions.js";
import {ExtensionUIBridge} from "./extension-ui-bridge.js";
import {
	abortLiveSession,
	attachLiveSession,
	createLiveSession,
	decodeLiveEvent,
	discoverSessions,
	openLiveSession,
	promptLiveSession,
	readLineage,
	releaseLiveSession,
	setModelLiveSession,
	setThinkingLiveSession,
	steerLiveSession,
} from "./fate-client.js";
import {
	decodeNodeDetailLevel,
	NODE_DETAIL_LEVELS,
	type NodeDetailLevel,
	readStoredNodeDetailLevel,
	writeStoredNodeDetailLevel,
} from "./node-detail.js";
import {readRestorationSnapshot} from "./resilience-client.js";
import {RestorationStatus, type SelectionRestoration} from "./restoration-status.js";
import {SessionCanvas} from "./session-canvas.js";
import {SessionLaunchControls} from "./session-launch-controls.js";
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

type SelectionHydration =
	| {readonly _tag: "awaiting-graph"}
	| {readonly _tag: "applying-restored-selection"; readonly identity: string}
	| {readonly _tag: "active"};

interface StreamCursor {
	readonly sessionId: string;
	readonly generation: number;
	readonly sequence: number;
	readonly revision: number;
}

const pendingPane = (): PaneState => ({connection: "pending", session: null});

const browserStorage = (): Storage | undefined => {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return undefined;
	}
};

const nodeDetailLabels: Readonly<Record<NodeDetailLevel, string>> = {
	bare: "Sade",
	meta: "Meta",
	live: "Canlı",
	full: "Tam",
};

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

const knownSessionsProjection = (
	sessions: ReadonlyArray<DiscoveredSession>,
): LineageProjection => ({
	graph: {
		version: 2,
		nodes: [...new Map(sessions.map((session) => [session.identity, session])).values()].map(
			(session) => ({
				id: session.identity,
				piSessionId: session.piSessionId,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				cwd: session.cwd,
				sourceFiles: [session.sourceFile],
			}),
		),
		edges: [],
		continuity: [],
		ownership: [],
	},
	problems: [],
});

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
		requestAnimationFrame(() => {
			for (const element of document.querySelectorAll<HTMLElement>(".react-flow__node")) {
				if (element.dataset.id === identity) {
					element.focus();
					break;
				}
			}
		});
	});
};

export function TuvalApp() {
	const contributions = useContributions();
	const [detailLevel, setDetailLevelState] = useState<NodeDetailLevel>(() =>
		readStoredNodeDetailLevel(browserStorage()),
	);
	const [outcome, setOutcome] = useState<DiscoveryOutcome | null>(null);
	const [lineage, setLineage] = useState<LineageProjection | null>(null);
	const [lineageFailure, setLineageFailure] = useState<string | null>(null);
	const [restoration, setRestoration] = useState<RestorationSnapshot | null>(null);
	const [restorationFailure, setRestorationFailure] = useState<string | null>(null);
	const [selectionRestoration, setSelectionRestoration] = useState<SelectionRestoration>({
		_tag: "idle",
	});
	const [nodes, setNodes] = useState<ReadonlyArray<SessionCanvasNode>>([]);
	const [edges, setEdges] = useState<ReadonlyArray<SessionRelationshipEdge>>([]);
	const [paneSelection, setPaneSelection] = useState<PaneSelection>({_tag: "closed"});
	const [mobileLayer, setMobileLayer] = useState<"canvas" | "chat" | "extensions">("canvas");
	const [discovering, setDiscovering] = useState(false);
	const [streamCycle, setStreamCycle] = useState(0);
	const discoveryGeneration = useRef(0);
	const discoveryInFlight = useRef(false);
	const selectionGeneration = useRef(0);
	const restorationAttempted = useRef(false);
	const selectionHydration = useRef<SelectionHydration>({_tag: "awaiting-graph"});
	const ignoreSelectionChange = useRef(false);
	const selectedRef = useRef<DiscoveredSession | null>(null);
	const streamCursor = useRef<StreamCursor | null>(null);
	const reconnectState = useRef({identity: "", attempts: 0, recovering: false});
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
		const attachments =
			paneSelection._tag === "open" && paneSelection.pane.session !== null
				? new Map([[paneSelection.selected.identity, paneSelection.pane]])
				: undefined;
		setNodes((current) =>
			reconcileSessionNodes(current, lineage, {
				detailLevel,
				...(attachments === undefined ? {} : {attachments}),
			}).map((node) => ({
				...node,
				selected: node.id === selected?.identity,
			})),
		);
		setEdges((current) => reconcileLineageEdges(current, lineage));
	}, [detailLevel, lineage, paneSelection, selected]);

	const setDetailLevel = (next: NodeDetailLevel): void => {
		writeStoredNodeDetailLevel(browserStorage(), next);
		setDetailLevelState(next);
	};

	useEffect(() => {
		if (restoration === null) return;
		const restoredDetail = decodeNodeDetailLevel(restoration.settings.nodeDetailLevel);
		if (restoredDetail !== undefined) {
			writeStoredNodeDetailLevel(browserStorage(), restoredDetail);
			setDetailLevelState(restoredDetail);
		}
		const density = restoration.settings.density;
		if (density === "compact" || density === "normal" || density === "spacious") {
			document.documentElement.dataset.density = density;
		}
		const theme = restoration.settings.theme;
		if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
	}, [restoration]);

	const openSession = useCallback((session: DiscoveredSession): void => {
		const current = selectedRef.current;
		if (session.identity === current?.identity) return;
		const generation = selectionGeneration.current + 1;
		selectionGeneration.current = generation;
		selectedRef.current = session;
		streamCursor.current = null;
		reconnectState.current = {identity: session.identity, attempts: 0, recovering: false};
		setPaneSelection({_tag: "open", selected: session, generation, pane: pendingPane()});
		setMobileLayer("chat");
		setNodes((currentNodes) =>
			currentNodes.map((node) => ({...node, selected: node.id === session.identity})),
		);
	}, []);

	const clearUnavailableSelection = useCallback((identity?: string): void => {
		if (identity !== undefined && selectedRef.current?.identity !== identity) return;
		selectionGeneration.current += 1;
		selectedRef.current = null;
		streamCursor.current = null;
		setNodes((current) => current.map((node) => ({...node, selected: false})));
		setPaneSelection({_tag: "closed"});
		setMobileLayer("canvas");
		requestAnimationFrame(() => document.querySelector<HTMLElement>("#canvas")?.focus());
	}, []);

	useEffect(() => {
		let active = true;
		void readRestorationSnapshot().then(
			(snapshot) => {
				if (!active) return;
				setRestoration(snapshot);
				setRestorationFailure(null);
			},
			(error: unknown) => {
				if (!active) return;
				setRestorationFailure(
					error instanceof Error ? error.message : "Geri yükleme özeti okunamadı.",
				);
			},
		);
		return () => {
			active = false;
		};
	}, []);

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
			setMobileLayer("canvas");
			setSelectionRestoration({
				_tag: "unavailable",
				sessionId: target.piSessionId,
				reason: "Önceki oturum artık keşif sonucunda bulunmuyor.",
			});
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
			const discoveryOutcome: DiscoveryOutcome =
				discoveryResult.status === "fulfilled"
					? discoveryResult.value
					: {
							_tag: "transport",
							message:
								discoveryResult.reason instanceof Error
									? discoveryResult.reason.message
									: String(discoveryResult.reason),
							retryable: true,
						};
			await applyDiscovery(discoveryOutcome, generation);
			if (generation !== discoveryGeneration.current) return;
			if (lineageResult.status === "fulfilled") {
				setLineage(lineageResult.value);
				setLineageFailure(null);
			} else {
				setLineage((current) => current ?? knownSessionsProjection(sessionsOf(discoveryOutcome)));
				setLineageFailure(
					lineageResult.reason instanceof Error
						? lineageResult.reason.message
						: String(lineageResult.reason),
				);
			}
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					ignoreSelectionChange.current = false;
				});
			});
		} finally {
			discoveryInFlight.current = false;
			setDiscovering(false);
		}
	}, [applyDiscovery]);

	useEffect(() => void discover(), [discover]);

	useEffect(() => {
		if (
			restorationAttempted.current ||
			restoration === null ||
			outcome === null ||
			lineage === null
		) {
			return;
		}
		const restoredSessionId = restoration.selectedSessionId;
		const unavailableDiagnostic = restoration.diagnostics.find(
			({code}) =>
				code === "selected-session-unavailable" ||
				code === "selected-lease-unavailable" ||
				code === "selected-session-state-invalid",
		);
		const available = sessionsOf(outcome);
		if (restoredSessionId === null) {
			const fallback =
				unavailableDiagnostic === undefined
					? undefined
					: available.find(({piSessionId}) => piSessionId !== unavailableDiagnostic.sessionId);
			if (fallback !== undefined && !nodes.some(({id}) => id === fallback.identity)) return;
			restorationAttempted.current = true;
			selectionHydration.current = {_tag: "active"};
			if (unavailableDiagnostic !== undefined) {
				setSelectionRestoration({
					_tag: "unavailable",
					sessionId: unavailableDiagnostic.sessionId ?? null,
					reason: unavailableDiagnostic.message,
				});
				if (fallback === undefined) {
					requestAnimationFrame(() => document.querySelector<HTMLElement>("#canvas")?.focus());
				} else {
					focusCanvasNode(fallback.identity);
				}
			}
			return;
		}
		const restoredSession = available.find(({piSessionId}) => piSessionId === restoredSessionId);
		if (restoredSession === undefined) {
			const fallback = available.at(0);
			if (fallback !== undefined && !nodes.some(({id}) => id === fallback.identity)) return;
			restorationAttempted.current = true;
			selectionHydration.current = {_tag: "active"};
			setSelectionRestoration({
				_tag: "unavailable",
				sessionId: restoredSessionId,
				reason: "Kalıcı seçim artık kullanılabilir oturumlar arasında değil.",
			});
			if (fallback === undefined) {
				requestAnimationFrame(() => document.querySelector<HTMLElement>("#canvas")?.focus());
			} else {
				focusCanvasNode(fallback.identity);
			}
			return;
		}
		if (!nodes.some(({id}) => id === restoredSession.identity)) return;
		restorationAttempted.current = true;
		selectionHydration.current = {
			_tag: "applying-restored-selection",
			identity: restoredSession.identity,
		};
		setSelectionRestoration({_tag: "restored", sessionId: restoredSessionId});
		openSession(restoredSession);
	}, [lineage, nodes, openSession, outcome, restoration]);

	useEffect(() => {
		if (selected === null) return;
		const targetGeneration = selectionGeneration.current;
		let active = true;
		let eventSource: EventSource | undefined;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let lastSequence = 0;
		if (reconnectState.current.identity !== selected.identity) {
			reconnectState.current = {identity: selected.identity, attempts: 0, recovering: false};
		}
		const setCurrentPane = (update: PaneUpdate): void =>
			updatePaneForSelection(selected.identity, targetGeneration, update);
		const scheduleReconnect = (message?: string): void => {
			if (!active) return;
			eventSource?.close();
			eventSource = undefined;
			const reconnect = reconnectState.current;
			if (reconnect.attempts >= 3) {
				setCurrentPane((current) => ({
					...current,
					connection: "stopped",
					message:
						message ??
						"Üç yeniden bağlanma denemesi tamamlandı. Elle yeniden dene veya ağ bağlantısını geri getir.",
				}));
				return;
			}
			reconnect.attempts += 1;
			reconnect.recovering = true;
			setCurrentPane((current) => ({
				...current,
				connection: "reconnecting",
				message: `Canlı bağlantı yenileniyor · ${reconnect.attempts}/3. Son doğrulanmış görünüm korunuyor.`,
			}));
			const delay = [250, 500, 1_000][reconnect.attempts - 1] ?? 1_000;
			reconnectTimer = setTimeout(() => setStreamCycle((current) => current + 1), delay);
		};
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
		if (!reconnectState.current.recovering) setCurrentPane(pendingPane());

		void attachLiveSession(selected.piSessionId)
			.then((attached) => {
				if (!active) return;
				if (attached._tag === "refused") {
					setCurrentPane({
						connection: attached.code === "disconnected" ? "disconnected" : "refused",
						session: null,
						message: attached.reason,
					});
					setSelectionRestoration({
						_tag: "unavailable",
						sessionId: selected.piSessionId,
						reason:
							attached.code === "lease-refused"
								? "Kalıcı oturum başka bir çalışma alanında açık."
								: attached.reason,
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
					const recovered = reconnectState.current.recovering;
					reconnectState.current.attempts = 0;
					reconnectState.current.recovering = false;
					setCurrentPane((current) =>
						current.session?._tag === "attached"
							? {
									connection: "attached",
									session: current.session,
									...(recovered
										? {message: "Canlı bağlantı yenilendi; çalışma alanı doğrulandı."}
										: {}),
								}
							: current,
					);
					if (recovered) void discover();
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
					} else if (
						event._tag === "control" &&
						event.outcome._tag === "acknowledged" &&
						event.outcome.session.sessionId === selected.piSessionId
					) {
						advanceCursor(event.sequence, event.outcome.session.revision);
						setCurrentPane({connection: "attached", session: event.outcome.session});
					} else if (
						event._tag === "control" &&
						event.outcome._tag === "refused" &&
						event.outcome.session?.sessionId === selected.piSessionId
					) {
						const refusal = event.outcome;
						const observed = refusal.session;
						if (observed === null) return;
						advanceCursor(event.sequence, observed.revision);
						setCurrentPane((current) => ({
							...current,
							session: observed,
							...(refusal.code === "disconnected"
								? {connection: "disconnected" as const, message: refusal.reason}
								: {}),
						}));
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
				eventSource.onerror = () => scheduleReconnect();
			})
			.catch((error) => {
				if (!active) return;
				scheduleReconnect(error instanceof Error ? error.message : "Oturuma bağlanılamadı.");
			});

		return () => {
			active = false;
			if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
			eventSource?.close();
			const cursor = streamCursor.current;
			if (cursor?.sessionId === selected.piSessionId && cursor.generation === targetGeneration) {
				streamCursor.current = null;
			}
		};
	}, [clearUnavailableSelection, discover, selected, streamCycle, updatePaneForSelection]);

	const rearmReconnect = useCallback((): void => {
		const current = selectedRef.current;
		if (current === null) return;
		reconnectState.current = {identity: current.identity, attempts: 0, recovering: true};
		setStreamCycle((cycle) => cycle + 1);
	}, []);

	useEffect(() => {
		if (paneSelection._tag !== "open" || paneSelection.pane.connection !== "stopped") return;
		window.addEventListener("online", rearmReconnect, {once: true});
		return () => window.removeEventListener("online", rearmReconnect);
	}, [paneSelection, rearmReconnect]);

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
		setMobileLayer("canvas");
		setSelectionRestoration({_tag: "idle"});
		void releaseLiveSession().catch(() => undefined);
		requestAnimationFrame(() => {
			ignoreSelectionChange.current = false;
			if (document.activeElement === document.body) focusCanvasNode(identity);
		});
	};

	useEffect(() => {
		if (selected === null) return;
		const onEscape = (event: KeyboardEvent): void => {
			if (
				event.key !== "Escape" ||
				document.querySelector('[role="dialog"]') !== null ||
				(event.target instanceof HTMLElement && event.target.closest(".react-flow__node") !== null)
			) {
				return;
			}
			const workspace = document.querySelector<HTMLElement>(".workspace");
			if (
				window.matchMedia("(max-width: 720px)").matches &&
				workspace?.dataset.mobileLayer !== "canvas"
			) {
				return;
			}
			setTimeout(closePane, 0);
		};
		document.addEventListener("keydown", onEscape, {capture: true});
		return () => document.removeEventListener("keydown", onEscape, {capture: true});
	}, [selected]);

	const acceptReplacement = (
		controlOutcome: ControlLiveSessionOutcome,
		cwdHint: string,
	): ControlLiveSessionOutcome => {
		if (controlOutcome._tag !== "acknowledged") return controlOutcome;
		const now = Date.now();
		const discovered: DiscoveredSession = {
			identity: `pi:${controlOutcome.session.sessionId}` as DiscoveredSession["identity"],
			piSessionId: controlOutcome.session.sessionId,
			createdAt: now,
			updatedAt: now,
			cwd: cwdHint,
			sourceFile: "",
		};
		const prior = sessionsOf(outcome).find(
			(session) => session.piSessionId === discovered.piSessionId,
		);
		const stable = prior === undefined ? discovered : {...discovered, ...prior};
		const generation = selectionGeneration.current + 1;
		ignoreSelectionChange.current = true;
		selectionGeneration.current = generation;
		selectedRef.current = stable;
		streamCursor.current = {
			sessionId: stable.piSessionId,
			generation,
			sequence: controlOutcome.session.lastEventSequence,
			revision: controlOutcome.session.revision,
		};
		setPaneSelection({
			_tag: "open",
			selected: stable,
			generation,
			pane: {connection: "attached", session: controlOutcome.session},
		});
		setNodes((current) =>
			current.map((node) => ({...node, selected: node.id === stable.identity})),
		);
		setOutcome((current) => {
			const sessions = sessionsOf(current);
			const next = [
				...sessions.filter((session) => session.piSessionId !== stable.piSessionId),
				stable,
			];
			return current?._tag === "partial-source"
				? {...current, sessions: next}
				: {_tag: "ready", sessions: next};
		});
		setLineage((current) => {
			if (current === null) return knownSessionsProjection([stable]);
			if (current.graph.nodes.some((node) => node.piSessionId === stable.piSessionId)) {
				return current;
			}
			return {
				...current,
				graph: {
					...current.graph,
					nodes: [
						...current.graph.nodes,
						{
							id: stable.identity,
							piSessionId: stable.piSessionId,
							createdAt: stable.createdAt,
							updatedAt: stable.updatedAt,
							cwd: stable.cwd,
							sourceFiles: stable.sourceFile === "" ? [] : [stable.sourceFile],
						},
					],
				},
			};
		});
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				ignoreSelectionChange.current = false;
			});
		});
		return controlOutcome;
	};

	const runSelectedControl = async (
		request: (correlationId: string, sessionId: string) => Promise<ControlLiveSessionOutcome>,
	): Promise<ControlLiveSessionOutcome> => {
		const target = selectedRef.current;
		const targetGeneration = selectionGeneration.current;
		if (target === null) {
			return {
				_tag: "refused",
				command: "steer",
				correlationId: "missing-selection",
				code: "ownership-refused",
				reason: "Açık bir oturum yok.",
				session: null,
			};
		}
		const outcome = await request(crypto.randomUUID(), target.piSessionId);
		if (
			targetGeneration !== selectionGeneration.current ||
			selectedRef.current?.identity !== target.identity
		) {
			return {
				_tag: "refused",
				command: outcome.command,
				correlationId: outcome.correlationId,
				code: "ownership-refused",
				reason: "Denetim sürerken başka bir oturuma geçildi.",
				session: null,
			};
		}
		const observed = outcome._tag === "acknowledged" ? outcome.session : outcome.session;
		if (observed !== null) {
			const cursor = streamCursor.current;
			if (
				cursor?.sessionId === target.piSessionId &&
				cursor.generation === targetGeneration &&
				observed.lastEventSequence >= cursor.sequence &&
				observed.revision >= cursor.revision
			) {
				streamCursor.current = {
					...cursor,
					sequence: observed.lastEventSequence,
					revision: observed.revision,
				};
				updatePaneForSelection(target.identity, targetGeneration, (current) => ({
					...current,
					session: observed,
					...(outcome._tag === "refused" && outcome.code === "disconnected"
						? {connection: "disconnected" as const, message: outcome.reason}
						: {}),
				}));
			}
		}
		return outcome;
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
				<div className="detail-setting">
					<span id="detail-setting-label">Oturum ayrıntısı</span>
					<ToggleGroup
						aria-labelledby="detail-setting-label"
						className="kp-toggle-group kp-toggle-group--segmented"
						size="sm"
						value={[detailLevel]}
						onValueChange={(next) => {
							const selectedLevel = next.at(-1);
							if (
								selectedLevel !== undefined &&
								NODE_DETAIL_LEVELS.includes(selectedLevel as NodeDetailLevel)
							) {
								setDetailLevel(selectedLevel as NodeDetailLevel);
							}
						}}
						items={NODE_DETAIL_LEVELS.map((level) => ({
							value: level,
							label: nodeDetailLabels[level],
						}))}
					/>
				</div>
				<Button
					id="refresh-sessions"
					variant="secondary"
					type="button"
					disabled={discovering}
					onClick={() => {
						void discover();
						void contributions.reload();
					}}
				>
					Oturumları yenile
				</Button>
			</header>

			<main
				className="workspace"
				aria-label="Tuval oturum çalışma alanı"
				data-mobile-layer={mobileLayer}
				onKeyDown={(event) => {
					if (event.defaultPrevented) return;
					if (event.key === "Escape" && mobileLayer !== "canvas") {
						event.preventDefault();
						setMobileLayer("canvas");
						requestAnimationFrame(() =>
							document.querySelector<HTMLElement>("#mobile-layer-canvas")?.focus(),
						);
						return;
					}
					if (
						event.key !== "Tab" ||
						mobileLayer === "canvas" ||
						!window.matchMedia("(max-width: 720px)").matches
					) {
						return;
					}
					const focusable = [
						...event.currentTarget.querySelectorAll<HTMLElement>(
							`.mobile-workspace-nav button:not(:disabled), [data-mobile-panel="${mobileLayer}"] button:not(:disabled), [data-mobile-panel="${mobileLayer}"] input:not(:disabled), [data-mobile-panel="${mobileLayer}"] select:not(:disabled), [data-mobile-panel="${mobileLayer}"] [contenteditable="true"]`,
						),
					].filter((element) => element.getClientRects().length > 0);
					const first = focusable[0];
					const last = focusable.at(-1);
					if (first === undefined || last === undefined) return;
					if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first.focus();
					}
				}}
			>
				<nav className="mobile-workspace-nav" aria-label="Mobil çalışma alanı katmanları">
					<Button
						id="mobile-layer-canvas"
						type="button"
						variant={mobileLayer === "canvas" ? "primary" : "secondary"}
						aria-pressed={mobileLayer === "canvas"}
						onClick={() => setMobileLayer("canvas")}
					>
						Tuval
					</Button>
					<Button
						id="mobile-layer-chat"
						type="button"
						variant={mobileLayer === "chat" ? "primary" : "secondary"}
						aria-pressed={mobileLayer === "chat"}
						disabled={paneSelection._tag === "closed"}
						onClick={() => setMobileLayer("chat")}
					>
						Sohbet
					</Button>
					<Button
						id="mobile-layer-extensions"
						type="button"
						variant={mobileLayer === "extensions" ? "primary" : "secondary"}
						aria-pressed={mobileLayer === "extensions"}
						onClick={() => setMobileLayer("extensions")}
					>
						Extension UI
					</Button>
				</nav>
				<section
					id="canvas"
					data-mobile-panel="canvas"
					className="canvas"
					data-has-lineage-problems={
						lineageFailure !== null || lineageProblems.length > 0 ? "true" : "false"
					}
					aria-label="Serbest kaydırılabilir oturum tuvali"
					tabIndex={-1}
				>
					<div id="canvas-stage" className="canvas-stage">
						<SessionCanvas
							nodes={nodes}
							edges={edges}
							onNodesChange={onNodesChange}
							onEdgesChange={onEdgesChange}
							contributions={contributions.registry}
							onContributionFailure={contributions.reportFailure}
							onSelect={(lineageSession) => {
								if (ignoreSelectionChange.current) return;
								const session =
									lineageSession === null ? null : discoveredSessionFrom(lineageSession);
								const hydration = selectionHydration.current;
								if (hydration._tag === "awaiting-graph") {
									if (session === null) return;
									restorationAttempted.current = true;
									selectionHydration.current = {_tag: "active"};
								} else if (hydration._tag === "applying-restored-selection") {
									if (session?.identity !== hydration.identity) return;
									selectionHydration.current = {_tag: "active"};
								}
								const current = selectedRef.current;
								if (session?.identity === current?.identity) return;
								setSelectionRestoration({_tag: "idle"});
								if (session === null) {
									if (current !== null) void releaseLiveSession().catch(() => undefined);
									selectionGeneration.current += 1;
									selectedRef.current = null;
									streamCursor.current = null;
									setPaneSelection({_tag: "closed"});
								} else {
									openSession(session);
								}
							}}
						/>
					</div>

					<ContributionStatus state={contributions} />

					<RestorationStatus
						snapshot={restoration}
						failure={restorationFailure}
						selection={selectionRestoration}
						onUseFirstSession={() => {
							const refusedSessionId =
								selectionRestoration._tag === "unavailable" ? selectionRestoration.sessionId : null;
							const fallback = sessionsOf(outcome).find(
								({piSessionId}) => piSessionId !== refusedSessionId,
							);
							if (fallback === undefined) {
								clearUnavailableSelection();
								return;
							}
							setSelectionRestoration({_tag: "restored", sessionId: fallback.piSessionId});
							openSession(fallback);
						}}
					/>

					<SessionLaunchControls
						createAvailable={
							paneSelection._tag !== "open" ||
							paneSelection.pane.session?.controls?.create !== false
						}
						openAvailable={
							paneSelection._tag !== "open" || paneSelection.pane.session?.controls?.open !== false
						}
						onCreate={(cwd) =>
							createLiveSession(crypto.randomUUID(), cwd).then((result) =>
								acceptReplacement(result, cwd),
							)
						}
						onOpen={(sessionId) =>
							openLiveSession(crypto.randomUUID(), sessionId).then((result) => {
								const known = sessionsOf(outcome).find(
									(session) => session.piSessionId === sessionId,
								);
								return acceptReplacement(result, known?.cwd ?? `Oturum ${sessionId}`);
							})
						}
					/>

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
								onClick={() => {
									void discover();
									void contributions.reload();
								}}
							>
								{view.state.action}
							</Button>
						</Surface>
					)}

					<p className="canvas-help">
						Sürükleyerek kaydır · tekerlekle yakınlaştır · <kbd>Tab</kbd> ile oturumlara geç
					</p>
				</section>

				<div className="workspace-side-stack">
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
							onReconnect={rearmReconnect}
							onSend={sendPrompt}
							onSteer={(text) =>
								runSelectedControl((correlationId, sessionId) =>
									steerLiveSession(sessionId, correlationId, text),
								)
							}
							onAbort={() =>
								runSelectedControl((correlationId, sessionId) =>
									abortLiveSession(sessionId, correlationId),
								)
							}
							onSetModel={(model: ModelRef) =>
								runSelectedControl((correlationId, sessionId) =>
									setModelLiveSession(sessionId, correlationId, model),
								)
							}
							onSetThinking={(level: ThinkingLevel) =>
								runSelectedControl((correlationId, sessionId) =>
									setThinkingLiveSession(sessionId, correlationId, level),
								)
							}
						/>
					)}
					<ExtensionUIBridge initialSnapshots={restoration?.extensionUI ?? []} />
				</div>
			</main>
		</div>
	);
}

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Tuval root element is missing");
createRoot(root).render(<TuvalApp />);
