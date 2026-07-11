import {createContext, lazy, Suspense, useContext, useEffect, useMemo, useState} from "react";
import {
	Navigate,
	Outlet,
	Route,
	Routes,
	useLocation,
	useMatch,
	useNavigate,
	useParams,
} from "react-router";
import {authClient, clearBearerToken, useSession} from "./auth/client";
import {useMe} from "./auth/useMe";
import {useBildirimUnread} from "./components/bildirim/useBildirimUnread";
import {shouldShowDivanEntry} from "./components/divan/divanGating";
import {useDivanAccess} from "./components/divan/useDivanAccess";
import {AppShell, Main} from "./components/layout/AppShell";
import {Footer} from "./components/layout/Footer";
import {Topbar} from "./components/layout/Topbar";
import {actorLabel} from "./components/moderation/actor-identity";
import {EagerProfileContributionSkeleton} from "./components/profile/ProfileContributionSignal";
import {ToastProvider} from "./components/ui/Toast";
import {Provider as TooltipProvider} from "./components/ui/Tooltip";
import {FateProvider, PublicFateProvider} from "./fate/FateProvider";
import {teardownAuthedSnapshot} from "./fate/snapshot";
import {
	MECMUA_FEED,
	MECMUA_PUBLIC_READ,
	PHOENIX_AUTHORSHIP_LOOP,
	PHOENIX_BILDIRIM,
} from "./flags/keys";
import {useFlag} from "./flags/useFlag";
import {DensityProvider} from "./lib/density";
import {SAVED_HREF} from "./lib/panoNav";
import {safeReturnTo} from "./lib/returnTo";
import {searchTarget} from "./lib/searchTarget";
import {ThemeProvider, useTheme} from "./lib/theme";
import {AuthPage} from "./pages/AuthPage";
import {BildirimlerPage} from "./pages/BildirimlerPage";
import {DivanPage} from "./pages/DivanPage";
import {FunnelPage} from "./pages/FunnelPage";
import {LandingPage} from "./pages/LandingPage";
import {MecmuaDraftsPage} from "./pages/MecmuaDraftsPage";
import {MecmuaFeedPage} from "./pages/MecmuaFeedPage";
import {MecmuaIndexPage} from "./pages/MecmuaIndexPage";
import {MecmuaPostPage} from "./pages/MecmuaPostPage";
import {NotFoundPage} from "./pages/NotFoundPage";
import {PanoFeed} from "./pages/PanoFeed";
import {PanoPostDetail} from "./pages/PanoPostDetail";
import {PanoSubmitPage} from "./pages/PanoSubmitPage";
import {ProfilePage} from "./pages/ProfilePage";
import {SearchPage} from "./pages/SearchPage";
import {SozlukHome} from "./pages/SozlukHome";
import {SozlukTermPage} from "./pages/SozlukTermPage";
import {useUsernameResolutionPending} from "./pages/signupUsernameGate";
import {UsernameBootstrap} from "./pages/UsernameBootstrap";
import {UserProfilePage} from "./pages/UserProfilePage";
import {useProfileStats} from "./pages/useProfileStats";

/**
 * The fate-dependent topbar chips, computed below the session gate and read by the
 * always-painting shell frame above it. `null` is the pre-settle default — the frame
 * paints its static structure immediately with these absent, and they fill in once
 * `FateProvider` commits and `LayoutContent` publishes them. See #2160.
 */
type TopbarChips = {
	userProps: {user?: {name: string; username: string | null}};
	karma: number | undefined;
	divanTo: string | undefined;
	bildirim: {to: string; unread: number} | undefined;
};

/**
 * The bridge that carries the fate-dependent chips UP from `LayoutContent` (below the
 * session gate, where fate lives) to the always-painting shell frame (above it). The
 * frame owns the chip state and passes the setter down through this context; the
 * gated content sets it once fate settles. This lets the frame render once — no
 * remount of the shell on settle, only the chips fill in (#2160).
 */
const SetTopbarChipsContext = createContext<((chips: TopbarChips | null) => void) | null>(null);

/**
 * The always-painting shell frame. It reads only `useSession`/`useTheme`/routing —
 * NO fate client — so it renders on the first frame, before `/api/auth/get-session`
 * resolves, killing the blank first-paint flash (#2160). The fate-dependent chips
 * arrive later via the chip-state bridge, set by `LayoutContent` from below the
 * session gate; until then the topbar shows its signed-out/anonymous affordances.
 * The signed-in/out `actions` split rides `useSession` alone, so it is correct
 * immediately without waiting on fate.
 */
