/**
 * The entry surfaces: `AuthPage`, `UsernameBootstrap`, `WelcomePage`, `LandingPage` and the
 * `FirstContributionOnramp` nudge — the screens a reader meets on the way in (#7528).
 *
 * `auth.brand.*` are the brand nouns these screens name (ADR 0347): keys rather than literals so
 * no copy sits outside the catalog, with the same value in both locales.
 *
 * A brand noun Turkish suffixes (`divanda`, `panoda`, `çaylaksın`) is written out here and appears
 * as a `{…Noun}` placeholder on the English side, which is what keeps the per-key whole-word count
 * equal across locales — the invariant `brandNouns.unit.test.ts` grades.
 */
export const auth = {
	"auth.brand.pano": "pano",
	"auth.brand.sozluk": "sözlük",
	"auth.brand.divan": "divan",
	"auth.brand.caylak": "çaylak",
	"auth.brand.yazar": "yazar",

	"auth.signIn.title": "giriş yap",
	"auth.signIn.sub": "kaldığın yerden devam et.",
	"auth.signIn.submit": "devam et",
	"auth.signIn.pending": "giriliyor…",
	"auth.signIn.failed": "giriş başarısız",
	"auth.signIn.altPrompt": "hesabın yok mu? ",
	"auth.signUp.title": "kayıt ol",
	"auth.signUp.sub": "kapı açık, söz hakkı kazanılır.",
	"auth.signUp.rite":
		"hesap açmak herkese serbest. ilk yazdıkların çaylak olarak divanda incelenir; katkı verdikçe bir yazarın kefilliğiyle yazar olursun — o zaman yazdıkların doğrudan yayına girer.",
	"auth.signUp.submit": "hesap aç",
	"auth.signUp.pending": "açılıyor…",
	"auth.signUp.failed": "kayıt başarısız",
	"auth.signUp.altPrompt": "zaten hesabın var mı? ",

	"auth.field.name.label": "görünen ad",
	"auth.field.email.label": "e-posta",
	"auth.field.username.label": "kullanıcı adı",
	"auth.field.username.optional": "(isteğe bağlı)",
	"auth.field.username.hint": "profilin /u/<ad> üzerinden açılır. sonradan değişmez.",
	"auth.field.password.label": "parola",
	"auth.field.password.capsLock": "Caps Lock açık",
	"auth.field.password.show": "parolayı göster",
	"auth.field.password.hide": "parolayı gizle",
	"auth.field.password.placeholder": "en az 8 karakter",

	"auth.validation.nameRequired": "görünen ad gerekli",
	"auth.validation.emailRequired": "e-posta gerekli",
	"auth.validation.emailInvalid": "geçerli bir e-posta gir",
	"auth.validation.passwordRequired": "parola gerekli",
	"auth.validation.passwordTooShort": "parola en az 8 karakter olmalı",

	"auth.username.saving": "ayarlanıyor…",
	"auth.stuck.title": "kullanıcı adı ayarlanamadı",
	// Split around the chosen handle, which renders in its own `<strong>`: the two locales put
	// that handle at different points in the sentence, so one interpolated string cannot carry it.
	"auth.stuck.subBefore": "hesabın açıldı, ama seçtiğin",
	"auth.stuck.subAfter":
		"adı ayarlanamadı. kullanıcı adı sonradan değişmez, o yüzden devam etmeden önce tekrar dene.",
	"auth.stuck.retry": "tekrar dene",
	"auth.stuck.abandon": "bu adı bırak, sonra seçerim",

	"auth.bootstrap.title": "kullanıcı adını seç",
	"auth.bootstrap.confirmHint":
		"bu e-postandan türetilmiş ad. sonradan değişmez — onaylamadan önce istersen değiştir.",
	"auth.bootstrap.confirmSubmit": "bu adı onayla",
	"auth.bootstrap.submit": "devam et",

	"auth.welcome.loading": "yükleniyor…",
	"auth.welcome.title": "hoş geldin",
	"auth.welcome.titleCaylak": "hoş geldin, çaylak",
	"auth.welcome.lede":
		"kamp.us, geliştiricilerin kendi kendine bir şey öğrettiği yavaş bir köşe. panoda bağlantı ve yazı paylaşılıyor; sözlükte terimler kendi cümlelerimizle yazılıyor. reklam yok, takipçi yarışı yok — söz hakkı kazanılır.",
	"auth.welcome.standingHeading": "neredesin",
	"auth.welcome.caylakLine": "hesabın yeni açıldı; henüz bir çaylaksın.",
	"auth.welcome.karmaLabel": "karma",
	"auth.welcome.vouchTerm": "kefil",
	"auth.welcome.yazarNote": "zaten bir yazarsın; yazdıkların doğrudan yayına girer.",
	"auth.welcome.standingLoading": "durumun yükleniyor.",
	"auth.welcome.riteHeading": "önündeki yol",
	"auth.welcome.riteBody":
		"ilk katkını yaz — mevcut bir başlığa girdi ekleyerek başlayabilirsin. katkı verdikçe bir yazar sana kefil olur; kefillik ve inceleme tamamlandığında yazar olursun ve yazdıkların doğrudan yayına girer.",
	"auth.welcome.continue": "devam et",

	"auth.landing.tagline": "geliştiricilerin kendi kendine bir şey öğrettiği, yavaş bir köşe.",
	"auth.landing.manifesto.panoLead": "panoda",
	"auth.landing.manifesto.panoBody": "bağlantı ve yazı paylaşıyor, tartışıyoruz.",
	"auth.landing.manifesto.sozlukLead": "sözlükte",
	"auth.landing.manifesto.sozlukBody": "terimleri kendi cümlelerimizle yazıyoruz.",
	"auth.landing.manifesto.tail":
		"türkçe öncelikli; reklam, takipçi sayısı, sansasyon yok — sadece okumaya değer şeyler ve onları yazan birkaç yüz kişi.",
	"auth.landing.rite.doorLead": "kapı açık:",
	"auth.landing.rite.doorBody": "hesap açmak herkese serbest.",
	"auth.landing.rite.earnedLead": "söz hakkı kazanılır:",
	"auth.landing.rite.earnedBody":
		"ilk yazdıkların çaylak olarak divanda incelenir; katkı verdikçe bir yazar sana kefil olur, yazar olursun — o zaman yazdıkların doğrudan yayına girer.",
	"auth.landing.join.label": "hesap aç",
	"auth.landing.join.sub": "kapı açık · söz hakkı kazanılır",
	"auth.landing.browse.panoSub": "başlıklar · tartışmalar",
	"auth.landing.browse.sozlukSub": "terimler · tanımlar",
	"auth.landing.col.pano": "panoda son 24 saat",
	"auth.landing.col.sozluk": "sözlüğe son eklenenler",
	"auth.landing.seeAll": "hepsini gör",
	"auth.landing.empty.posts": "henüz başlık yok.",
	"auth.landing.empty.terms": "henüz terim yok.",
	"auth.landing.loading": "yükleniyor…",
	"auth.landing.error": "şu an yüklenemedi",
	"auth.landing.stats.definitions": "tanım",
	"auth.landing.stats.posts": "başlık",
	"auth.landing.stats.authors": "yazar",
	"auth.landing.stats.comments": "yorum",
	"auth.landing.stats.version": "phoenix",
	"auth.landing.stats.error": "istatistikler şu an yok",
	"auth.landing.row.voteOne": "oy",
	"auth.landing.row.voteOther": "oy",
	"auth.landing.row.commentOne": "yorum",
	"auth.landing.row.commentOther": "yorum",
	"auth.landing.row.definitionOne": "tanım",
	"auth.landing.row.definitionOther": "tanım",

	"auth.onramp.heading.sozluk": "ilk tanımını yazmaya hazırsın",
	"auth.onramp.heading.pano": "ilk gönderini paylaşmaya hazırsın",
	"auth.onramp.heading.panoComment": "ilk yorumunu yazmaya hazırsın",
	"auth.onramp.body":
		"çaylak olarak yazdıkların, sen yazar olana kadar yalnızca moderatörlerin gördüğü bir alanda incelenir — hemen herkese görünmez. yazıp katkı verdikçe karma toplar, bir yazarın desteğiyle yazar olursun; o zaman yazdıkların doğrudan yayına girer.",
};

/** `tr` is the source of truth for the key set; `en/auth.ts` is checked against this. */
export type AuthKey = keyof typeof auth;
