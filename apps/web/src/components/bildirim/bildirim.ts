/**
 * The bildirim surface's render decisions (#1694), factored DOM-free so they are
 * unit-testable without a DOM/React runtime — the pure-extraction idiom of
 * `funnelGating` / `savedReconcile` (`apps/web/src` has no jsdom). These are the
 * ACs the badge + center page live or die on: badge only when unread > 0, a
 * dead target renders a tombstone (never a broken link), and a marked-read row
 * stops counting as unread without a reload.
 */
import type {NotificationKind} from "../../../worker/features/bildirim/kind";

/**
 * Show the `/bildirimler` page content iff the bildirim flag is on. Off (and
 * every flag failure mode — loading/error/undeclared resolve to `false`
 * upstream) renders the 404, so with the flag off the route is effectively
 * absent (the dark ship, ADR 0083).
 */
export function shouldRenderBildirimPage(flagOn: boolean): boolean {
	return flagOn;
}

/** The badge renders ONLY when there is something unread — never a `0` chip. */
export function showUnreadBadge(unread: number): boolean {
	return unread > 0;
}

/** The badge stays quiet at scale: `99+` past two digits. */
export function formatUnreadBadge(unread: number): string {
	return unread > 99 ? "99+" : String(unread);
}

export type BildirimTarget = {kind: "link"; href: string} | {kind: "tombstone"};

/**
 * The row's target decision off the server-resolved `targetUrl`: a present href
 * is a working link; `null`/absent (the target no longer resolves) is the
 * tombstone — a dead row, never a broken link or a crash.
 */
export function bildirimTarget(targetUrl: string | null | undefined): BildirimTarget {
	return targetUrl ? {kind: "link", href: targetUrl} : {kind: "tombstone"};
}

/**
 * Is the row unread NOW, folding the server stamp with the session's local
 * mark-read state (the receipt round-trip doesn't rewrite the listed rows):
 * unread iff the server says unread AND neither this row nor "all" was marked
 * read this session.
 */
export function rowUnread(
	readAt: string | null | undefined,
	markedThisSession: boolean,
	allMarkedThisSession: boolean,
): boolean {
	return readAt == null && !markedThisSession && !allMarkedThisSession;
}

// Kind → Turkish row copy (#1695/#1696): kinds stay wire identifiers, the
// rendered line is product voice. `count` is the aggregate slot ("N oy"). The
// `terfi` line carries the ceremony — the çaylak→yazar promotion is the single
// most ceremonial moment in the rite, so it reads as a moment, not a log line.
//
// `satisfies Record<NotificationKind, …>` makes the map EXHAUSTIVE over the shared
// kind union (#2016): a new emitter kind cannot ship without its copy — a missing
// entry is a compile error, not a raw wire identifier rendered to a reader.
const KIND_COPY = {
	"divan-vote": (count) =>
		count > 1 ? `divandaki içeriğin ${count} oy aldı` : "divandaki içeriğin oy aldı",
	kefil: () => "bir yazar sana kefil oldu",
	terfi: () => "tebrikler, artık bir yazarsın!",
	reply: (count) => (count > 1 ? `gönderine ${count} yanıt geldi` : "gönderine yanıt geldi"),
	// The aggregated live-content vote voice (#1698): the anti-hype "N yeni oy",
	// one rolled-up line per item — never one-per-vote, never a per-voter identity drip.
	vote: (count) => (count > 1 ? `içeriğin ${count} yeni oy aldı` : "içeriğin 1 yeni oy aldı"),
	// The mod-queue heartbeat (#1699): mod-facing lines, not member-facing.
	"report-filed": (count) =>
		count > 1 ? `${count} yeni içerik bildirildi` : "yeni bir içerik bildirildi",
	"caylak-pending": () => "yeni bir çaylak divanda incelenmeyi bekliyor",
} satisfies Record<NotificationKind, (count: number) => string>;

/**
 * The row's Turkish copy per kind. An unknown kind (a future emitter's, read by
 * an older client) degrades to the raw kind + `×N` — never a crash or a blank row.
 */
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

/** The target link's Turkish label per kind; an unknown kind reads generically. */
export function targetLinkLabel(targetKind: string): string {
	return TARGET_LINK_LABELS[targetKind] ?? "içeriğe git";
}
