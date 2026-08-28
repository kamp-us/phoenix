import type {DiscoveredSession, DiscoveryOutcome, DiscoveryProblem} from "../shared/discovery.js";

interface ViewTransform {
	readonly x: number;
	readonly y: number;
	readonly scale: number;
}

interface Point {
	readonly x: number;
	readonly y: number;
}

const requiredElement = <ElementType extends Element>(
	selector: string,
	guard: (element: Element) => element is ElementType,
): ElementType => {
	const element = document.querySelector(selector);
	if (element === null || !guard(element)) {
		throw new Error(`Tuval shell is missing ${selector}`);
	}
	return element;
};

const isHtmlElement = (element: Element): element is HTMLElement => element instanceof HTMLElement;
const isButton = (element: Element): element is HTMLButtonElement =>
	element instanceof HTMLButtonElement;

const canvas = requiredElement("#canvas", isHtmlElement);
const stage = requiredElement("#canvas-stage", isHtmlElement);
const nodeLayer = requiredElement("#session-nodes", isHtmlElement);
const statePanel = requiredElement("#discovery-state", isHtmlElement);
const stateEyebrow = requiredElement("#state-eyebrow", isHtmlElement);
const stateTitle = requiredElement("#state-title", isHtmlElement);
const stateDescription = requiredElement("#state-description", isHtmlElement);
const stateDetails = requiredElement("#state-details", isHtmlElement);
const stateAction = requiredElement("#state-action", isButton);
const statusBadge = requiredElement("#discovery-status", isHtmlElement);
const statusLabel = requiredElement("#status-label", isHtmlElement);
const statusDescription = requiredElement("#status-description", isHtmlElement);
const zoomOutput = requiredElement("#zoom-output", isHtmlElement);
const selection = requiredElement("#selection", isHtmlElement);
const selectionTitle = requiredElement("#selection-title", isHtmlElement);
const selectionPath = requiredElement("#selection-path", isHtmlElement);
const refreshButton = requiredElement("#refresh-sessions", isButton);
const zoomInButton = requiredElement("#zoom-in", isButton);
const zoomOutButton = requiredElement("#zoom-out", isButton);
const resetButton = requiredElement("#reset-view", isButton);

const nodes = new Map<string, HTMLButtonElement>();
let orderedIdentities: ReadonlyArray<string> = [];
let selectedIdentity: string | null = null;
let requestGeneration = 0;
let transform: ViewTransform = {x: 0, y: 0, scale: 1};
let drag:
	| {
			readonly pointerId: number;
			readonly origin: Point;
			readonly transform: ViewTransform;
	  }
	| undefined;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null;

const isProblem = (value: unknown): value is DiscoveryProblem =>
	isRecord(value) && typeof value.source === "string" && typeof value.message === "string";

const isSession = (value: unknown): value is DiscoveredSession =>
	isRecord(value) &&
	typeof value.identity === "string" &&
	typeof value.piSessionId === "string" &&
	typeof value.createdAt === "number" &&
	typeof value.updatedAt === "number" &&
	typeof value.cwd === "string" &&
	typeof value.sourceFile === "string" &&
	(value.parentSessionId === undefined || typeof value.parentSessionId === "string");

const decodeOutcome = (value: unknown): DiscoveryOutcome | undefined => {
	if (!isRecord(value) || typeof value._tag !== "string") return undefined;
	if (value._tag === "ready") {
		return Array.isArray(value.sessions) && value.sessions.every(isSession)
			? (value as DiscoveryOutcome)
			: undefined;
	}
	if (value._tag === "empty") {
		return Array.isArray(value.sessions) && value.sessions.length === 0
			? (value as DiscoveryOutcome)
			: undefined;
	}
	if (value._tag === "partial-source") {
		return Array.isArray(value.sessions) &&
			value.sessions.every(isSession) &&
			Array.isArray(value.problems) &&
			value.problems.every(isProblem)
			? (value as DiscoveryOutcome)
			: undefined;
	}
	if (value._tag === "transport") {
		return typeof value.message === "string" && typeof value.retryable === "boolean"
			? (value as DiscoveryOutcome)
			: undefined;
	}
	if (value._tag === "fatal") {
		return typeof value.message === "string" &&
			Array.isArray(value.problems) &&
			value.problems.every(isProblem)
			? (value as DiscoveryOutcome)
			: undefined;
	}
	return undefined;
};

