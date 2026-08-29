import type {LineageNode} from "../shared/lineage.js";
import type {
	LiveSessionCompletion,
	LiveSessionView,
	SessionPhase,
	ThinkingLevel,
} from "../shared/live-session.js";

export const NODE_DETAIL_LEVELS = ["bare", "meta", "live", "full"] as const;
export type NodeDetailLevel = (typeof NODE_DETAIL_LEVELS)[number];

export const DEFAULT_NODE_DETAIL_LEVEL: NodeDetailLevel = "meta";
export const NODE_DETAIL_STORAGE_KEY = "tuval.workspace.node-detail-level";

const nodeDetailLevelSet: ReadonlySet<string> = new Set(NODE_DETAIL_LEVELS);

const isNodeDetailLevel = (value: string | null): value is NodeDetailLevel =>
	value !== null && nodeDetailLevelSet.has(value);

export const readStoredNodeDetailLevel = (storage: Storage | undefined): NodeDetailLevel => {
	if (storage === undefined) return DEFAULT_NODE_DETAIL_LEVEL;
	try {
		const stored = storage.getItem(NODE_DETAIL_STORAGE_KEY);
		return isNodeDetailLevel(stored) ? stored : DEFAULT_NODE_DETAIL_LEVEL;
	} catch {
		return DEFAULT_NODE_DETAIL_LEVEL;
	}
};

export const writeStoredNodeDetailLevel = (
	storage: Storage | undefined,
	level: NodeDetailLevel,
): void => {
	if (storage === undefined) return;
	try {
		storage.setItem(NODE_DETAIL_STORAGE_KEY, level);
	} catch {
		// Persistence is optional; the in-memory workspace setting remains usable.
	}
};

export type NodeAttachmentConnection =
	| "pending"
	| "attached"
	| "refused"
	| "disconnected"
	| "malformed";

export interface NodeAttachment {
	readonly connection: NodeAttachmentConnection;
	readonly session: LiveSessionView | null;
}

export type NodeStatusKind =
	| "metadata"
	| "unknown"
	| "pending"
	| "running"
	| "stalled"
	| "failed"
	| "completed"
	| "disconnected";

export interface NodeStatus {
	readonly kind: NodeStatusKind;
	readonly source: "live" | "metadata" | "unknown";
	readonly sourceLabel: string;
	readonly label: string;
	readonly detail: string;
}

const completionLabel = (completion: LiveSessionCompletion): string => {
	if (completion === "running") return "Çalışıyor";
	if (completion === "complete") return "Tamamlandı";
	if (completion === "error") return "Başarısız";
	if (completion === "aborted") return "Durduruldu";
	if (completion === "disconnected") return "Bağlantı kesildi";
	return "Hazır";
};

const completionKind = (completion: LiveSessionCompletion): NodeStatusKind => {
	if (completion === "running") return "running";
	if (completion === "complete") return "completed";
	if (completion === "error" || completion === "aborted") return "failed";
	if (completion === "disconnected") return "disconnected";
	return "completed";
};

const phaseLabel = (phase: SessionPhase): string => {
	if (phase === "turn") return "Tur işleniyor";
	if (phase === "compaction") return "Bağlam sıkıştırılıyor";
	if (phase === "branch_summary") return "Dal özeti hazırlanıyor";
	if (phase === "retry") return "Yeniden deniyor";
	return "Yeni tur bekleniyor";
};

const metadataTimestamp = (updatedAt: number): string =>
	new Intl.DateTimeFormat("tr-TR", {
		dateStyle: "short",
		timeStyle: "short",
	}).format(new Date(updatedAt));

export const nodeStatus = (node: LineageNode, attachment: NodeAttachment | null): NodeStatus => {
	const liveSession = attachment?.session;
	if (
		liveSession !== null &&
		liveSession !== undefined &&
		(attachment?.connection === "disconnected" ||
			liveSession._tag === "disconnected" ||
			liveSession.completion === "disconnected")
	) {
		return {
			kind: "disconnected",
			source: "live",
			sourceLabel: "Canlı bağlantı yok",
			label: "Bağlantı kesildi",
			detail:
				liveSession?._tag === "disconnected"
					? liveSession.reason
					: "Son canlı görünüm korunuyor; yeni olay alınmıyor.",
		};
	}
	if (attachment?.connection === "attached" && liveSession?._tag === "attached") {
		if (liveSession.phase === "retry" && liveSession.completion === "running") {
			return {
				kind: "stalled",
				source: "live",
				sourceLabel: "Protokol canlı",
				label: "Takıldı",
				detail: "Yeniden deniyor",
			};
		}
		return {
			kind: completionKind(liveSession.completion),
			source: "live",
			sourceLabel: "Protokol canlı",
			label: completionLabel(liveSession.completion),
			detail: phaseLabel(liveSession.phase),
		};
	}
	if (attachment?.connection === "pending") {
		return {
			kind: "pending",
			source: "metadata",
			sourceLabel: "Metadata",
			label: "Canlı veri bekleniyor",
			detail: `Son metadata ${metadataTimestamp(node.updatedAt)}`,
		};
	}
	if (node.sourceFiles.length === 0) {
		return {
			kind: "unknown",
			source: "unknown",
			sourceLabel: "Metadata",
			label: "Tazelik bilinmiyor",
			detail: "Okunabilir bir oturum kaynağı yok.",
		};
	}
	return {
		kind: "metadata",
		source: "metadata",
		sourceLabel: "Metadata",
		label: "Kayıtlı görünüm",
		detail: "Canlı bağlantı kurulmadı",
	};
};

export const thinkingLabel = (level: ThinkingLevel): string => {
	if (level === "off") return "kapalı";
	if (level === "minimal") return "en az";
	if (level === "low") return "düşük";
	if (level === "medium") return "orta";
	if (level === "high") return "yüksek";
	if (level === "xhigh") return "çok yüksek";
	return "en yüksek";
};

const levelRank: Readonly<Record<NodeDetailLevel, number>> = {
	bare: 0,
	meta: 1,
	live: 2,
	full: 3,
};

export const includesNodeDetail = (
	level: NodeDetailLevel,
	minimum: Exclude<NodeDetailLevel, "bare">,
): boolean => levelRank[level] >= levelRank[minimum];