function Layout() {
	const session = useSession();
	const navigate = useNavigate();
	const location = useLocation();
	const {toggle: toggleTheme} = useTheme();
	const [chips, setChips] = useState<TopbarChips | null>(null);
	// The mecmua nav entry (#2512), dark behind `mecmua-public-read` — the same seam the
	// reader/index gate on. `useFlag` reads over `fetch` (no fate client), so it is safe in
	// this always-painting shell frame: the entry simply appears once the flag resolves on,
	// never blocking first paint (Pillar 1). Off ⇒ the nav is exactly as before.
	const {value: mecmuaOn} = useFlag(MECMUA_PUBLIC_READ, false);
	// The mecmua feed (akış) nav entry (#2547), dark behind its own `mecmua-feed` seam —
	// the SAME flag the `/mecmua/akis` route self-gates on (self-404 when off). Gating the
	// link on the route's own seam is what keeps it from ever pointing at a dark 404: off ⇒
	// no entry, so subscribing (also `mecmua-feed`) and its feed destination appear together.
	const {value: feedOn} = useFlag(MECMUA_FEED, false);

	// The two-tier fate provider's public first paint (ADR 0167). While `get-session`
	// is still in flight the authed `FateProvider` gate below returns null, so the
	// routed `/pano` feed can't paint. So for the anon-capable pano feed routes ONLY,
	// render an eager copy over the PUBLIC (always-anonymous) fate client above the gate
	// — it paints in parallel with `get-session` instead of serialized behind it. The
	// instant the session settles the gate commits, the authed feed (with live +
	// mutations) takes over, and this eager tier unmounts. This preserves #438 verbatim:
	// the router-bearing authed subtree still mounts only once, on the resolved identity
	// — the public client is a distinct, never-re-keyed instance, so there is no
	// anon→userId re-key remount of the authed tree.
	const panoMatch = useMatch("/pano");
	const panoSiteMatch = useMatch("/pano/site/:host");
	const eagerPanoHost = panoSiteMatch?.params.host;
	const showEagerPanoFeed = session.isPending && (panoMatch != null || panoSiteMatch != null);

	// The same two-tier decoupling (ADR 0167) extended to `/profile` (#2188): paint the
	// Katkıların skeleton above the gate while `get-session` resolves. Why it is a
	// skeleton (not anon data) and how it stays #438-safe with no fate client lives on
	// `EagerProfileContributionSkeleton`.
	const profileMatch = useMatch("/profile");
	const showEagerProfileSkeleton = session.isPending && profileMatch != null;

	// Echo the active query in the header input, but only on the results page — off
	// `/search` the box keeps its empty `ara…` placeholder (#2199).
	const searchQuery =
		location.pathname === "/search" ? (new URLSearchParams(location.search).get("q") ?? "") : "";

	async function onSignOut() {
		// Drop this identity's persisted feed snapshot at the sign-out seam BEFORE the
		// session clears — its private myVote/isSaved overlay must not outlive the session
		// (#2321). Capture the id first: signOut() nulls the session. The FateProvider
		// identity-change seam also tears down on the resulting A→anon transition; this
		// eager call makes the removal immediate on click rather than after the async settle.
		const signedOutUserId = session.data?.user.id;
		if (signedOutUserId) teardownAuthedSnapshot(signedOutUserId);
		await authClient.signOut();
		clearBearerToken();
	}

	const isSignedIn = !!session.data;

	return (
		<TooltipProvider>
			<ToastProvider>
				<AppShell>
					<Topbar
						brandName="kamp.us"
						nav={[
							{to: "/sozluk", label: "sözlük"},
							{to: "/pano", label: "pano"},
							...(mecmuaOn ? [{to: "/mecmua", label: "mecmua"}] : []),
							...(feedOn ? [{to: "/mecmua/akis", label: "akış"}] : []),
						]}
						divanTo={chips?.divanTo}
						{...(chips?.userProps ?? {})}
						karma={chips?.karma}
						{...(chips?.bildirim ? {bildirim: chips.bildirim} : {})}
						searchQuery={searchQuery}
						onSearchSubmit={(query) => {
							const target = searchTarget(query);
							if (target) navigate(target);
						}}
						onToggleTheme={toggleTheme}
						onLogout={onSignOut}
						actions={
							isSignedIn ? (
								<button
									type="button"
									className="kp-topbar__btn"
									onClick={() => navigate("/pano/yeni")}
								>
									+ gönderi
								</button>
							) : (
								<button type="button" className="kp-topbar__btn" onClick={() => navigate("/auth")}>
									giriş yap
								</button>
							)
						}
					/>
					<Main>
						{/* PUBLIC tier (ADR 0167): the anon-capable pano feed paints over the
						    always-anonymous public client while `get-session` resolves, then
						    hands off to the authed feed once the gate below commits. */}
						{showEagerPanoFeed ? (
							<PublicFateProvider>
								<PanoFeed {...(eagerPanoHost ? {host: eagerPanoHost} : {})} />
							</PublicFateProvider>
						) : null}
						{showEagerProfileSkeleton ? <EagerProfileContributionSkeleton /> : null}
						{/* The routed content + fate-dependent chips live below the session
						    gate — FateProvider keeps its #438 remount guard (first & only key
						    is the resolved identity), while the shell frame above already
						    painted. */}
						<FateProvider>
							<SetTopbarChipsContext.Provider value={setChips}>
								<LayoutContent />
							</SetTopbarChipsContext.Provider>
						</FateProvider>
					</Main>
					<Footer />
				</AppShell>
			</ToastProvider>
		</TooltipProvider>
	);
}