const decodeFateEnvelope = (value: unknown): DiscoveryOutcome | undefined => {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.results)) return undefined;
	const result = value.results.find(
		(candidate) => isRecord(candidate) && candidate.id === "discovery",
	);
	return isRecord(result) && result.ok === true ? decodeOutcome(result.data) : undefined;
};

const basename = (path: string): string => {
	const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
	return parts.at(-1) ?? path;
};

const positionFor = (index: number): Point => {
	if (index === 0) return {x: 0, y: 0};
	const angle = (index * 137.5 * Math.PI) / 180;
	const ring = Math.floor(Math.sqrt(index)) * 280;
	return {
		x: Math.round((Math.cos(angle) * ring) / 4) * 4,
		y: Math.round((Math.sin(angle) * ring) / 4) * 4,
	};
};

const setTransform = (next: ViewTransform): void => {
	transform = {
		x: next.x,
		y: next.y,
		scale: Math.min(1.8, Math.max(0.55, next.scale)),
	};
	stage.style.setProperty("--canvas-x", `${transform.x}px`);
	stage.style.setProperty("--canvas-y", `${transform.y}px`);
	stage.style.setProperty("--canvas-scale", String(transform.scale));
	zoomOutput.textContent = `${Math.round(transform.scale * 100)}%`;
};

const resetView = (): void => setTransform({x: 0, y: 0, scale: 1});

const selectSession = (identity: string): void => {
	selectedIdentity = identity;
	for (const [candidate, node] of nodes) {
		node.setAttribute("aria-pressed", String(candidate === identity));
	}
	const node = nodes.get(identity);
	if (node === undefined) return;
	selectionTitle.textContent = node.dataset.sessionTitle ?? identity;
	selectionPath.textContent = node.dataset.sessionPath ?? "";
	selection.hidden = false;
};

const createText = (className: string): HTMLSpanElement => {
	const span = document.createElement("span");
	span.className = className;
	return span;
};

const updateNode = (node: HTMLButtonElement, session: DiscoveredSession): void => {
	const title = basename(session.cwd);
	node.dataset.sessionTitle = title;
	node.dataset.sessionPath = session.cwd;
	node.setAttribute("aria-label", `Session ${title}, ${session.piSessionId}`);
	const titleElement = node.querySelector<HTMLElement>(".session-node__title");
	const idElement = node.querySelector<HTMLElement>(".session-node__id");
	const pathElement = node.querySelector<HTMLElement>(".session-node__path");
	const relationElement = node.querySelector<HTMLElement>(".session-node__relation");
	if (
		titleElement === null ||
		idElement === null ||
		pathElement === null ||
		relationElement === null
	) {
		throw new Error(`Session node ${session.identity} has an invalid structure`);
	}
	titleElement.textContent = title;
	idElement.textContent = session.piSessionId;
	pathElement.textContent = session.cwd;
	relationElement.textContent =
		session.parentSessionId === undefined ? "Root session" : "Child session";
};

const createNode = (session: DiscoveredSession): HTMLButtonElement => {
	const node = document.createElement("button");
	node.type = "button";
	node.className = "session-node";
	node.dataset.sessionIdentity = session.identity;
	node.setAttribute("aria-pressed", "false");
	node.append(
		createText("session-node__signal"),
		createText("session-node__title"),
		createText("session-node__id"),
		createText("session-node__path"),
		createText("session-node__relation"),
	);
	node.querySelector<HTMLElement>(".session-node__signal")?.setAttribute("aria-hidden", "true");
	node.addEventListener("click", () => selectSession(session.identity));
	node.addEventListener("keydown", (event) => {
		if (!event.key.startsWith("Arrow")) return;
		event.preventDefault();
		const current = orderedIdentities.indexOf(session.identity);
		const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
		const next = (current + direction + orderedIdentities.length) % orderedIdentities.length;
		const nextIdentity = orderedIdentities[next];
		if (nextIdentity !== undefined) nodes.get(nextIdentity)?.focus();
	});
	updateNode(node, session);
	return node;
};

