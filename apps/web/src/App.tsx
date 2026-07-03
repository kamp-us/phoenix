import {useEffect} from "react";
import {Outlet, Route, Routes, useLocation, useNavigate, useParams} from "react-router";
import {authClient, clearBearerToken, useSession} from "./auth/client";
import {useMe} from "./auth/useMe";
import {useBildirimUnread} from "./components/bildirim/useBildirimUnread";
import {shouldShowDivanEntry} from "./components/divan/divanGating";
import {useDivanAccess} from "./components/divan/useDivanAccess";
import {AppShell, Main} from "./components/layout/AppShell";
import {Footer} from "./components/layout/Footer";
import {Topbar} from "./components/layout/Topbar";
import {ToastProvider} from "./components/ui/Toast";
import {Provider as TooltipProvider} from "./components/ui/Tooltip";
import {PHOENIX_AUTHORSHIP_LOOP, PHOENIX_BILDIRIM} from "./flags/keys";
import {useFlag} from "./flags/useFlag";
import {safeReturnTo} from "./lib/returnTo";
import {searchTarget} from "./lib/searchTarget";
import {ThemeProvider, useTheme} from "./lib/theme";
import {AuthPage} from "./pages/AuthPage";
import {BildirimlerPage} from "./pages/BildirimlerPage";
import {DivanPage} from "./pages/DivanPage";
import {FunnelPage} from "./pages/FunnelPage";
import {LandingPage} from "./pages/LandingPage";
import {NotFoundPage} from "./pages/NotFoundPage";
import {PanoFeed} from "./pages/PanoFeed";
import {PanoPostDetail} from "./pages/PanoPostDetail";
import {PanoSubmitPage} from "./pages/PanoSubmitPage";
import {ProfilePage} from "./pages/ProfilePage";
import {SavedPostsPage} from "./pages/SavedPostsPage";
import {SearchPage} from "./pages/SearchPage";
import {SozlukHome} from "./pages/SozlukHome";
import {SozlukTermPage} from "./pages/SozlukTermPage";
import {useUsernameResolutionPending} from "./pages/signupUsernameGate";
import {UsernameBootstrap} from "./pages/UsernameBootstrap";
import {UserProfilePage} from "./pages/UserProfilePage";
import {useProfileStats} from "./pages/useProfileStats";

function Layout() {
	const session = useSession();
	const {me, refetch} = useMe();
	const navigate = useNavigate();
	const location = useLocation();
	const {toggle: toggleTheme} = useTheme();
	// Ambient self-karma in the topbar, dark behind the authorship-loop flag (#1208).
	// Gating the fetch on the flag keeps the flag-off path exactly as today: no flag →
	// null username → the read short-circuits off the wire (useProfileStats).
	const {value: authorshipLoop} = useFlag(PHOENIX_AUTHORSHIP_LOOP, false);
	const karmaState = useProfileStats(authorshipLoop ? me?.username : null);
	const selfKarma = karmaState.status === "ok" ? karmaState.stats.totalKarma : undefined;
	// The yazar/mod-only divan entry (#1290), dark behind the same authorship-loop
	// flag. `useDivanAccess` probes the server's gated read (yazar OR mod), so the
	// entry is server-authoritative — invisible to çaylak/visitor, absent when off.
	const divanAccess = useDivanAccess();
	const showDivan = shouldShowDivanEntry(authorshipLoop, divanAccess);
	// The bildirim entry + unread chip (#1694), dark behind the `phoenix-bildirim`
	// flag. Gating the fetch on flag+session keeps the flag-off path exactly as
	// today: disabled ⇒ the read never touches the wire and reports 0.
	const {value: bildirimOn} = useFlag(PHOENIX_BILDIRIM, false);
	const bildirimUnread = useBildirimUnread(bildirimOn && !!session.data);
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

	async function onSignOut() {
		await authClient.signOut();
		clearBearerToken();
	}

	const sessionUser = session.data?.user;
	const fallbackName = sessionUser
		? (sessionUser.name ?? sessionUser.email.split("@")[0] ?? "user")
		: "";
	const userProps = sessionUser
		? {
				user: {
					name: me?.name ?? fallbackName,
					username: me?.username ?? null,
				},
			}
		: {};
	const isSignedIn = !!session.data;
	// Bootstrap is required when the session is established but the canonical
	// user row in Pasaport has no username yet. Block the page content until
	// the form is submitted — set-once write so this only happens on first
	// sign-in.
	const needsBootstrap = isSignedIn && me !== null && !me.username && location.pathname !== "/auth";

	return (
		<TooltipProvider>
			<ToastProvider>
				<AppShell>
					<Topbar
						brandName="kamp.us"
						nav={[
							{to: "/sozluk", label: "sözlük"},
							{to: "/pano", label: "pano"},
						]}
						divanTo={showDivan ? "/divan" : undefined}
						{...userProps}
						karma={selfKarma}
						{...(bildirimOn && isSignedIn
							? {bildirim: {to: "/bildirimler", unread: bildirimUnread}}
							: {})}
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
						{needsBootstrap && sessionUser ? (
							<UsernameBootstrap email={sessionUser.email} onComplete={refetch} />
						) : (
							<Outlet />
						)}
					</Main>
					<Footer />
				</AppShell>
			</ToastProvider>
		</TooltipProvider>
	);
}

function PanoSiteFeedRoute() {
	const {host} = useParams<{host: string}>();
	return <PanoFeed {...(host ? {host} : {})} />;
}

export function App() {
	return (
		<ThemeProvider>
			<Routes>
				<Route element={<Layout />}>
					<Route path="/" element={<LandingPage />} />
					<Route path="/pano" element={<PanoFeed />} />
					<Route path="/pano/yeni" element={<PanoSubmitPage />} />
					<Route path="/pano/site/:host" element={<PanoSiteFeedRoute />} />
					<Route path="/pano/kaydedilenler" element={<SavedPostsPage />} />
					<Route path="/pano/:id" element={<PanoPostDetail />} />
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
					<Route path="/profile" element={<ProfilePage />} />
					<Route path="/u/:username" element={<UserProfilePage />} />
					<Route path="*" element={<NotFoundPage />} />
				</Route>
			</Routes>
		</ThemeProvider>
	);
}
