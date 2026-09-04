/** The mecmua surface: the subnav zone, the index, the feed, the drafts list, the editor and the reader. */
export const mecmua = {
	"mecmua.loading": "yükleniyor…",
	"mecmua.cta.newPost": "yeni yazı",
	"mecmua.nav.discover": "keşfet",
	"mecmua.nav.feed": "akış",
	"mecmua.nav.myPosts": "yazılarım",

	"mecmua.subscribe.subscribe": "abone ol",
	"mecmua.subscribe.following": "takip ediliyor",
	"mecmua.subscribe.leave": "bırak",
	"mecmua.subscribe.error.subscribe": "abone olunamadı, tekrar dene.",
	"mecmua.subscribe.error.unsubscribe": "abonelikten çıkılamadı, tekrar dene.",
	"mecmua.subscribe.error.generic": "bir şeyler ters gitti, tekrar dene.",

	"mecmua.index.title": "mecmua",
	"mecmua.index.lede": "topluluğun uzun yazıları",
	"mecmua.index.error": "yazılar yüklenemedi, tekrar dene.",
	"mecmua.index.empty.title": "henüz yazı yok",
	"mecmua.index.empty.description": "ilk mecmua yazısı yayımlandığında burada görünecek.",

	"mecmua.feed.title": "mecmua",
	"mecmua.feed.lede": "takip ettiğin yazarların son yazıları.",
	"mecmua.feed.error": "akış yüklenemedi: {code}",
	"mecmua.feed.empty.title": "henüz akışında yazı yok",
	"mecmua.feed.empty.description": "birkaç yazar takip et, yazıları burada belirsin.",

	"mecmua.drafts.title": "yazılarım",
	"mecmua.drafts.lede": "taslakların ve yayımladığın yazılar.",
	"mecmua.drafts.error": "yazılar yüklenemedi: {code}",
	"mecmua.drafts.empty.title": "henüz yazın yok",
	"mecmua.drafts.empty.description": "yeni bir yazıya başla; taslakların burada birikir.",
	"mecmua.drafts.untitled": "(başlıksız taslak)",
	"mecmua.drafts.published": "yayımlandı",
	"mecmua.drafts.draft": "taslak",

	"mecmua.editor.title.new": "yeni yazı",
	"mecmua.editor.title.edit": "yazıyı düzenle",
	"mecmua.editor.myPosts": "yazılarım",
	"mecmua.editor.backToMyPosts": "yazılarıma dön",
	"mecmua.editor.draftNotFound": "taslak bulunamadı.",
	"mecmua.editor.lede":
		"uzun biçimli bir yazı yaz. istediğin an taslak olarak kaydet; hazır olunca yayımla.",
	"mecmua.editor.field.title": "başlık",
	"mecmua.editor.field.titlePlaceholder": "yazının başlığı",
	"mecmua.editor.field.body": "metin",
	"mecmua.editor.action.saveDraft": "taslak kaydet",
	"mecmua.editor.action.publish": "yayımla",
	"mecmua.editor.notice.draftSaved": "taslak kaydedildi",
	"mecmua.editor.notice.published": "yazın yayımlandı",
	"mecmua.editor.error.saveDraft": "taslak kaydedilemedi",
	"mecmua.editor.error.publish": "yazı yayımlanamadı",

	"mecmua.gate.signedIn":
		"yayımlamak için yazar olman gerekiyor — çaylakların yazıları henüz yayımlanamaz.",
	"mecmua.gate.signedOut": "yayımlamak için giriş yapıp yazar olman gerekiyor.",

	"mecmua.post.notFound.title": "yazı bulunamadı",
	"mecmua.post.notFound.message":
		'"{slug}" diye bir yazı bulamadık. başka bir şeye bakmak ister misin?',
	"mecmua.post.error": "yazı yüklenemedi, tekrar dene.",
};

/** `tr` is the source of truth for the key set; `en/mecmua.ts` is checked against this. */
export type MecmuaKey = keyof typeof mecmua;
