/** The bildirim surface's render decisions (#1694), factored out so they test without a DOM. */
import type {NotificationKind} from "../../../worker/features/bildirim/kind";

/** Flag off (and every flag failure mode) renders the 404 — the dark ship, ADR 0083. */
export function shouldRenderBildirimPage(flagOn: boolean): boolean {
	return flagOn;
}

export function showUnreadBadge(unread: number): boolean {
	return unread > 0;
}

export function formatUnreadBadge(unread: number): string {
	return unread > 99 ? "99+" : String(unread);
}

export type BildirimTarget = {kind: "link"; href: string} | {kind: "tombstone"};

export function bildirimTarget(targetUrl: string | null | undefined): BildirimTarget {
	return targetUrl ? {kind: "link", href: targetUrl} : {kind: "tombstone"};
}

/** The mark-read receipt doesn't rewrite the listed rows, so the session's own mark state folds in here. */
export function rowUnread(
	readAt: string | null | undefined,
	markedThisSession: boolean,
	allMarkedThisSession: boolean,
): boolean {
	return readAt == null && !markedThisSession && !allMarkedThisSession;
}

// R1.1 on #7049 ruled the count into the backlog-release copy, with a distinct zero arm
// for a sweep that published nothing. Both arms are required fields, so shipping the kind
// with either arm missing is a compile error — "0 yazınız…" stays unrepresentable.
const BACKLOG_RELEASE_COPY: {zero: string; some: (count: number) => string} = {
	zero: "bundan sonra yazılarınız herkese açık",
	some: (count) => `${count} yazınız artık herkese açık`,
};

// `satisfies Record<NotificationKind, …>` keeps the map exhaustive over the shared kind
// union (#2016): a new emitter kind without its copy is a compile error, not a raw wire
// identifier rendered to a reader.
const KIND_COPY = {
	"divan-vote": (count) =>
		count > 1 ? `divandaki içeriğin ${count} oy aldı` : "divandaki içeriğin oy aldı",
	kefil: () => "bir yazar sana kefil oldu",
	terfi: () => "tebrikler, artık bir yazarsın!",
	reply: (count) => (count > 1 ? `gönderine ${count} yanıt geldi` : "gönderine yanıt geldi"),
	vote: (count) => (count > 1 ? `içeriğin ${count} yeni oy aldı` : "içeriğin 1 yeni oy aldı"),
	"report-filed": (count) =>
		count > 1 ? `${count} yeni içerik bildirildi` : "yeni bir içerik bildirildi",
	"caylak-pending": () => "yeni bir çaylak divanda incelenmeyi bekliyor",
	"backlog-release": (count) =>
		count > 0 ? BACKLOG_RELEASE_COPY.some(count) : BACKLOG_RELEASE_COPY.zero,
} satisfies Record<NotificationKind, (count: number) => string>;

/** An unknown kind — a future emitter's, read by an older client — degrades to the raw kind. */
export function bildirimCopy(kind: string, count: number): string {
	const copy = (KIND_COPY as Record<string, (count: number) => string>)[kind];
	if (copy) return copy(count);
	return count > 1 ? `${kind} ×${count}` : kind;
}

const TARGET_LINK_LABELS: Record<string, string> = {
	post: "gönderiye git",
	comment: "yoruma git",
	definition: "tanıma git",
	user: "profile git",
};

export function targetLinkLabel(targetKind: string): string {
	return TARGET_LINK_LABELS[targetKind] ?? "içeriğe git";
}
