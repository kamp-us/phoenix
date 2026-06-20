/**
 * Dev-only flag-override settings surface (#622):
 *
 * - `GET  /api/flags/dev` — an HTML page listing the declared boolean flags with
 *   on / off / clear toggles, reflecting the current `phoenix_flag_overrides`
 *   cookie state.
 * - `POST /api/flags/dev` — applies one toggle (`key` + `state`) to the override
 *   map and replays it into the cookie, then redirects back to the page.
 *
 * **HARD INVARIANT (load-bearing, the #622 review's primary check):** both verbs
 * fail-closed to `404` unless `environment === "development"`. The route is
 * statically mounted (it lives in `worker-routes.ts` so the SPA-shadow glob can't
 * drift, #861), but it answers nothing in any deployed stage: `ENVIRONMENT`
 * defaults to `"production"` (`config.ts`), so an unset/any non-`development` env
 * never reaches the page or sets the cookie. This is the same gate
 * `makeRequestFlagsContext` uses to decide whether to read the override cookie at
 * all — so even a hand-set cookie is inert in prod.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {AppConfig} from "../../config.ts";
import {
	applyOverride,
	DEV_OVERRIDABLE_FLAGS,
	encodeOverrideCookieValue,
	FLAG_OVERRIDE_COOKIE,
	type FlagOverrides,
	parseOverrideAction,
	parseOverrideCookie,
} from "./dev-override.ts";

const DEV_ROUTE_PATH = "/api/flags/dev";

/** A `404` body that names why — the route exists but is dev-only. */
const notInDevelopment = HttpServerResponse.text(
	"flag dev overrides are available only under `alchemy dev` (ENVIRONMENT=development)",
	{status: 404},
);

/** Is this request running under local `alchemy dev`? The fail-closed gate for the whole surface. */
const isDevelopment = Effect.gen(function* () {
	const {environment} = yield* AppConfig.pipe(Effect.orDie);
	return environment === "development";
});

export const handleFlagsDevPage = Effect.gen(function* () {
	if (!(yield* isDevelopment)) return notInDevelopment;
	const raw = yield* Cloudflare.Request;
	const overrides = parseOverrideCookie(raw.headers.get("cookie"));
	return HttpServerResponse.text(renderDevPage(overrides), {
		contentType: "text/html; charset=utf-8",
	});
});

export const flagsDevPageRoute = HttpRouter.add("GET", DEV_ROUTE_PATH, handleFlagsDevPage);

export const handleFlagsDevApply = Effect.gen(function* () {
	if (!(yield* isDevelopment)) return notInDevelopment;
	const raw = yield* Cloudflare.Request;
	const form = new URLSearchParams(yield* Effect.promise(() => raw.text()));
	const action = parseOverrideAction(form);
	const current = parseOverrideCookie(raw.headers.get("cookie"));
	const next = action ? applyOverride(current, action) : current;
	// `Path=/` so the override cookie rides every request (the flag reads happen on
	// `/api/flags/evaluate`, not this path). `SameSite=Lax`; no `Secure` — local dev
	// is plain http. Dev-only, so no hardening beyond keeping it same-site.
	const cookie = `${FLAG_OVERRIDE_COOKIE}=${encodeOverrideCookieValue(next)}; Path=/; SameSite=Lax`;
	return HttpServerResponse.redirect(DEV_ROUTE_PATH, {
		status: 303,
		headers: {"set-cookie": cookie},
	});
});

export const flagsDevApplyRoute = HttpRouter.add("POST", DEV_ROUTE_PATH, handleFlagsDevApply);

/** Render the dev settings page — declared flags with their current override state + toggles. */
function renderDevPage(overrides: FlagOverrides): string {
	const rows = DEV_OVERRIDABLE_FLAGS.map((key) => renderRow(key, overrides[key])).join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>flag dev overrides</title>
<style>
	body { font: 15px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; }
	h1 { font-size: 1.3rem; }
	p { color: #555; }
	table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
	th, td { text-align: left; padding: 0.6rem 0.4rem; border-bottom: 1px solid #eee; }
	code { background: #f4f4f5; padding: 0.1rem 0.3rem; border-radius: 4px; }
	.state { font-weight: 600; }
	.on { color: #15803d; } .off { color: #b91c1c; } .none { color: #999; }
	form { display: inline; }
	button { font: inherit; padding: 0.2rem 0.6rem; margin-left: 0.3rem; cursor: pointer; }
</style>
</head>
<body>
<h1>flag dev overrides</h1>
<p>Local-only flag flips (#622). Forces a flag <strong>on</strong>/<strong>off</strong> for this browser under
<code>alchemy dev</code> — never reaches Flagship, inert in every deployed stage. <em>Clear</em> drops the override and the
real evaluator answers again.</p>
<table>
<thead><tr><th>flag</th><th>state</th><th>set</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;
}

/** One flag's row: its key, current override state, and the on/off/clear toggle forms. */
function renderRow(key: string, override: boolean | undefined): string {
	const state =
		override === undefined
			? `<span class="state none">— (real eval)</span>`
			: override
				? `<span class="state on">on</span>`
				: `<span class="state off">off</span>`;
	return `<tr>
	<td><code>${escapeHtml(key)}</code></td>
	<td>${state}</td>
	<td>${toggle(key, "on")}${toggle(key, "off")}${toggle(key, "clear")}</td>
</tr>`;
}

/** A single-button form that POSTs one `{key, state}` toggle back to the route. */
function toggle(key: string, state: "on" | "off" | "clear"): string {
	return `<form method="post" action="${DEV_ROUTE_PATH}">
	<input type="hidden" name="key" value="${escapeHtml(key)}" />
	<input type="hidden" name="state" value="${state}" />
	<button type="submit">${state}</button>
</form>`;
}

/** Escape a flag key for safe HTML interpolation (keys are code-declared, but cheap insurance). */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
