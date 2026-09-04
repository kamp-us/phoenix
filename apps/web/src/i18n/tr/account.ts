/**
 * The account cluster — the surfaces a reader reaches from their own identity: the profile
 * (own and public), notifications, mutes, çaylak visibility, the email-delivery notice, the
 * reaction glosses, and the shared `@kampus/design` primitives that carry fixed copy.
 *
 * One file, several key prefixes: these are one ticket's surface (#7531) and one catalog file
 * per component directory would be nine files nothing else distinguishes.
 */
export const account = {
	"notFound.title": "bulunamadı",
	"notFound.message": "aradığın sayfa burada değil. başka bir şeye bakmak ister misin?",
	"notFound.link.home": "ana sayfa",
	"notFound.link.sozluk": "sözlük",
	"notFound.link.pano": "pano",

	"bildirim.title": "bildirimler",
	"bildirim.loading": "yükleniyor…",
	"bildirim.empty": "henüz bildirimin yok.",
	"bildirim.count.one": "{count} bildirim",
	"bildirim.count.other": "{count} bildirim",
	"bildirim.unreadLabel.one": "{count} okunmamış bildirim",
	"bildirim.unreadLabel.other": "{count} okunmamış bildirim",
	"bildirim.markAll.action": "tümünü okundu say",
	"bildirim.markAll.done": "tümü okundu",
	"bildirim.markRead": "okundu",
	"bildirim.tombstone": "silinmiş içerik",
	"bildirim.seeAll": "tümünü gör",
	"bildirim.error.unauthorized": "bildirimlerini görmek için giriş yapmalısın.",
	"bildirim.error.generic": "bildirimler yüklenemedi, tekrar dene.",
	"bildirim.target.post": "gönderiye git",
	"bildirim.target.comment": "yoruma git",
	"bildirim.target.definition": "tanıma git",
	"bildirim.target.user": "profile git",
	"bildirim.target.fallback": "içeriğe git",
	"bildirim.kind.divanVote.one": "divandaki içeriğin oy aldı",
	"bildirim.kind.divanVote.other": "divandaki içeriğin {count} oy aldı",
	"bildirim.kind.kefil": "bir yazar sana kefil oldu",
	"bildirim.kind.terfi": "tebrikler, artık bir yazarsın!",
	"bildirim.kind.reply.one": "gönderine yanıt geldi",
	"bildirim.kind.reply.other": "gönderine {count} yanıt geldi",
	"bildirim.kind.vote.one": "içeriğin {count} yeni oy aldı",
	"bildirim.kind.vote.other": "içeriğin {count} yeni oy aldı",
	"bildirim.kind.reportFiled.one": "yeni bir içerik bildirildi",
	"bildirim.kind.reportFiled.other": "{count} yeni içerik bildirildi",
	"bildirim.kind.caylakPending": "yeni bir çaylak divanda incelenmeyi bekliyor",
	"bildirim.kind.backlogRelease.zero": "bundan sonra yazılarınız herkese açık",
	"bildirim.kind.backlogRelease.one": "{count} yazınız artık herkese açık",
	"bildirim.kind.backlogRelease.other": "{count} yazınız artık herkese açık",
	"bildirim.kind.unknown": "{kind} ×{count}",

	"mute.action": "sustur",
	"mute.action.label": "{member} adlı üyeyi sustur",
	"mute.unmute": "geri al",
	"mute.unmute.label": "{member} adlı üyenin sessizliğini geri al",
	"mute.member.fallback": "bir üye",
	"mute.list.label": "susturduğun üyeler",
	"mute.empty.title": "henüz kimseyi susturmadın",
	"mute.empty.description":
		"susturduğun üyeler burada listelenir; buradan sessizliği geri alabilirsin.",
	"mute.page.title": "susturduklarım",
	"mute.page.lede":
		"susturduğun üyelerin içerikleri akışında görünmez. buradan sessizliği geri alabilirsin.",
	"mute.page.loading": "yükleniyor…",
	"mute.page.error.unauthorized": "susturduklarını görmek için giriş yapmalısın.",
	"mute.page.error.generic": "susturduğun üyeler yüklenemedi, tekrar dene.",

	"karma.label": "karma",

	"reaction.gloss.thumbsUp": "beğendim",
	"reaction.gloss.heart": "sevdim",
	"reaction.gloss.laughing": "güldüm",
	"reaction.gloss.thinking": "düşündürdü",
	"reaction.gloss.crying": "üzüldüm",
	"reaction.gloss.fire": "efsane",

	"membrane.emailNotice.label": "e-posta teslimat uyarısı",
	"membrane.emailNotice.title": "e-postana ulaşamıyoruz",
	"membrane.emailNotice.text":
		"adresine gönderdiğimiz e-postalar geri dönüyor — giriş bağlantıların ve doğrulama e-postaların sana ulaşmıyor olabilir. adresini güncelle ya da yeniden doğrula.",
	"membrane.emailNotice.cta": "e-postanı güncelle",
	"membrane.emailNotice.dismiss": "kapat",

	"caylakVisibility.toggle.label": "çaylak katkılarını yerinde göster",
	"caylakVisibility.toggle.hint":
		"açtığında çaylakların yazdıkları akışına karışır, çaylak işi olduğu belli olacak şekilde işaretli. kapalıyken hiçbir çaylak katkısı akışında görünmez.",
	"caylakVisibility.toggle.error": "ayar kaydedilemedi, tekrar dene.",
	"caylakVisibility.page.title": "çaylak görünürlüğü",
	"caylakVisibility.page.lede":
		"çaylakların yazdıkları varsayılan olarak akışında görünmez. burada, onları yerinde görmeyi seçebilirsin.",
	"caylakVisibility.page.loading": "yükleniyor…",
	"caylakVisibility.page.unavailable": "ayarın yüklenemedi, sayfayı yenileyip tekrar dene.",
	"caylakVisibility.page.caylakNote":
		"bu ayar yazarlara özel. sen henüz çaylaksın, bu yüzden burada açıp kapatacak bir şey yok. yazar olduğunda çaylak katkılarını akışında görmeyi buradan seçebilirsin.",

	"profile.actor.fallback": "kullanıcı",
	"profile.page.loading": "yükleniyor…",
	"profile.page.error": "profil yüklenemedi: {code}",
	"profile.header.statsError": "istatistikler yüklenemedi",
	"profile.standing.yazar": "yazar",
	"profile.standing.caylak": "çaylak",
	"profile.stat.definitions": "tanım",
	"profile.stat.posts": "başlık",
	"profile.stat.comments": "yorum",

	"profile.caylakStatus.heading": "yazarlığa giden yol",
	"profile.caylakStatus.vouch.yes": "var",
	"profile.caylakStatus.vouch.no": "yok",
	"profile.caylakStatus.vouchNeeded.message": "bir yazar sana kefil olmalı",
	"profile.caylakStatus.vouchNeeded.hint": "ya da bir moderatör seni doğrudan yükseltebilir",
	"profile.caylakStatus.term.kefil": "kefil",
	"profile.caylakStatus.term.inReview": "incelemede",

	"profile.contribution.kind.definition": "tanım",
	"profile.contribution.kind.post": "başlık",
	"profile.contribution.kind.comment": "yorum",
	"profile.contribution.score.one": "{count} oy",
	"profile.contribution.score.other": "{count} oy",

	"profile.contributions.heading.public": "katkılar",
	"profile.contributions.heading.self": "katkıların",
	"profile.contributions.empty.title": "henüz katkı yok.",
	"profile.contributions.empty.description":
		"ilk tanımını ya da başlığını ekleyince burada görünür.",
	"profile.contributions.loading": "yükleniyor…",
	"profile.contributions.error": "katkılar yüklenemedi: {code}",
	"profile.contributions.seeAll": "tümünü gör",

	"profile.promotion.sectionLabel": "yazarlık işlemleri",
	"profile.promotion.action": "yazarlığa yükselt",
	"profile.promotion.outcome.promoted": "kullanıcı yazar oldu.",
	"profile.promotion.outcome.alreadyYazar": "kullanıcı zaten yazar.",
	"profile.promotion.outcome.denied": "bunu yapma yetkin yok.",
	"profile.promotion.outcome.error": "işlem başarısız oldu.",

	"profile.user.notFound.title": "kullanıcı bulunamadı",
	"profile.user.notFound.message": "@{username} burada yok. başka bir şeye bakmak ister misin?",

	"profile.section.account": "hesap",
	"profile.field.displayName": "görünen ad",
	"profile.field.username": "kullanıcı adı",
	"profile.field.username.immutable": "değiştirilemez",
	"profile.field.email": "e-posta",
	"profile.save.action": "kaydet",
	"profile.save.saving": "kaydediliyor…",
	"profile.save.saved": "kaydedildi",
	"profile.save.error": "kaydedilemedi, tekrar dene",
	"profile.email.soon": "e-posta değiştirme yakında",
	"profile.email.change": "değiştir",
	"profile.email.changeUnavailable": "e-posta değiştirme henüz kullanılamıyor",

	"profile.section.appearance": "görünüm",
	"profile.field.theme": "tema",
	"profile.theme.light": "açık",
	"profile.theme.dark": "koyu",
	"profile.theme.auto": "otomatik",
	"profile.field.density": "yoğunluk",
	"profile.density.compact": "sıkı",
	"profile.density.normal": "normal",
	"profile.density.spacious": "ferah",
	"profile.field.caylakContributions": "çaylak katkıları",
	"profile.caylakContributions.description":
		"çaylakların yazdıklarını akışında görüp görmeyeceğini seçersin.",
	"profile.caylakContributions.action": "ayarla",

	"profile.section.session": "oturum",
	"profile.session.description": "bu cihazda aktif. çıkış yaparak oturumu sonlandırabilirsin.",
	"profile.session.signOut": "çıkış yap",
	"profile.session.signOutAll": "tüm cihazlardan çık",
	"profile.session.signingOutAll": "çıkış yapılıyor…",
	"profile.session.revokeError": "oturumlar sonlandırılamadı, tekrar dene.",

	"profile.section.danger": "tehlikeli alan",
	"profile.danger.description":
		"hesabını kaldırırsan başlıkların, tanımların ve yorumların silinmez — @[silinen] adına aktarılır, karmaları korunur. hesabın kimliği (e-posta, oturumlar) kalıcı olarak kaldırılır; aynı e-posta ileride yeniden kayıt olabilir. bu işlem geri alınamaz.",
	"profile.danger.action": "hesabı kaldır",

	"profile.delete.title": "hesabı kaldır",
	"profile.delete.description": "bu işlem geri alınamaz. devam etmek için aşağıdaki ifadeyi yaz.",
	"profile.delete.inputLabel": "onay ifadesi",
	"profile.delete.cancel": "vazgeç",
	"profile.delete.confirm": "hesabı kalıcı olarak kaldır",
	"profile.delete.pending": "kaldırılıyor…",
	"profile.delete.error": "hesap kaldırılamadı, tekrar dene.",

	"ui.caylakBadge": "çaylak katkısı",
	"ui.caylakBadge.stage": ", hazırlık aşamasında",
	"ui.reviewBadge": "incelemede",
	"ui.edited": "düzenlendi",
	"ui.share.label": "paylaş",
	"ui.share.copied": "kopyalandı",
	"ui.share.error": "kopyalanamadı",
	"ui.report.action": "bildir",
	"ui.report.reported": "bildirildi",
	"ui.report.already": "zaten bildirildi",
	"ui.draftRestore.label": "kaydedilmiş taslak",
	"ui.draftRestore.text": "kaydedilmiş bir taslağın var. geri yüklemek ister misin?",
	"ui.draftRestore.restore": "taslağı geri yükle",
	"ui.draftRestore.dismiss": "yoksay",
};

/** `tr` is the source of truth for the key set; `en/account.ts` is checked against this. */
export type AccountKey = keyof typeof account;
