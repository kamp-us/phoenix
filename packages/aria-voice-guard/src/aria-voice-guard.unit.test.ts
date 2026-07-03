import {assert, describe, it} from "@effect/vitest";
import {findDrift, firstCasedIsUpper, toLowerVoice} from "./aria-voice-guard.ts";

describe("firstCasedIsUpper — Turkish-locale casing correctness", () => {
	it("flags a plainly Title-Case ASCII word", () => {
		assert.isTrue(firstCasedIsUpper("Kapat"));
		assert.isTrue(firstCasedIsUpper("Yukarı oy"));
	});

	it("does not flag an already-lowercase word", () => {
		assert.isFalse(firstCasedIsUpper("kapat"));
		assert.isFalse(firstCasedIsUpper("yukarı oy"));
	});

	// The dotted-İ: its Turkish lowercase is "i" (no combining dot). A naive
	// toLowerCase() would emit "i̇" — this asserts the guard uses the tr locale.
	it("flags a dotted-İ Title-Case word and lowercases it correctly", () => {
		assert.isTrue(firstCasedIsUpper("İletişim"));
		assert.equal(toLowerVoice("İletişim"), "iletişim");
	});

	// The dotless-I trap: "I" lowercases to "ı" in Turkish, so a Title-Case
	// "Istanbul" must lowercase to "ıstanbul" (NOT "istanbul"). This is the exact
	// false-transform a naive toLowerCase() commits.
	it("flags a dotless-I Title-Case word and lowercases it the Turkish way", () => {
		assert.isTrue(firstCasedIsUpper("Istanbul"));
		assert.equal(toLowerVoice("Istanbul"), "ıstanbul");
	});

	// A correctly-lowercased Turkish string that begins with a dotless-ı (a letter
	// with a case distinction but already lowercase) must NOT false-positive.
	it("does not flag a lowercase word starting with dotless-ı", () => {
		assert.isFalse(firstCasedIsUpper("ışık"));
	});

	// A lowercase word starting with dotted-i (i → İ uppercase) must not false-positive.
	it("does not flag a lowercase word starting with dotted-i", () => {
		assert.isFalse(firstCasedIsUpper("iletişim"));
	});

	it("skips leading case-less characters and decides on the first cased letter", () => {
		assert.isTrue(firstCasedIsUpper("⋯ Daha fazla")); // symbol + space, then Title-Case
		assert.isFalse(firstCasedIsUpper("3 bildirim")); // digit + space, then lowercase
	});

	it("never flags an all-caseless string", () => {
		assert.isFalse(firstCasedIsUpper("⋯"));
		assert.isFalse(firstCasedIsUpper("123"));
		assert.isFalse(firstCasedIsUpper("—"));
	});

	it("flags Turkish special-letter Title-Case leads (Ç, Ş, Ö, Ü, Ğ)", () => {
		assert.isTrue(firstCasedIsUpper("Çıkış"));
		assert.isTrue(firstCasedIsUpper("Şey"));
		assert.isTrue(firstCasedIsUpper("Öneri"));
		assert.isTrue(firstCasedIsUpper("Üye"));
		assert.isTrue(firstCasedIsUpper("Ğ-lead")); // synthetic — case machinery only
		assert.equal(toLowerVoice("Çıkış"), "çıkış");
	});
});

