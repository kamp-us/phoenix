/**
 * The English render of the mecmua and account surfaces (#7531) — the provider path end to end,
 * plus the loaded `en` catalog for the surfaces whose components need a fate client to mount.
 */
import {render, screen, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {MemoryRouter} from "react-router";
import {beforeEach, describe, expect, it} from "vitest";
import {EmailDeliveryNotice} from "../components/membrane/EmailDeliveryNotice";
import {ProfileHeader} from "../components/profile/ProfileHeader";
import {CaylakBadge} from "../components/ui/CaylakBadge";
import {DraftRestoreBanner} from "../components/ui/DraftRestoreBanner";
import {ReviewBadge} from "../components/ui/ReviewBadge";
import {LOCALE_STORAGE_KEY} from "../lib/localeStorage";
import {NotFoundPage} from "../pages/NotFoundPage";
import {loadCatalog} from "./catalog";
import {LocaleProvider} from "./LocaleProvider";

function mountInEnglish(children: ReactNode) {
	window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
	return render(
		<MemoryRouter>
			<LocaleProvider>{children}</LocaleProvider>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	window.localStorage.clear();
	document.documentElement.lang = "";
});

describe("the account surfaces render English once the locale is en", () => {
	it("swaps the profile header, the shared badges and the 404, and holds the brand nouns", async () => {
		mountInEnglish(
			<>
				<ProfileHeader displayName="Elif" handle="elif" stats={null} statsError />
				<ReviewBadge />
				<CaylakBadge />
				<DraftRestoreBanner onRestore={() => {}} onDismiss={() => {}} />
				<EmailDeliveryNotice recoveryHref="/profile" />
				<NotFoundPage />
			</>,
		);

		await waitFor(() =>
			expect(screen.getByTestId("stats-error").textContent).toBe("stats could not be loaded"),
		);
		expect(screen.getByTestId("incelemede-badge").textContent).toBe("in review");
		expect(screen.getByTestId("caylak-badge").textContent).toBe(
			"çaylak contribution, in the preparation stage",
		);
		expect(screen.getByTestId("draft-restore-accept").textContent).toBe("restore the draft");
		expect(screen.getByTestId("email-delivery-notice-cta").textContent).toBe("update your email");
		expect(screen.getByRole("link", {name: "sözlük"})).toBeTruthy();
		expect(screen.getByRole("link", {name: "pano"})).toBeTruthy();
		expect(document.documentElement.lang).toBe("en");
	});
});

describe("the en catalog covers the surfaces whose components need a transport to mount", () => {
	it("carries English for the mecmua feed, the editor, bildirimler and the mutes page", async () => {
		const en = await loadCatalog("en");
		expect(en["mecmua.feed.lede"]).toBe("the latest from the authors you follow.");
		expect(en["mecmua.editor.action.publish"]).toBe("publish");
		expect(en["mecmua.drafts.title"]).toBe("my posts");
		expect(en["bildirim.title"]).toBe("notifications");
		expect(en["bildirim.kind.reply.other"]).toBe("your post got {count} replies");
		expect(en["mute.page.title"]).toBe("muted members");
		expect(en["profile.section.danger"]).toBe("danger zone");
	});
});
