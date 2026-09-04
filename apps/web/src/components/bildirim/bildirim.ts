/** The bildirim surface's render decisions (#1694), factored out so they test without a DOM. */
import type {NotificationKind} from "../../../worker/features/bildirim/kind";
import type {CatalogKey, Locale, PluralForms, Translate} from "../../i18n";
import {plural} from "../../i18n";

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

/** The catalog and the locale the count pluralizes under, threaded in from the render site. */
export interface BildirimCopyContext {
	readonly t: Translate;
	readonly locale: Locale;
	readonly count: number;
}

const pluralCopy =
	(one: CatalogKey, other: CatalogKey) =>
	({t, locale, count}: BildirimCopyContext) =>
		t(plural(locale, count, {one, other}), {count});

const fixedCopy =
	(key: CatalogKey) =>
	({t}: BildirimCopyContext) =>
		t(key);

// R1.1 on #7049 ruled the count into the backlog-release copy, with a distinct zero arm for a
// sweep that published nothing. Zero is not an `Intl.PluralRules` category in either locale, so
// it is a branch rather than a plural form, and the non-zero side is an ordinary two-arm plural;
// every arm is a required field, so shipping the kind with one missing is a compile error —
// "0 yazınız…" and "1 of your posts are…" both stay unrepresentable.
const BACKLOG_RELEASE_KEYS: {zero: CatalogKey; some: PluralForms<CatalogKey>} = {
	zero: "bildirim.kind.backlogRelease.zero",
	some: {
		one: "bildirim.kind.backlogRelease.one",
		other: "bildirim.kind.backlogRelease.other",
	},
};

// `satisfies Record<NotificationKind, …>` keeps the map exhaustive over the shared kind
// union (#2016): a new emitter kind without its copy is a compile error, not a raw wire
// identifier rendered to a reader.
const KIND_COPY = {
	"divan-vote": pluralCopy("bildirim.kind.divanVote.one", "bildirim.kind.divanVote.other"),
	kefil: fixedCopy("bildirim.kind.kefil"),
	terfi: fixedCopy("bildirim.kind.terfi"),
	reply: pluralCopy("bildirim.kind.reply.one", "bildirim.kind.reply.other"),
	vote: pluralCopy("bildirim.kind.vote.one", "bildirim.kind.vote.other"),
	"report-filed": pluralCopy("bildirim.kind.reportFiled.one", "bildirim.kind.reportFiled.other"),
	"caylak-pending": fixedCopy("bildirim.kind.caylakPending"),
	"backlog-release": (ctx: BildirimCopyContext) =>
		ctx.count > 0
			? ctx.t(plural(ctx.locale, ctx.count, BACKLOG_RELEASE_KEYS.some), {count: ctx.count})
			: ctx.t(BACKLOG_RELEASE_KEYS.zero),
} satisfies Record<NotificationKind, (ctx: BildirimCopyContext) => string>;

/** An unknown kind — a future emitter's, read by an older client — degrades to the raw kind. */
export function bildirimCopy(kind: string, ctx: BildirimCopyContext): string {
	const copy = (KIND_COPY as Record<string, (ctx: BildirimCopyContext) => string>)[kind];
	if (copy) return copy(ctx);
	return ctx.count > 1 ? ctx.t("bildirim.kind.unknown", {kind, count: ctx.count}) : kind;
}

const TARGET_LINK_KEYS: Record<string, CatalogKey> = {
	post: "bildirim.target.post",
	comment: "bildirim.target.comment",
	definition: "bildirim.target.definition",
	user: "bildirim.target.user",
};

export function targetLinkLabelKey(targetKind: string): CatalogKey {
	return TARGET_LINK_KEYS[targetKind] ?? "bildirim.target.fallback";
}
