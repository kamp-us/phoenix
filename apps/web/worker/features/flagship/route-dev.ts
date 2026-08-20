/**
 * The dev-only flag-override settings page + its apply POST (#622).
 *
 * **HARD INVARIANT:** both verbs fail-closed to `404` unless
 * `environment === "development"`. The route is statically mounted, so the gate is
 * the only thing keeping it dark in a deployed stage; `ENVIRONMENT` defaults to
 * `"production"`. `makeRequestFlagsContext` uses the same gate to decide whether to
 * read the override cookie, so even a hand-set cookie is inert in prod.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

class RequestBodyReadError extends Schema.TaggedErrorClass<RequestBodyReadError>()(
	"flagship/RequestBodyReadError",
	{cause: Schema.Defect()},
) {}

const notInDevelopment = HttpServerResponse.text(
	"flag dev overrides are available only under `alchemy dev` (ENVIRONMENT=development)",
	{status: 404},
);

/** The fail-closed gate for this whole surface. */
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
	const text = yield* Effect.tryPromise({
		try: () => raw.text(),
		catch: (cause) => new RequestBodyReadError({cause}),
	}).pipe(Effect.orDie);
	const form = new URLSearchParams(text);
	const action = parseOverrideAction(form);
	const current = parseOverrideCookie(raw.headers.get("cookie"));
	const next = action ? applyOverride(current, action) : current;
	// `Path=/` because the flag reads happen on `/api/flags/evaluate`, not this path.
	// No `Secure` — local dev is plain http, and this surface is dev-only.
	const cookie = `${FLAG_OVERRIDE_COOKIE}=${encodeOverrideCookieValue(next)}; Path=/; SameSite=Lax`;
	return HttpServerResponse.redirect(DEV_ROUTE_PATH, {
		status: 303,
		headers: {"set-cookie": cookie},
	});
});

export const flagsDevApplyRoute = HttpRouter.add("POST", DEV_ROUTE_PATH, handleFlagsDevApply);

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

function toggle(key: string, state: "on" | "off" | "clear"): string {
	return `<form method="post" action="${DEV_ROUTE_PATH}">
	<input type="hidden" name="key" value="${escapeHtml(key)}" />
	<input type="hidden" name="state" value="${state}" />
	<button type="submit">${state}</button>
</form>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
