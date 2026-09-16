/**
 * The sözlük surface and the search-results page: `components/sozluk/*`, `SozlukHome`,
 * `SozlukTermPage`, `SearchPage`. Search rides in this file because it renders sözlük's own term
 * rows beside pano's cards and shares its counted nouns.
 */
export const sozluk = {
	"sozluk.entryCount.one": "{count} tanım",
	"sozluk.entryCount.other": "{count} tanım",
	"sozluk.voteCount.one": "{count} oy",
	"sozluk.voteCount.other": "{count} oy",

	"sozluk.alphabet.label": "Harf",
	"sozluk.alphabet.letterName": "{letter} harfi",
	"sozluk.alphabet.letterEmpty": "({letter} harfi, terim yok)",

	"sozluk.cta.newEntry": "yeni tanım",
	"sozluk.createDialog.title": "Yeni tanım",
	"sozluk.createDialog.description": "oluşturmak istediğin terimi yaz.",
	"sozluk.createDialog.termLabel": "Terim",
	"sozluk.createDialog.termPlaceholder": "terim…",
	"sozluk.createDialog.cancel": "vazgeç",
	"sozluk.createDialog.submit": "oluştur",
	// A punctuation-only term slugifies to "", and the composer is slug-addressed, so it has
	// nowhere to route — this is the error that replaced a silent no-op (#3789).
	"sozluk.createDialog.termUnslugifiable": "Terim en az bir harf ya da rakam içermeli.",

	"sozluk.home.title": "sözlük",
	"sozluk.home.loading": "yükleniyor…",
	"sozluk.home.loadFailedShort": "yüklenemedi",
	"sozluk.home.loadFailed": "sözlük yüklenemedi: {code}",
	"sozluk.home.recent": "son eklenenler",
	"sozluk.home.recentWindow": "24 sa",
	"sozluk.home.popular": "en çok oylananlar",
	"sozluk.home.popularWindow": "tüm zamanlar",
	"sozluk.home.noTerms": "henüz terim yok.",

	// The letter page (#9267) reads the WHOLE corpus for its letter, server-side, so it is the
	// first sözlük surface allowed to say "<letter> harfinde terim yok" — the #1669 ban held
	// only while a letter view was five loaded rows filtered client-side.
	"sozluk.letter.title": "{letter} harfi",
	"sozluk.letter.crumbRoot": "sözlük",
	"sozluk.letter.loading": "yükleniyor…",
	"sozluk.letter.loadFailed": "harf sayfası yüklenemedi: {code}",
	// Two count messages, because the page knows two different facts. With no next page the
	// loaded rows ARE the letter's whole set, so the plain count is true; while a `daha fazla`
	// button is still there, the letter holds more than the page has, so the copy says what it
	// counted rather than claiming a total the page never read (#9267).
	"sozluk.letter.termCount.one": "{count} terim",
	"sozluk.letter.termCount.other": "{count} terim",
	"sozluk.letter.termCountLoaded.one": "{count} terim yüklendi",
	"sozluk.letter.termCountLoaded.other": "{count} terim yüklendi",
	"sozluk.letter.empty": '"{letter}" harfiyle başlayan terim yok.',
	"sozluk.letter.emptyHint": "ilk tanımı sen yazarak bu harfi açabilirsin.",
	"sozluk.letter.loadMore": '"{letter}" harfinden daha fazla terim yükle',

	"sozluk.term.crumbRoot": "sözlük",
	"sozluk.term.firstAt": "ilk: {date}",
	"sozluk.term.lastEdit": "son düzenleme: {ago}",
	"sozluk.term.loading": "yükleniyor…",
	"sozluk.term.loadFailed": "terim yüklenemedi: {code}",
	"sozluk.term.notFoundTitle": "terim bulunamadı",
	"sozluk.term.notFoundMessage":
		'"{slug}" diye bir terim henüz yok. giriş yapıp ilk tanımı sen yazabilirsin.',
	"sozluk.term.noEntriesYet": "henüz tanım yok",
	"sozluk.term.newTermPrompt": '"{slug}" terimi henüz yok. ilk tanımı sen yazabilirsin.',

	"sozluk.composer.title": "sen nasıl tanımlardın?",
	"sozluk.composer.signInPrefix": "tanım eklemek için ",
	"sozluk.composer.signInLink": "giriş yap",
	"sozluk.composer.bodyLabel": "tanım",
	"sozluk.composer.bodyPlaceholder":
		"markdown destekli. ```js ... ``` kod bloğu için. kişisel deneyim, örnek, hatıra; kuru sözlük tanımı zaten Wikipedia'da var.",
	"sozluk.composer.hintPrefix": "markdown · ",
	"sozluk.composer.hintSubmit": "gönder",
	"sozluk.composer.cancel": "iptal",
	"sozluk.composer.submitting": "gönderiliyor…",
	"sozluk.composer.submit": "tanımı ekle",
	"sozluk.composer.bodyRequired": "tanım boş olamaz",
	"sozluk.composer.bodyTooLong": "tanım en fazla {max} karakter olabilir",
	"sozluk.composer.bodyTooLongCount": "tanım en fazla {max} karakter olabilir ({length})",
	"sozluk.composer.addFailed": "tanım eklenemedi",
	"sozluk.composer.actorFallback": "kullanıcı",

	"sozluk.definition.notFound": "tanım bulunamadı",
	"sozluk.definition.updateFailed": "tanım güncellenemedi",
	"sozluk.definition.deleteFailed": "tanım silinemedi",
	"sozluk.definition.voteSelfDisabled": "Kendi tanımına oy veremezsin",
	"sozluk.definition.retractVote": "Oyunu geri al",
	"sozluk.definition.upvote": "Yukarı oy",
	"sozluk.definition.editLabel": "tanımı düzenle",
	"sozluk.definition.cancel": "iptal",
	"sozluk.definition.saving": "kaydediliyor…",
	"sozluk.definition.save": "kaydet",
	"sozluk.definition.edit": "düzenle",
	"sozluk.definition.delete": "sil",
	"sozluk.definition.deleteTitle": "tanımı sil",
	"sozluk.definition.deleteDescription": "bu tanımı silmek istediğine emin misin? geri alınamaz.",
	"sozluk.definition.deleteCancel": "vazgeç",
	"sozluk.definition.deleting": "siliniyor…",

	"search.title": "arama",
	"search.searching": "aranıyor…",
	"search.failed": "arama yapılamadı: {code}",
	"search.minLength": "aramak için en az {min} harf girin.",
	"search.noResults": '"{query}" için sonuç yok.',
	"search.sozluk": "sözlük",
	"search.pano": "pano",
	"search.termCount.one": "{count} terim",
	"search.termCount.other": "{count} terim",
	"search.postCount.one": "{count} gönderi",
	"search.postCount.other": "{count} gönderi",
	"search.noTerms": "terim bulunamadı.",
	"search.noPosts": "gönderi bulunamadı.",
};

/** `tr` is the source of truth for the key set; `en/sozluk.ts` is checked against this. */
export type SozlukKey = keyof typeof sozluk;
