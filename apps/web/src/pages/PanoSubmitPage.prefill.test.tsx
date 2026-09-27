/**
 * The submit form's metadata prefill, driven through the page with the response held open
 * (#7859). Only `useLinkMetadata` is mocked — the prefill rule itself is the real module,
 * because what is under test is which value the page hands it, and a test that calls the
 * rule directly cannot see that.
 */

import {ToastProvider} from "@kampus/design";
import {act, fireEvent, render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {useSession as useSessionType} from "../auth/client";
import {LocaleProvider} from "../i18n";
import type {LinkMetadata} from "../lib/useLinkMetadata";
import {PREFILL_MAX_LEN} from "../lib/useLinkMetadata";
import {PanoSubmitPage} from "./PanoSubmitPage";

type SessionResult = ReturnType<typeof useSessionType>;

let releaseMetadata: (meta: LinkMetadata) => void;
let pending: Promise<LinkMetadata>;

vi.mock("react-fate", () => ({
	useLiveView: () => ({}),
	useFateClient: () => ({mutations: {}}),
	view: () => () => ({}),
}));

vi.mock("../auth/client", () => ({
	useSession: (): SessionResult =>
		({data: {user: {id: "u1", name: "Elif"}}, isPending: false}) as SessionResult,
}));

vi.mock("../components/authorship/FirstContributionOnramp", () => ({
	FirstContributionOnramp: () => null,
}));

vi.mock("../lib/useLinkMetadata", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/useLinkMetadata")>()),
	useLinkMetadata: () => ({loading: false, fetchMetadata: () => pending}),
}));

function field(testId: string): HTMLInputElement | HTMLTextAreaElement {
	const el = screen.getByTestId(testId);
	if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
	const inner = el.querySelector("input, textarea");
	if (inner instanceof HTMLInputElement || inner instanceof HTMLTextAreaElement) return inner;
	throw new Error(`no field control under ${testId}`);
}

const type = (testId: string, value: string) => fireEvent.change(field(testId), {target: {value}});

/** Paste a URL and tab out of it — the blur is what starts the fetch. */
function startFetch() {
	type("pano-submit-url", "https://example.com/a");
	fireEvent.blur(field("pano-submit-url"));
}

const resolveWith = (meta: LinkMetadata) => act(async () => releaseMetadata(meta));

function mount() {
	render(
		<MemoryRouter>
			<ToastProvider>
				<LocaleProvider>
					<PanoSubmitPage />
				</LocaleProvider>
			</ToastProvider>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	window.localStorage.clear();
	pending = new Promise<LinkMetadata>((resolve) => {
		releaseMetadata = resolve;
	});
	mount();
});

afterEach(() => vi.clearAllMocks());

describe("metadata that lands after the person started typing", () => {
	it("keeps both entered values", async () => {
		startFetch();
		type("pano-submit-title", "my own title");
		type("pano-submit-body", "my own note");

		await resolveWith({title: "Fetched Title", description: "Fetched description"});

		expect(field("pano-submit-title").value).toBe("my own title");
		expect(field("pano-submit-body").value).toBe("my own note");
	});

	it("fills only the field left blank, per field", async () => {
		startFetch();
		type("pano-submit-title", "my own title");

		await resolveWith({title: "Fetched Title", description: "Fetched description"});

		expect(field("pano-submit-title").value).toBe("my own title");
		expect(field("pano-submit-body").value).toBe("Fetched description");
	});

	it("fills a field holding only whitespace, clamps it, and leaves it editable", async () => {
		startFetch();
		type("pano-submit-title", "   ");

		await resolveWith({title: "T".repeat(PREFILL_MAX_LEN + 50)});

		const title = field("pano-submit-title");
		expect(title.value).toBe("T".repeat(PREFILL_MAX_LEN));

		type("pano-submit-title", "typed over it");
		expect(field("pano-submit-title").value).toBe("typed over it");
	});

	it("leaves both fields alone when the response carries no metadata", async () => {
		startFetch();
		type("pano-submit-body", "my own note");

		await resolveWith({});

		expect(field("pano-submit-title").value).toBe("");
		expect(field("pano-submit-body").value).toBe("my own note");
	});
});