/**
 * Runs below `FateProvider` (so `useMe`/`useProfileStats`/`useDivanAccess`/
 * `useBildirimUnread` have a fate client): computes the auth-dependent topbar chips,
 * publishes them up to the shell frame via the chip-state bridge, and renders the
 * routed `Outlet`. Because `FateProvider` only commits once the session is settled,
 * this never mounts under an "anon" key (#438 preserved).
 */
function LayoutContent() {
	const session = useSession();
	const {me, refetch} = useMe();
	const navigate = useNavigate();
	const location = useLocation();
	const setChips = useContext(SetTopbarChipsContext);
	// Ambient self-karma in the topbar, dark behind the authorship-loop flag (#1208).
	// Gating the fetch on the flag keeps the flag-off path exactly as today: no flag →
	// null username → the read short-circuits off the wire (useProfileStats).
	const {value: authorshipLoop} = useFlag(PHOENIX_AUTHORSHIP_LOOP, false);
	const karmaState = useProfileStats(authorshipLoop ? me?.username : null);
	const selfKarma = karmaState.status === "ok" ? karmaState.stats.totalKarma : undefined;
	// The yazar/mod-only divan entry (#1290), dark behind the same authorship-loop
	// flag. `useDivanAccess` probes the server's gated read (yazar OR mod), so the
	// entry is server-authoritative — invisible to çaylak/visitor, absent when off.
	// `me` feeds the #2209 client short-circuit: a provably-denied çaylak/non-mod
	// skips the guaranteed-`UNAUTHORIZED` probe; the ambiguous case still probes.
	const divanAccess = useDivanAccess(me);
	const showDivan = shouldShowDivanEntry(authorshipLoop, divanAccess);
	// The bildirim entry + unread chip (#1694), dark behind the `phoenix-bildirim`
	// flag. Gating the fetch on flag+session keeps the flag-off path exactly as
	// today: disabled ⇒ the read never touches the wire and reports 0.
	const {value: bildirimOn} = useFlag(PHOENIX_BILDIRIM, false);
	const bildirimUnread = useBildirimUnread(bildirimOn && !!session.data, me?.id ?? null);
	// #1888: hold the off-/auth redirect while a chosen-username signup is still
	// resolving. `signUp.email` establishes the session before the separate
	// `setUsername` lands; without this hold the redirect unmounts AuthPage and
	// buries a setUsername failure, silently dropping the chosen handle into the
	// email-prefill bootstrap.
	const usernamePending = useUsernameResolutionPending();

	useEffect(() => {
		if (!session.data) return;
		if (location.pathname !== "/auth") return;
		if (usernamePending) return;
		// AuthPage sets `?returnTo=<path>` when redirected from a signed-out
		// write affordance (T17). Honor it (sanitized to same-origin) so the
		// user lands back on the page that triggered the auth flow.
		const params = new URLSearchParams(location.search);
		const target = safeReturnTo(params.get("returnTo"));
		navigate(target, {replace: true});
	}, [session.data, location.pathname, location.search, navigate, usernamePending]);

	const sessionUser = session.data?.user;
	// The topbar identity, routed through the shared actor-label rule (#2126):
	// display name, falling back to the @username, never the email local-part the
	// old `email.split("@")[0]` leaked into the visible name.
	const username = me?.username ?? null;
	const isSignedIn = !!session.data;
	const needsBootstrap = isSignedIn && me !== null && !me.username && location.pathname !== "/auth";

	const chips = useMemo<TopbarChips>(
		() => ({
			userProps: sessionUser
				? {
						user: {
							name: actorLabel(me?.name ?? sessionUser.name, username, "kullanıcı"),
							username,
						},
					}
				: {},
			karma: selfKarma,
			divanTo: showDivan ? "/divan" : undefined,
			bildirim: bildirimOn && isSignedIn ? {to: "/bildirimler", unread: bildirimUnread} : undefined,
		}),
		[sessionUser, me?.name, username, selfKarma, showDivan, bildirimOn, isSignedIn, bildirimUnread],
	);

	// Publish the computed chips up to the shell frame; clear them on unmount (the
	// signed-out/re-key transition) so the frame falls back to anonymous affordances.
	useEffect(() => {
		setChips?.(chips);
		return () => setChips?.(null);
	}, [chips, setChips]);

	return needsBootstrap && sessionUser ? (
		<UsernameBootstrap email={sessionUser.email} onComplete={refetch} />
	) : (
		<Outlet />
	);
}

