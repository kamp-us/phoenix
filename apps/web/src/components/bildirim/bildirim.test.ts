import {describe, expect, it} from "vitest";
import {interpolate} from "../../i18n";
import {tr} from "../../i18n/tr";
import {
	bildirimCopy,
	bildirimTarget,
	formatUnreadBadge,
	rowUnread,
	shouldRenderBildirimPage,
	showUnreadBadge,
	targetLinkLabelKey,
} from "./bildirim";

/** The Turkish catalog read the way `LocaleProvider` reads it, so the copy assertions stay literal. */
const trCopy = (kind: string, count: number) =>
	bildirimCopy(kind, {t: (key, params) => interpolate(tr[key], params), locale: "tr", count});

const trLabel = (targetKind: string) => tr[targetLinkLabelKey(targetKind)];

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
		expect(trLabel("post")).toBe("gönderiye git");
		expect(trLabel("comment")).toBe("yoruma git");
		expect(trLabel("definition")).toBe("tanıma git");
		expect(trLabel("user")).toBe("profile git");
		expect(trLabel("mystery")).toBe("içeriğe git");
	});
});

describe("bildirimCopy — Turkish product voice per kind (#1695)", () => {
	it("divan-vote reads as received attention, aggregate count inline", () => {
		expect(trCopy("divan-vote", 1)).toBe("divandaki içeriğin oy aldı");
		expect(trCopy("divan-vote", 3)).toBe("divandaki içeriğin 3 oy aldı");
	});

	it("kefil reads as the vouch moment (no voucher identity drip)", () => {
		expect(trCopy("kefil", 1)).toBe("bir yazar sana kefil oldu");
	});

	it("terfi carries the ceremony — the çaylak→yazar promotion is a moment (#1696)", () => {
		expect(trCopy("terfi", 1)).toBe("tebrikler, artık bir yazarsın!");
	});

	it("backlog-release carries the swept count — R1.1 on #7049 ruled the count in (#7061)", () => {
		expect(trCopy("backlog-release", 3)).toBe("3 yazınız artık herkese açık");
		expect(trCopy("backlog-release", 1)).toBe("1 yazınız artık herkese açık");
	});

	it('a zero-entry sweep renders the zero arm — never "0 yazınız…"', () => {
		expect(trCopy("backlog-release", 0)).toBe("bundan sonra yazılarınız herkese açık");
		expect(trCopy("backlog-release", 0)).not.toMatch(/^0/);
	});

	it("reply renders Turkish copy — the raw `reply` identifier no longer surfaces (#2016)", () => {
		expect(trCopy("reply", 1)).toBe("gönderine yanıt geldi");
		expect(trCopy("reply", 3)).toBe("gönderine 3 yanıt geldi");
	});

	it("an unknown kind degrades to the raw kind + xN — never a blank row", () => {
		expect(trCopy("future-kind", 1)).toBe("future-kind");
		expect(trCopy("future-kind", 2)).toBe("future-kind ×2");
	});
});