const reconcileSessions = (sessions: ReadonlyArray<DiscoveredSession>): void => {
	const unique = new Map<string, DiscoveredSession>(
		sessions.map((session) => [session.identity, session]),
	);
	orderedIdentities = [...unique.keys()].sort((left, right) => left.localeCompare(right));
	for (const [identity, node] of nodes) {
		if (unique.has(identity)) continue;
		node.remove();
		nodes.delete(identity);
	}
	for (const [index, identity] of orderedIdentities.entries()) {
		const session = unique.get(identity);
		if (session === undefined) continue;
		const node = nodes.get(identity) ?? createNode(session);
		const position = positionFor(index);
		node.style.setProperty("--node-x", `${position.x}px`);
		node.style.setProperty("--node-y", `${position.y}px`);
		updateNode(node, session);
		nodes.set(identity, node);
		nodeLayer.append(node);
	}
	if (selectedIdentity !== null && !nodes.has(selectedIdentity)) {
		selectedIdentity = null;
		selection.hidden = true;
	}
};

const setStatus = (tone: string, label: string, description: string): void => {
	statusBadge.dataset.tone = tone;
	statusLabel.textContent = label;
	statusDescription.textContent = description;
};

const showState = (options: {
	readonly tone: string;
	readonly eyebrow: string;
	readonly title: string;
	readonly description: string;
	readonly action: string;
	readonly details?: ReadonlyArray<string>;
}): void => {
	statePanel.hidden = false;
	statePanel.dataset.tone = options.tone;
	stateEyebrow.textContent = options.eyebrow;
	stateTitle.textContent = options.title;
	stateDescription.textContent = options.description;
	stateAction.textContent = options.action;
	stateDetails.replaceChildren();
	for (const detail of options.details ?? []) {
		const item = document.createElement("li");
		item.textContent = detail;
		stateDetails.append(item);
	}
	stateDetails.hidden = stateDetails.childElementCount === 0;
};

const hideState = (): void => {
	statePanel.hidden = true;
};

const problemDetails = (problems: ReadonlyArray<DiscoveryProblem>): ReadonlyArray<string> =>
	problems.map((problem) => `${basename(problem.source)}: ${problem.message}`);

const renderOutcome = (outcome: DiscoveryOutcome): void => {
	if (outcome._tag === "ready") {
		reconcileSessions(outcome.sessions);
		hideState();
		setStatus("ready", "Connected", `${outcome.sessions.length} sessions on the canvas`);
		return;
	}
	if (outcome._tag === "empty") {
		reconcileSessions([]);
		setStatus("empty", "No sessions", "Discovery completed successfully");
		showState({
			tone: "empty",
			eyebrow: "Workspace is clear",
			title: "No sessions found",
			description:
				"Start a pi coding session, then scan again. Tuval will place it here without inventing placeholders.",
			action: "Scan again",
		});
		return;
	}
	if (outcome._tag === "partial-source") {
		reconcileSessions(outcome.sessions);
		setStatus(
			"warning",
			"Partial source",
			`${outcome.sessions.length} sessions available; ${outcome.problems.length} sources need attention`,
		);
		showState({
			tone: "warning",
			eyebrow: "Some sessions are available",
			title: "A source could not be read",
			description:
				"Tuval kept the valid sessions on the canvas. Fix the named source, then scan again.",
			action: "Retry discovery",
			details: problemDetails(outcome.problems),
		});
		return;
	}
	if (outcome._tag === "transport") {
		reconcileSessions([]);
		setStatus("danger", "Disconnected", "The pi discovery transport is unavailable");
		showState({
			tone: "danger",
			eyebrow: "Connection lost",
			title: "Tuval cannot reach pi",
			description: outcome.retryable
				? "Check that the pi agent is running, then reconnect. No stale sessions are shown."
				: "Restart the pi agent before trying discovery again. No stale sessions are shown.",
			action: "Reconnect",
			details: [outcome.message],
		});
		return;
	}
	reconcileSessions([]);
	setStatus("danger", "Startup blocked", "The configured session source is unusable");
	showState({
		tone: "danger",
		eyebrow: "Discovery could not start",
		title: "Check the session source",
		description:
			"Verify PI_CODING_AGENT_SESSION_DIR or PI_CODING_AGENT_DIR points to a readable pi sessions directory, then retry.",
		action: "Try startup again",
		details: [outcome.message, ...problemDetails(outcome.problems)],
	});
};