function PanoSiteFeedRoute() {
	const {host} = useParams<{host: string}>();
	return <PanoFeed {...(host ? {host} : {})} />;
}

// The composer routes are the SPA's only `@kampus/composer` (tiptap/ProseMirror) consumers,
// so lazy-loading both keeps that heavy editor payload out of the entry chunk every public
// route pays for — the performance-pillar fix of #2523. Named-export → default shim for React.lazy.
const LabComposerPage = lazy(() =>
	import("./pages/LabComposerPage").then((m) => ({default: m.LabComposerPage})),
);
const MecmuaEditorPage = lazy(() =>
	import("./pages/MecmuaEditorPage").then((m) => ({default: m.MecmuaEditorPage})),
);

function ComposerRouteFallback() {
	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<p>yükleniyor…</p>
			</div>
		</div>
	);
}

export function App() {
	return (
		<ThemeProvider>
			<DensityProvider>
				<Routes>
					<Route element={<Layout />}>
						<Route path="/" element={<LandingPage />} />
						<Route path="/pano" element={<PanoFeed />} />
						<Route path="/pano/yeni" element={<PanoSubmitPage />} />
						<Route path="/pano/site/:host" element={<PanoSiteFeedRoute />} />
						{/* kaydedilenler folded into PanoFeed as the `?sort=saved` variant (#2196);
						    the legacy bespoke route redirects so existing links don't break. */}
						<Route path="/pano/kaydedilenler" element={<Navigate to={SAVED_HREF} replace />} />
						<Route path="/pano/:id" element={<PanoPostDetail />} />
						{/* mecmua — each page self-gates on its flag (off ⇒ 404), so these routes
						    are dark by default: the public index (#2512) + reader (#2498) on
						    mecmua-public-read, the subscribed-author feed (#2500) on mecmua-feed, the
						    authoring page (#2499), the id-addressable draft load + the drafts list
						    (#2544) on mecmua-write. The static/`yaz`-prefixed paths out-rank the
						    `/mecmua/:slug` reader below them. */}
						<Route path="/mecmua" element={<MecmuaIndexPage />} />
						<Route path="/mecmua/akis" element={<MecmuaFeedPage />} />
						<Route path="/mecmua/yazilarim" element={<MecmuaDraftsPage />} />
						<Route
							path="/mecmua/yaz"
							element={
								<Suspense fallback={<ComposerRouteFallback />}>
									<MecmuaEditorPage />
								</Suspense>
							}
						/>
						<Route
							path="/mecmua/yaz/:id"
							element={
								<Suspense fallback={<ComposerRouteFallback />}>
									<MecmuaEditorPage />
								</Suspense>
							}
						/>
						<Route path="/mecmua/:slug" element={<MecmuaPostPage />} />
						<Route path="/sozluk" element={<SozlukHome />} />
						<Route path="/sozluk/:slug" element={<SozlukTermPage />} />
						<Route path="/search" element={<SearchPage />} />
						<Route path="/auth" element={<AuthPage />} />
						{/* The divan reviewer workspace (#1290) — the page self-gates on the
					    authorship-loop flag (off ⇒ 404), so the route is dark by default. */}
						<Route path="/divan" element={<DivanPage />} />
						{/* The founder/mod conversion readout (#1589) — the page self-gates on
					    the funnel-readout flag (off ⇒ 404), so the route is dark by default. */}
						<Route path="/funnel" element={<FunnelPage />} />
						{/* The notification center (#1694) — the page self-gates on the
					    phoenix-bildirim flag (off ⇒ 404), so the route is dark by default. */}
						<Route path="/bildirimler" element={<BildirimlerPage />} />
						{/* /lab/composer — throwaway tiptap spike (#2465), reachable by URL only,
						    no nav entry; deletable when the rich-composer phase begins. */}
						<Route
							path="/lab/composer"
							element={
								<Suspense fallback={<ComposerRouteFallback />}>
									<LabComposerPage />
								</Suspense>
							}
						/>
						<Route path="/profile" element={<ProfilePage />} />
						<Route path="/u/:username" element={<UserProfilePage />} />
						<Route path="*" element={<NotFoundPage />} />
					</Route>
				</Routes>
			</DensityProvider>
		</ThemeProvider>
	);
}
