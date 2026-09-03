/**
 * `WelcomePage` — `/hosgeldin`, the welcome moment (#7043, epic #4304): ONE screen
 * answering what kamp.us is, where the reader stands and what the yazarlık rite ahead
 * looks like — explicitly not a tour, no second step (#4266's ruling). Reached through
 * the post-auth intercept in `App.tsx`; ships dark behind `phoenix-welcome`
 * (`.patterns/flag-dark-page-gate.md`).
 *
 * Honest framing is inherited, never re-derived (#4261): an unvouched çaylak gets
 * `CaylakStatusBlock`'s settled vouch-needed copy and NO karma bar, off the same
 * aggregate-only `myAuthorshipStanding` read. The exit nudge is sibling slice #7044's
 * seam — this surface ends at "devam et".
 *
 * Shown-once semantics: arrival itself writes the per-account marker
 * (`welcomeSeen.ts`), so a reload or repeat login lands in the gate's `return` state and
 * bounces straight to the original `returnTo`.
 */

import {Button} from "@kampus/design";
import {useEffect, useState} from "react";
import {Navigate, useLocation, useNavigate} from "react-router";
import {useSession} from "../auth/client";
import {useMe} from "../auth/useMe";
import {Karma} from "../components/karma/Karma";
import {
	hasSeenWelcome,
	markWelcomeSeen,
	welcomeStorage,
} from "../components/onboarding/welcomeSeen";
import {
	caylakPromotionPath,
	useAuthorshipStanding,
	vouchExistsLabel,
} from "../components/profile/CaylakStatusBlock";
import {PHOENIX_WELCOME} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {authRedirectPath} from "../lib/returnTo";
import {NotFoundPage} from "./NotFoundPage";
import {welcomeAddressing, welcomeGate, welcomeReturnTo} from "./welcomeGating";
import "./WelcomePage.css";

export function WelcomePage() {
	const {value: flagOn, loading: flagLoading} = useFlag(PHOENIX_WELCOME, false);
	const session = useSession();
	const navigate = useNavigate();
	const location = useLocation();
	const {me} = useMe();

	const returnTo = welcomeReturnTo(location.search);
	const userId = session.data?.user.id ?? null;

	// The seen-decision latches per account, NOT at mount: on a reload `session.isPending`
	// holds `userId` at null for the first renders, and a mount-frozen `false` would then
	// survive the real session's arrival and re-show a welcome that was already suppressed.
	// It must still latch once the id is known, because the effect below writes the marker
	// mid-visit and a live re-read would bounce this very visit before it painted.
	const [seenLatch, setSeenLatch] = useState<{userId: string; seen: boolean} | null>(null);
	if (userId !== null && seenLatch?.userId !== userId) {
		setSeenLatch({userId, seen: hasSeenWelcome(welcomeStorage(), userId)});
	}
	const seenAtArrival = seenLatch?.userId === userId && seenLatch.seen;

	const gate = welcomeGate({
		flagOn,
		flagLoading,
		sessionPending: session.isPending,
		signedIn: !!session.data?.user,
		welcomeSeen: seenAtArrival,
	});

	// Arrival is the showing: once-per-account (#4266) means the marker lands when the
	// surface mounts, not only when "devam et" is clicked.
	useEffect(() => {
		if (gate !== "ready") return;
		markWelcomeSeen(welcomeStorage(), userId);
	}, [gate, userId]);

	const addressing = welcomeAddressing(me?.tier);
	const standing = useAuthorshipStanding(gate === "ready");

	if (gate === "loading") {
		return (
			<div className="kp-welcome">
				<div className="kp-welcome__inner">
					<p className="kp-welcome__lede" data-testid="welcome-loading">
						yükleniyor…
					</p>
				</div>
			</div>
		);
	}

	if (gate === "not-found") return <NotFoundPage />;

	if (gate === "sign-in") {
		return <Navigate to={authRedirectPath(returnTo)} replace />;
	}

	if (gate === "return") return <Navigate to={returnTo} replace />;

	const promotionPath = standing ? caylakPromotionPath(standing.vouchExists) : null;

	return (
		<main className="kp-welcome" data-testid="welcome-page">
			<div className="kp-welcome__inner">
				<header className="kp-welcome__masthead">
					{/* "hoş geldin, çaylak" is the founder's ruled copy for this moment (#4266); the
					    tier is named only to a reader who actually holds it (#4261). */}
					<h1 className="kp-welcome__title" data-testid="welcome-title">
						{addressing === "çaylak" ? "hoş geldin, çaylak" : "hoş geldin"}
					</h1>
					<p className="kp-welcome__lede">
						kamp.us, geliştiricilerin kendi kendine bir şey öğrettiği yavaş bir köşe. panoda
						bağlantı ve yazı paylaşılıyor; sözlükte terimler kendi cümlelerimizle yazılıyor. reklam
						yok, takipçi yarışı yok — söz hakkı kazanılır.
					</p>
				</header>

				<section className="kp-welcome__section" data-testid="welcome-standing">
					<h2 className="kp-welcome__heading">neredesin</h2>
					{addressing === "çaylak" ? (
						<>
							<p className="kp-welcome__line">hesabın yeni açıldı; henüz bir çaylaksın.</p>
							{promotionPath?.kind === "vouch-needed" ? (
								<div className="kp-welcome__vouch-needed" data-testid="welcome-vouch-needed">
									<p className="kp-welcome__vouch-message">{promotionPath.message}</p>
									<p className="kp-welcome__vouch-hint">{promotionPath.hint}</p>
								</div>
							) : null}
							{promotionPath?.kind === "karma-bar" && standing ? (
								<Karma
									value={standing.karma}
									target={standing.bar}
									label="karma"
									testId="welcome-karma"
								/>
							) : null}
							{standing ? (
								<dl className="kp-welcome__facts">
									<div className="kp-welcome__fact">
										<dt className="kp-welcome__term">kefil</dt>
										<dd className="kp-welcome__value" data-testid="welcome-vouch">
											{vouchExistsLabel(standing.vouchExists)}
										</dd>
									</div>
								</dl>
							) : null}
						</>
					) : addressing === "yazar" ? (
						<p className="kp-welcome__line" data-testid="welcome-yazar-note">
							zaten bir yazarsın; yazdıkların doğrudan yayına girer.
						</p>
					) : (
						<p className="kp-welcome__line">durumun yükleniyor.</p>
					)}
				</section>

				{addressing !== "yazar" ? (
					<section className="kp-welcome__section" data-testid="welcome-rite">
						<h2 className="kp-welcome__heading">önündeki yol</h2>
						<p className="kp-welcome__line">
							ilk katkını yaz — mevcut bir başlığa girdi ekleyerek başlayabilirsin. katkı verdikçe
							bir yazar sana kefil olur; kefillik ve inceleme tamamlandığında yazar olursun ve
							yazdıkların doğrudan yayına girer.
						</p>
					</section>
				) : null}

				<Button
					type="button"
					variant="primary"
					className="kp-welcome__continue"
					data-testid="welcome-continue"
					onClick={() => navigate(returnTo, {replace: true})}
				>
					devam et
				</Button>
			</div>
		</main>
	);
}
