/**
 * The bildirim render decisions (#1694) asserted without a DOM — the ACs the
 * badge + center rows answer to: badge only when unread > 0; a dead target is a
 * tombstone, never a broken link; a row marked read this session stops reading
 * as unread.
 */
import {describe, expect, it} from "vitest";
import {
	bildirimCopy,
	bildirimTarget,
	formatUnreadBadge,
	rowUnread,
	shouldRenderBildirimPage,
	showUnreadBadge,
	targetLinkLabel,
} from "./bildirim";

describe("shouldRenderBildirimPage — the dark-ship gate", () => {
	it("renders only when the flag is on; off/loading/error (false) is the 404", () => {
		expect(shouldRenderBildirimPage(true)).toBe(true);
		expect(shouldRenderBildirimPage(false)).toBe(false);
	});
});

describe("showUnreadBadge — only when unread > 0 (the AC)", () => {
	it("hides at 0, shows at 1+", () => {
		expect(showUnreadBadge(0)).toBe(false);
		expect(showUnreadBadge(1)).toBe(true);
		expect(showUnreadBadge(42)).toBe(true);
	});
});

describe("formatUnreadBadge — quiet at scale", () => {
	it("prints the count up to 99, then 99+", () => {
		expect(formatUnreadBadge(1)).toBe("1");
		expect(formatUnreadBadge(99)).toBe("99");
		expect(formatUnreadBadge(100)).toBe("99+");
	});
});

describe("bildirimTarget — link or tombstone, never a broken href", () => {
	it("a resolved targetUrl is a working link", () => {
		expect(bildirimTarget("/pano/p1")).toEqual({kind: "link", href: "/pano/p1"});
	});

	it("null/undefined (target gone) is the tombstone", () => {
		expect(bildirimTarget(null)).toEqual({kind: "tombstone"});
		expect(bildirimTarget(undefined)).toEqual({kind: "tombstone"});
	});
});

describe("rowUnread — server stamp folded with this session's mark state", () => {
	it("unread iff no readAt and not marked this session", () => {
		expect(rowUnread(null, false, false)).toBe(true);
	});

	it("a server readAt stamp reads as read", () => {
		expect(rowUnread("2026-07-01T00:00:00Z", false, false)).toBe(false);
	});

	it("marking one row (or all) this session flips it read without a reload", () => {
		expect(rowUnread(null, true, false)).toBe(false);
		expect(rowUnread(null, false, true)).toBe(false);
	});
});

describe("targetLinkLabel — per-kind Turkish labels, generic fallback", () => {
	it("maps the four kinds and falls back for an unknown one", () => {
		expect(targetLinkLabel("post")).toBe("gönderiye git");
		expect(targetLinkLabel("comment")).toBe("yoruma git");
		expect(targetLinkLabel("definition")).toBe("tanıma git");
		expect(targetLinkLabel("user")).toBe("profile git");
		expect(targetLinkLabel("mystery")).toBe("içeriğe git");
	});
});

describe("bildirimCopy — Turkish product voice per kind (#1695)", () => {
	it("divan-vote reads as received attention, aggregate count inline", () => {
		expect(bildirimCopy("divan-vote", 1)).toBe("divandaki içeriğin oy aldı");
		expect(bildirimCopy("divan-vote", 3)).toBe("divandaki içeriğin 3 oy aldı");
	});

	it("kefil reads as the vouch moment (no voucher identity drip)", () => {
		expect(bildirimCopy("kefil", 1)).toBe("bir yazar sana kefil oldu");
	});

	it("an unknown kind degrades to the raw kind + xN — never a blank row", () => {
		expect(bildirimCopy("future-kind", 1)).toBe("future-kind");
		expect(bildirimCopy("future-kind", 2)).toBe("future-kind ×2");
	});
});
