/**
 * `WelcomePage` — `/hosgeldin`, the welcome moment (#7043, epic #4304): ONE screen
 * answering what kamp.us is, where the reader stands and what the yazarlık rite ahead
 * looks like — explicitly not a tour, no second step (#4266's ruling). Reached through
 * the post-auth intercept in `App.tsx`; ships dark behind `phoenix-welcome`
 * (`.patterns/flag-dark-page-gate.md`).
 *
 * Honest framing is inherited, never re-derived (#4261): an unvouched çaylak gets
 * `CaylakStatusBlock`'s settled vouch-needed copy and NO karma bar, off the same
 * aggregate-only `myAuthorshipStanding` read. The exit is #7044's dismissible
 * first-contribution ask, whose audience and target are `firstContribution.ts`'s call —
 * the screen itself still ends at "devam et".
 *
 * Shown-once semantics: arrival itself writes the per-account marker
 * (`welcomeSeen.ts`), so a reload or repeat login lands in the gate's `return` state and
 * bounces straight to the original `returnTo`.
 */
import {useEffect, useState} from "react";
import {Navigate, useLocation, useNavigate} from "react-router";
import {useSession} from "../auth/client";
import {useMe} from "../auth/useMe";
import {Karma} from "../components/karma/Karma";
import {FirstContributionNudge} from "../components/onboarding/FirstContributionNudge";
import {
	dismissFirstContribution,
	firstContributionNudge,
	firstContributionStorage,
	isFirstContributionDismissed,
} from "../components/onboarding/firstContribution";
import {
	hasSeenWelcome,
	markWelcomeSeen,
	welcomeStorage,
} from "../components/onboarding/welcomeSeen";
import {
	caylakPromotionPath,
	useSharedAuthorshipStanding,
	vouchExistsLabelKey,
} from "../components/profile/CaylakStatusBlock";
import {Button} from "../components/ui/Button";
import {PHOENIX_WELCOME} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {useT} from "../i18n";
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
	const t = useT();

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

	// Latched per account for the same reason `seenLatch` is: dismissing writes the marker
	// mid-visit, and a live re-read would then vanish the nudge under the reader's own click
	// with no state to explain it. Unlatched reads as dismissed, so a resolving session never
	// flashes an ask it is about to suppress.
	const [dismissLatch, setDismissLatch] = useState<{userId: string; dismissed: boolean} | null>(
		null,
	);
	if (userId !== null && dismissLatch?.userId !== userId) {
		setDismissLatch({
			userId,
			dismissed: isFirstContributionDismissed(firstContributionStorage(), userId),
		});
	}
	const nudge = firstContributionNudge({
		tier: me?.tier,
		returnTo,
		dismissed: dismissLatch?.userId !== userId || dismissLatch.dismissed,
	});

	const addressing = welcomeAddressing(me?.tier);
	const standing = useSharedAuthorshipStanding(gate === "ready");

	if (gate === "loading") {
		return (
			<div className="kp-welcome">
				<div className="kp-welcome__inner">
					<p className="kp-welcome__lede" data-testid="welcome-loading">
						{t("auth.welcome.loading")}
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
					{/* The tier is named only to a reader who actually holds it (#4261); the two
					    greetings are the founder's ruled copy for this moment (#4266). */}
					<h1 className="kp-welcome__title" data-testid="welcome-title">
						{addressing === "çaylak" ? t("auth.welcome.titleCaylak") : t("auth.welcome.title")}
					</h1>
					<p className="kp-welcome__lede">
						{t("auth.welcome.lede", {
							panoNoun: t("auth.brand.pano"),
							sozlukNoun: t("auth.brand.sozluk"),
						})}
					</p>
				</header>

				<section className="kp-welcome__section" data-testid="welcome-standing">
					<h2 className="kp-welcome__heading">{t("auth.welcome.standingHeading")}</h2>
					{addressing === "çaylak" ? (
						<>
							<p className="kp-welcome__line">
								{t("auth.welcome.caylakLine", {caylakNoun: t("auth.brand.caylak")})}
							</p>
							{promotionPath?.kind === "vouch-needed" ? (
								<div className="kp-welcome__vouch-needed" data-testid="welcome-vouch-needed">
									<p className="kp-welcome__vouch-message">{t(promotionPath.messageKey)}</p>
									<p className="kp-welcome__vouch-hint">{t(promotionPath.hintKey)}</p>
								</div>
							) : null}
							{promotionPath?.kind === "karma-bar" && standing ? (
								<Karma
									value={standing.karma}
									target={standing.bar}
									label={t("auth.welcome.karmaLabel")}
									testId="welcome-karma"
								/>
							) : null}
							{standing ? (
								<dl className="kp-welcome__facts">
									<div className="kp-welcome__fact">
										<dt className="kp-welcome__term">{t("auth.welcome.vouchTerm")}</dt>
										<dd className="kp-welcome__value" data-testid="welcome-vouch">
											{t(vouchExistsLabelKey(standing.vouchExists))}
										</dd>
									</div>
								</dl>
							) : null}
						</>
					) : addressing === "yazar" ? (
						<p className="kp-welcome__line" data-testid="welcome-yazar-note">
							{t("auth.welcome.yazarNote", {yazarNoun: t("auth.brand.yazar")})}
						</p>
					) : (
						<p className="kp-welcome__line">{t("auth.welcome.standingLoading")}</p>
					)}
				</section>

				{addressing !== "yazar" ? (
					<section className="kp-welcome__section" data-testid="welcome-rite">
						<h2 className="kp-welcome__heading">{t("auth.welcome.riteHeading")}</h2>
						<p className="kp-welcome__line">{t("auth.welcome.riteBody")}</p>
					</section>
				) : null}

				{nudge ? (
					<FirstContributionNudge
						nudge={nudge}
						onDismiss={() => {
							dismissFirstContribution(firstContributionStorage(), userId);
							if (userId !== null) setDismissLatch({userId, dismissed: true});
						}}
					/>
				) : null}

				<Button
					type="button"
					variant="primary"
					className="kp-welcome__continue"
					data-testid="welcome-continue"
					onClick={() => navigate(returnTo, {replace: true})}
				>
					{t("auth.welcome.continue")}
				</Button>
			</div>
		</main>
	);
}