const discover = async (): Promise<void> => {
	const generation = ++requestGeneration;
	setStatus("loading", "Discovering", "Reading configured pi session sources");
	showState({
		tone: "loading",
		eyebrow: "Discovery in progress",
		title: "Finding active work",
		description: "Tuval is asking the local pi agent for sessions. The canvas stays navigable.",
		action: "Scan again",
	});
	stateAction.disabled = true;
	refreshButton.disabled = true;
	try {
		const response = await fetch("/fate", {
			method: "POST",
			headers: {"content-type": "application/json"},
			body: JSON.stringify({
				version: 1,
				operations: [{id: "discovery", kind: "query", name: "discovery", select: []}],
			}),
		});
		if (!response.ok) throw new Error(`Discovery returned HTTP ${response.status}`);
		const outcome = decodeFateEnvelope(await response.json());
		if (outcome === undefined) throw new Error("Discovery returned an unreadable response");
		if (generation === requestGeneration) renderOutcome(outcome);
	} catch (error) {
		if (generation !== requestGeneration) return;
		renderOutcome({
			_tag: "transport",
			message: error instanceof Error ? error.message : String(error),
			retryable: true,
		});
	} finally {
		if (generation === requestGeneration) {
			stateAction.disabled = false;
			refreshButton.disabled = false;
		}
	}
};

const zoomBy = (factor: number): void =>
	setTransform({...transform, scale: transform.scale * factor});

canvas.addEventListener("pointerdown", (event) => {
	if ((event.target as Element).closest(".session-node, button") !== null) return;
	drag = {
		pointerId: event.pointerId,
		origin: {x: event.clientX, y: event.clientY},
		transform,
	};
	canvas.setPointerCapture(event.pointerId);
	canvas.dataset.dragging = "true";
});
canvas.addEventListener("pointermove", (event) => {
	if (drag?.pointerId !== event.pointerId) return;
	setTransform({
		...transform,
		x: drag.transform.x + event.clientX - drag.origin.x,
		y: drag.transform.y + event.clientY - drag.origin.y,
	});
});
const endDrag = (event: PointerEvent): void => {
	if (drag?.pointerId !== event.pointerId) return;
	drag = undefined;
	delete canvas.dataset.dragging;
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener(
	"wheel",
	(event) => {
		event.preventDefault();
		zoomBy(event.deltaY < 0 ? 1.1 : 0.9);
	},
	{passive: false},
);
canvas.addEventListener("keydown", (event) => {
	const panStep = event.shiftKey ? 64 : 32;
	if (event.key === "ArrowLeft") setTransform({...transform, x: transform.x - panStep});
	else if (event.key === "ArrowRight") setTransform({...transform, x: transform.x + panStep});
	else if (event.key === "ArrowUp") setTransform({...transform, y: transform.y - panStep});
	else if (event.key === "ArrowDown") setTransform({...transform, y: transform.y + panStep});
	else if (event.key === "+" || event.key === "=") zoomBy(1.1);
	else if (event.key === "-") zoomBy(0.9);
	else if (event.key === "Home") resetView();
	else return;
	event.preventDefault();
});

stateAction.addEventListener("click", () => void discover());
refreshButton.addEventListener("click", () => void discover());
zoomInButton.addEventListener("click", () => zoomBy(1.1));
zoomOutButton.addEventListener("click", () => zoomBy(0.9));
resetButton.addEventListener("click", resetView);

resetView();
void discover();