describe("findDrift — aria-label surface", () => {
	it("flags a Title-Case string-literal aria-label", () => {
		const found = findDrift('<button aria-label="Kapat" />');
		assert.equal(found.length, 1);
		assert.deepEqual(found[0], {line: 1, kind: "aria-label", text: "Kapat", suggestion: "kapat"});
	});

	it("passes a lowercase aria-label", () => {
		assert.equal(findDrift('<button aria-label="kapat" />').length, 0);
	});

	it("flags a braced string-literal aria-label", () => {
		const found = findDrift('<nav aria-label={"Harf"} />');
		assert.equal(found.length, 1);
		assert.equal(found[0]?.text, "Harf");
	});

	it("flags BOTH branches of a Title-Case ternary aria-label", () => {
		const found = findDrift('<b aria-label={open ? "Daralt" : "Genişlet"} />');
		assert.equal(found.length, 2);
		assert.deepEqual(
			found.map((f) => f.text),
			["Daralt", "Genişlet"],
		);
	});

	it("flags only the drifting branch of a mixed ternary", () => {
		const found = findDrift('<b aria-label={voted ? "oyunu geri al" : "Yukarı oy"} />');
		assert.equal(found.length, 1);
		assert.equal(found[0]?.text, "Yukarı oy");
	});

	// A dynamic aria-label with NO string literal is out of scope — the visible
	// voice of interpolated data is not this guard's concern.
	it("ignores a fully-dynamic aria-label expression", () => {
		assert.equal(findDrift("<b aria-label={someLabel} />").length, 0);
		// The `${n}` is deliberate JSX-source fixture text, not a real template placeholder.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture models source under scan
		assert.equal(findDrift("<b aria-label={`${n} bildirim`} />").length, 0);
	});

	// A lowercase-leading string literal inside an otherwise-interpolated aria-label
	// (`${count} okunmamış bildirim`) must not be flagged.
	it("ignores a lowercase literal inside a template aria-label", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture models source under scan
		assert.equal(findDrift("<b aria-label={`${n} okunmamış bildirim`} />").length, 0);
	});

	it("reports the correct line number", () => {
		const src = 'x\ny\n<button aria-label="Ara" />';
		const found = findDrift(src);
		assert.equal(found[0]?.line, 3);
	});
});

describe("findDrift — persistent menu-item surface", () => {
	it("flags a single-line Title-Case menu item", () => {
		const found = findDrift("<Menu.Item onClick={f}>Ayarlar</Menu.Item>");
		assert.equal(found.length, 1);
		assert.deepEqual(found[0], {
			line: 1,
			kind: "menu-item",
			text: "Ayarlar",
			suggestion: "ayarlar",
		});
	});

	it("passes a lowercase single-line menu item", () => {
		assert.equal(findDrift("<Menu.Item onClick={f}>ayarlar</Menu.Item>").length, 0);
	});

	it("flags a multi-line Title-Case menu item", () => {
		const src = ["<Menu.Item", '  data-testid="x"', ">", "  Profil", "</Menu.Item>"].join("\n");
		const found = findDrift(src);
		assert.equal(found.length, 1);
		assert.equal(found[0]?.text, "Profil");
		assert.equal(found[0]?.kind, "menu-item");
	});

	it("ignores a menu item whose child is an expression", () => {
		assert.equal(findDrift("<Menu.Item>{label}</Menu.Item>").length, 0);
		const src = ["<Menu.Item", ">", "  {DENSITY_LABELS[d]}", "</Menu.Item>"].join("\n");
		assert.equal(findDrift(src).length, 0);
	});
});

describe("findDrift — the issue #1670 corpus (regression floor)", () => {
	it("flags every Title-Case sample the audit listed", () => {
		const samples = [
			'<x aria-label="Kapat" />',
			'<x aria-label="Bildirimler" />',
			'<x aria-label="Ara" />',
			'<x aria-label="Yukarı oy" />',
			'<x aria-label="Daha fazla" />',
			'<x aria-label="Renk teması" />',
			'<x aria-label="Yoğunluk" />',
			'<x aria-label="Renk modu" />',
			'<x aria-label="Harf" />',
			'<x aria-label="Terim ara" />',
			"<Menu.Item>Profil</Menu.Item>",
			"<Menu.Item>Ayarlar</Menu.Item>",
			"<Menu.Item>Çıkış</Menu.Item>",
		];
		for (const s of samples) {
			assert.isAtLeast(findDrift(s).length, 1, `expected drift in: ${s}`);
		}
	});

	it("passes the lowercased forms of the whole corpus", () => {
		const fixed = [
			'<x aria-label="kapat" />',
			'<x aria-label="bildirimler" />',
			'<x aria-label="ara" />',
			'<x aria-label="yukarı oy" />',
			'<x aria-label="daha fazla" />',
			'<x aria-label="renk teması" />',
			'<x aria-label="yoğunluk" />',
			'<x aria-label="renk modu" />',
			'<x aria-label="harf" />',
			'<x aria-label="terim ara" />',
			"<Menu.Item>profil</Menu.Item>",
			"<Menu.Item>ayarlar</Menu.Item>",
			"<Menu.Item>çıkış</Menu.Item>",
		];
		for (const s of fixed) {
			assert.equal(findDrift(s).length, 0, `expected clean: ${s}`);
		}
	});
});
