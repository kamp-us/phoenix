import {useEffect, useState} from "react";
import {Outlet, Route, Routes, useLocation, useNavigate} from "react-router";
import {authClient, clearBearerToken, useSession} from "./auth/client";
import {AppShell, Main} from "./components/layout/AppShell";
import {Footer} from "./components/layout/Footer";
import {Topbar} from "./components/layout/Topbar";
import {Provider as TooltipProvider} from "./components/ui/Tooltip";
import {COMMENTS, LANDING_TERMS, POSTS, SOZLUK_POPULAR, SOZLUK_RECENT, SOZLUK_TERM_PAGES} from "./fixtures";
import {AuthPage} from "./pages/AuthPage";
import {LandingPage} from "./pages/LandingPage";
import {PanoCreateDialog} from "./pages/PanoCreateDialog";
import {PanoFeed} from "./pages/PanoFeed";
import {PanoPostDetail} from "./pages/PanoPostDetail";
import {SozlukHome} from "./pages/SozlukHome";
import {SozlukTermPage} from "./pages/SozlukTermPage";

type Mode = "dark" | "light";

function Layout() {
	const session = useSession();
	const navigate = useNavigate();
	const location = useLocation();
	const [mode, setMode] = useState<Mode>("dark");
	const [createOpen, setCreateOpen] = useState(false);

	useEffect(() => {
		document.documentElement.dataset.theme = mode;
	}, [mode]);

	useEffect(() => {
		if (session.data && location.pathname === "/auth") navigate("/", {replace: true});
	}, [session.data, location.pathname, navigate]);

	async function onSignOut() {
		await authClient.signOut();
		clearBearerToken();
	}

	const userProps = session.data?.user
		? {user: {name: session.data.user.name ?? session.data.user.email.split("@")[0] ?? "user"}}
		: {};
	const isSignedIn = !!session.data;

	return (
		<TooltipProvider>
			<AppShell>
				<Topbar
					brandName="kamp.us"
					nav={[
						{to: "/sozluk", label: "sözlük"},
						{to: "/pano", label: "pano"},
					]}
					{...userProps}
					onToggleTheme={() => setMode(mode === "dark" ? "light" : "dark")}
					onLogout={onSignOut}
					actions={
						isSignedIn ? (
							<button
								type="button"
								className="kp-topbar__btn"
								onClick={() => setCreateOpen(true)}
							>
								+ gönderi
							</button>
						) : (
							<button
								type="button"
								className="kp-topbar__btn"
								onClick={() => navigate("/auth")}
							>
								giriş yap
							</button>
						)
					}
				/>
				<Main>
					<Outlet />
				</Main>
				<Footer />
				<PanoCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
			</AppShell>
		</TooltipProvider>
	);
}

function PanoDetailRoute() {
	const post = POSTS[0];
	if (!post) return null;
	return <PanoPostDetail post={post} comments={COMMENTS} />;
}

export function App() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route path="/" element={<LandingPage posts={POSTS} terms={LANDING_TERMS} />} />
				<Route path="/pano" element={<PanoFeed posts={POSTS} />} />
				<Route path="/pano/:id" element={<PanoDetailRoute />} />
				<Route path="/sozluk" element={<SozlukHome recent={SOZLUK_RECENT} popular={SOZLUK_POPULAR} />} />
				<Route path="/sozluk/:slug" element={<SozlukTermPage terms={SOZLUK_TERM_PAGES} />} />
				<Route path="/auth" element={<AuthPage />} />
			</Route>
		</Routes>
	);
}
