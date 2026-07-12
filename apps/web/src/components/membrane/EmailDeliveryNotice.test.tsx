/**
 * The failing-email membrane notice (epic #2687, Child #2693). Pins the render contract of the
 * presentational notice (Turkish copy + a recovery CTA that actually reaches the change-email
 * surface + dismissal) and the mount gate (dark behind the flag, present only for a failing
 * signed-in user, hidden once dismissed).
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fireEvent, render, screen} from "@testing-library/react";
import type {ReactNode} from "react";
import {MemoryRouter, Route, Routes} from "react-router";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {MeUser} from "../../auth/useMe";
import {EmailDeliveryNotice} from "./EmailDeliveryNotice";
import {EmailDeliveryNoticeMount} from "./EmailDeliveryNoticeMount";
import type {EmailDeliveryReadable} from "./emailDeliveryNoticeGate";

let flagOn: boolean;
vi.mock("../../flags/useFlag", () => ({useFlag: () => ({value: flagOn, loading: false})}));

const makeMe = (emailFailing: boolean): MeUser & EmailDeliveryReadable =>
	({
		id: "u1",
		email: "a@b.co",
		name: null,
		image: null,
		username: "anka",
		tier: "çaylak",
		isModerator: false,
		emailFailing,
	}) as MeUser & EmailDeliveryReadable;

function renderNotice(ui: ReactNode) {
	return render(
		<MemoryRouter initialEntries={["/"]}>
			<Routes>
				<Route path="/" element={ui} />
				<Route path="/profile" element={<div data-testid="profile-page">profil</div>} />
			</Routes>
		</MemoryRouter>,
	);
}

describe("EmailDeliveryNotice — presentational (#2693)", () => {
	it("renders the Turkish failing-email notice", () => {
		renderNotice(<EmailDeliveryNotice recoveryHref="/profile" />);
		const notice = screen.getByTestId("email-delivery-notice");
		expect(notice.textContent).toContain("e-postana ulaşamıyoruz");
		// The meaning is carried by text, not color alone (four-pillars a11y).
		expect(notice.textContent).toContain("geri dönüyor");
	});

	it("the recovery CTA reaches the existing change-email surface on click", () => {
		renderNotice(<EmailDeliveryNotice recoveryHref="/profile" />);
		expect(screen.queryByTestId("profile-page")).toBeNull();
		fireEvent.click(screen.getByTestId("email-delivery-notice-cta"));
		expect(screen.getByTestId("profile-page")).toBeTruthy();
	});

	it("shows a dismiss button only when onDismiss is provided", () => {
		const onDismiss = vi.fn();
		renderNotice(<EmailDeliveryNotice recoveryHref="/profile" onDismiss={onDismiss} />);
		fireEvent.click(screen.getByTestId("email-delivery-notice-dismiss"));
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it("omits the dismiss button with no onDismiss", () => {
		renderNotice(<EmailDeliveryNotice recoveryHref="/profile" />);
		expect(screen.queryByTestId("email-delivery-notice-dismiss")).toBeNull();
	});
});

describe("EmailDeliveryNoticeMount — the membrane gate (#2693)", () => {
	afterEach(() => vi.clearAllMocks());

	it("flag on + failing user: renders the notice", () => {
		flagOn = true;
		renderNotice(<EmailDeliveryNoticeMount me={makeMe(true)} />);
		expect(screen.getByTestId("email-delivery-notice")).toBeTruthy();
	});

	it("flag off: renders nothing even for a failing user (dark-ship)", () => {
		flagOn = false;
		renderNotice(<EmailDeliveryNoticeMount me={makeMe(true)} />);
		expect(screen.queryByTestId("email-delivery-notice")).toBeNull();
	});

	it("flag on + not failing: renders nothing", () => {
		flagOn = true;
		renderNotice(<EmailDeliveryNoticeMount me={makeMe(false)} />);
		expect(screen.queryByTestId("email-delivery-notice")).toBeNull();
	});

	it("signed-out (null me): renders nothing", () => {
		flagOn = true;
		renderNotice(<EmailDeliveryNoticeMount me={null} />);
		expect(screen.queryByTestId("email-delivery-notice")).toBeNull();
	});

	it("hides after the user dismisses it", () => {
		flagOn = true;
		renderNotice(<EmailDeliveryNoticeMount me={makeMe(true)} />);
		fireEvent.click(screen.getByTestId("email-delivery-notice-dismiss"));
		expect(screen.queryByTestId("email-delivery-notice")).toBeNull();
	});
});

/**
 * CSS-source tripwire for the four-pillars ≥36px tap-target floor (#2727 review-design). jsdom
 * can't compute layout, so the floor is pinned against the CSS bytes: the dismiss uses the raw
 * `--sm` size (24.8px alone), so its hit area comes from `align-items: stretch` on the actions
 * row inheriting the CTA's `min-height: var(--s-8)` row height. Remove either and the dismiss
 * drops below the floor — this fails here rather than only under manual design review.
 */
describe("EmailDeliveryNotice — tap-target floor (#2727)", () => {
	const css = readFileSync(join(import.meta.dirname, "EmailDeliveryNotice.css"), "utf8");

	it("the actions row stretches so the dismiss inherits the CTA's row height", () => {
		expect(css).toMatch(/\.kp-email-notice__actions\s*\{[^}]*align-items:\s*stretch/s);
	});

	it("the CTA sets the row's ≥36px floor via min-height: var(--s-8)", () => {
		expect(css).toMatch(/\.kp-email-notice__cta\s*\{[^}]*min-height:\s*var\(--s-8\)/s);
	});
});
