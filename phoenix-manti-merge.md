# Phoenix → Manti UI canlı entegrasyon raporu

Tarih: 27 Temmuz 2026  
Branch: `phoenix-manti-merge`  
Manti sürümü: `@manti-ui/react@0.6.0`, `@manti-ui/styles@0.6.0`

## 1. Sonuç

Phoenix web uygulamasındaki Base UI bağımlılığı ve çalışma zamanı kullanımları kaldırıldı.
Genel amaçlı etkileşimli primitive'ler Manti UI'a geçirildi; Phoenix'in mevcut renk,
tipografi, yoğunluk, boşluk, radius, elevation ve motion sistemi Manti token'larına
bağlandı. Dönüşümde görsel kaynak olarak Phoenix korundu, Manti ise davranış,
erişilebilirlik state machine'i ve DOM anatomisi katmanı olarak kullanıldı.

Kodda, workspace kataloğunda ve lockfile'da `@base-ui/react` kalmadı. Tasarım sistemi
envanteri projenin kendi üreticisiyle yeniden oluşturuldu ve Manti API'larını tarif
edecek şekilde güncel.

## 2. Uygulanan yaklaşım

- Manti'nin `llms.txt` dosyası ve oradan bağlı bileşen dokümantasyonu kaynak kabul edildi.
- Dokümandaki API'lar ayrıca kurulu `0.6.0` paketinin gerçek `.d.ts` ve dağıtım çıktısıyla
  karşılaştırıldı.
- Manti'nin global stili uygulama girişinde bir kez yüklendi.
- Phoenix class adları uyumluluk katmanı olarak korundu; CSS, Manti'nin açık
  `data-scope` / `data-part` anatomisini hedefliyor.
- Eski çağrı noktaları mümkün olduğunca ince adapter'larla korundu; compound Base UI
  ağaçları Manti'nin flat API'larına dönüştürüldü.
- Manti karşılığı bulunmayan veya Manti karşılığı gerekli HTML semantiğini koruyamayan
  primitive'ler uygulamaya özel/native olarak bırakıldı. Bunlar Base UI kullanmıyor.

## 3. Token eşlemesi

Phoenix token'ları kaynak, Manti token'ları alias/consumer olarak ele alındı.

| Alan | Phoenix kaynağı | Manti hedefi |
|---|---|---|
| Ana yüzeyler | `--surface`, `--surface-raised`, `--surface-sunken` | `--manti-bg`, `--manti-surface`, `--manti-surface-raised`, `--manti-surface-sunken` |
| Kenarlık | `--border`, `--border-strong` | `--manti-border`, `--manti-border-strong` |
| Metin | `--text-primary`, `--text-secondary`, `--text-muted` | `--manti-text`, `--manti-text-muted`, `--manti-text-subtle` |
| Accent | `--accent`, `--accent-fg`, `--accent-faint`, `--accent-soft` | focus, selection ve `primary` semantic variant token'ları |
| Tipografi | `--font-body`, `--font-mono`, Phoenix type ramp | Manti sans/mono, size ve line-height scale'i |
| Radius | `--r-sm`, `--r-md`, `--r-lg`, `--r-pill` | Manti `xs`–`2xl`, `full`, `pill`, `thumb` radius token'ları |
| Spacing | `--s-1`–`--s-8` | Manti space scale'i; büyük basamaklar Phoenix değerlerinden hesaplanıyor |
| Kontrol boyu | `--tap-min` | Manti `sm` ve `md` control height; erişilebilir hit-area tabanı korunuyor |
| Motion | `--motion-*`, `--ease-*` | Manti duration ve easing token'ları |
| Elevation | `--shadow-raised`, `--shadow-dropdown`, `--shadow-overlay` | Manti shadow `sm`, `md`, `lg` |
| Overlay | `--black-a40` | `--manti-overlay` |
| Bileşen geometrisi | Phoenix yoğun dialog/menu/tooltip/popover ölçüleri | İlgili Manti component token'ları |

`primary` Manti varyantı, seçili Phoenix renk temasının accent token'larına bağlandı.
Böylece tema seçimi değiştiğinde Manti bileşenleri ikinci bir renk sistemi oluşturmuyor.

## 4. Bileşen dönüşümü

| Phoenix primitive/alan | Son durum |
|---|---|
| Button | Manti Button üzerinde ince uyumluluk adapter'ı |
| Avatar | Manti Avatar; Phoenix kare geometri ve initials davranışı korunuyor |
| Switch | Manti Switch |
| Tooltip | Manti Tooltip; eski provider geçici no-op uyumluluk kabuğu |
| Dialog | Manti flat Dialog API |
| Menu | Manti `items` tabanlı flat Menu API |
| Tabs | Manti `items` tabanlı Tabs API |
| ToggleGroup | Manti string-array selection API |
| Collapsible | Manti flat Collapsible API |
| Popover | Manti Popover; bildirim açılır yüzeyi buna taşındı |
| Input / Textarea | Manti'nin label/hint/error sahibi alan bileşenleri |
| Toast | Manti `createToaster` üzerinde mevcut `useToast` uygulama kontratı |
| Form | Native `<form>` shell + Manti Input/Textarea |
| Card / Surface | Phoenix'te kaldı; gerekli `li`, `article`, `aside` semantiği korunuyor |
| Atoms / domain kontrolleri | Manti'de eşdeğer veya gerekli polymorphism yoksa Phoenix/native kaldı |

Ürün çağrı noktalarında sözlük oluşturma, pano oluşturma/silme, hesap silme, kefil olma,
yorum/hesap menüleri, bildirim popover'ı, tema seçimi ve Atölye örnekleri yeni API'lara
taşındı.

## 5. Olumlu gözlemler

1. `data-scope` ve `data-part` anatomisi tasarım sistemi eşlemesini oldukça temiz yaptı.
   Phoenix class'larını korurken state machine DOM'una güvenli biçimde stil uygulanabildi.
2. Dialog, Popover, Menu, Tabs ve Collapsible'ın flat API'ları uygulama çağrı noktalarında
   compound JSX gürültüsünü azalttı.
3. Zag tabanlı controlled/uncontrolled state davranışı gerçek tarayıcıda tutarlı çalıştı.
   Dialog Escape ile kapandı, Menu seçim sonrası kapandı, Tabs selection ve paneller doğru
   güncellendi.
4. Token kapsamı yeterince geniş olduğu için Manti'nin görünümü Phoenix'e düşük görsel
   farkla yaklaştırılabildi.
5. `llms.txt` ile dokümantasyon giriş noktası başarılı; agent'ın doğru bileşen sayfasına
   gitmesini kolaylaştırıyor.

## 6. Sorunlar ve Manti UI geliştirme önerileri

### 6.1 Menu: salt `click` seçimi callback üretmiyor — yüksek öncelik

Gerçek entegrasyonda `fireEvent.click(menuitem)` menüyü kapattı fakat `onSelect`
çalışmadı. Pointer hover/pointerdown sonrasında click gönderildiğinde çalıştı. Paket
uygulamasında `invokeOnSelect`, click event'indeki öğe değerinden çok önceden yazılmış
`highlightedValue` state'ine dayanıyor.

Bu yalnızca test ergonomisi değil; bazı assistive technology veya programatik activation
akışları yalnızca `click` üretebilir. Öneri:

- `ITEM_CLICK` sırasında hedefin `data-value` değeri selection callback'ine doğrudan
  taşınmalı veya selection'dan önce senkron olarak highlighted value atanmalı.
- Manti test paketinde pointer, klavye ve programatik click yollarının üçü de aynı
  `onSelect(value)` sonucuna kilitlenmeli.

### 6.2 Switch: erişilebilirlik props'ları ve rol — yüksek öncelik

`SwitchProps` arbitrary native/ARIA props kabul etmiyor. `aria-label`,
`aria-labelledby`, `data-testid` gibi değerler kontrol köküne geçirilemiyor. Ayrıca
render edilen input `role="checkbox"` semantiğinde; bileşen adı ve görsel davranışı
Switch iken `role="switch"` sunulmuyor.

Öneri:

- Güvenli bir `rootProps` / `inputProps` alanı veya native attribute passthrough eklenmeli.
- Varsayılan semantik `role="switch"` olmalı ya da `semantic="switch" | "checkbox"`
  seçeneği belgelenmeli.
- `children` ile label vermenin yanında `aria-label` ve `aria-labelledby` desteklenmeli.

### 6.3 ToggleGroup: grubun erişilebilir adı verilemiyor — yüksek öncelik

Single seçimde item'lar doğru biçimde `role="radio"` ve `aria-checked` üretiyor; ancak
root'a `aria-label` / `aria-labelledby` geçirilemiyor. Sonuçta `radiogroup` kendi
erişilebilir adına sahip değil. Atölye'de dışarıdan semantic `fieldset` ile telafi edildi.

Ayrıca item modelinde `className`, `style`, `aria-label`, `data-*` veya `itemProps`
bulunmuyor. Renk swatch'ı gibi görsel seçeneklerde label içine yardımcı span koymak ve
`:has()` ile stil vermek gerekti.

Öneri:

- Root için `aria-label`, `aria-labelledby` veya `rootProps`.
- Item için `className`, `style`, `aria-label`, `disabled` ve tercihen `getItemProps`.
- Single-select için doğrudan `value: string` / `onValueChange(string)` modu; şu an radio
  davranışı string-array kontratı üzerinden kuruluyor.

### 6.4 Menu item modeli fazla kapalı — orta/yüksek öncelik

`MenuCommand` label/icon/shortcut/disabled alanlarını sunuyor; fakat item root'una
class/style/ARIA/data/test özellikleri verilemiyor. Destructive görünüm label içindeki bir
span ve `:has()` selector'ü ile kuruldu. Kullanıcı menüsündeki üçlü tema seçimi
`menuitemradio` olarak ifade edilemedi; aktif seçim görsel check ve ayrıca saklı current
value ile gösterildi.

Öneri:

- `kind: "item" | "checkbox" | "radio"` ve `checked`.
- `danger`/`tone` gibi semantic durum.
- `itemProps` veya `getItemProps`.
- Group içinde custom interactive content desteklenmeyecekse bu sınır dokümantasyonda
  açıkça belirtilmeli.

### 6.5 Overlay z-index'i inline token ile sabitleniyor — orta öncelik

Menu ve Tooltip positioner'ında hesaplanan `--z-index` değeri inline olarak `1100`
geliyor. Uygulama CSS'inden normal cascade ile Phoenix'in layer scale'ine bağlamak mümkün
olmadı; ancak `!important` ile ezilebiliyordu. Lint ve sürdürülebilir cascade için Manti
varsayılanı korundu.

Öneri:

- `--manti-z-menu`, `--manti-z-popover`, `--manti-z-tooltip`, `--manti-z-dialog` public
  token'ları.
- Alternatif olarak component `zIndex` prop'u.
- Inline `--z-index` yalnızca açık prop verilirse yazılmalı; aksi halde CSS fallback
  kullanılmalı.

### 6.6 Tooltip API kapsamı — orta öncelik

Tooltip `openDelay`, `closeDelay` ve `interactive` sunuyor; fakat `placement`, controlled
`open`, `defaultOpen`, `onOpenChange` ve portal seçeneği yok. Tooltip positioner'ı portal
yerine bulunduğu React ağacında render ediliyor. Overflow/stacking context içindeki
gerçek uygulamalar için bu sınırlayıcı olabilir.

Öneri: Dialog/Popover ile tutarlı biçimde placement, controlled state ve
`portalled`/`portalContainer` desteği.

### 6.7 Card polymorphism eksikliği — orta öncelik

Manti Card div tabanlı ve `as` / `render` / `asChild` sunmuyor. Phoenix Surface/Card;
feed satırlarında `li`, içerikte `article`, yan içerikte `aside` olabiliyor. Tam Manti
Card dönüşümü HTML semantiğini bozacağı için yapılmadı.

Öneri: en azından `as` veya Base UI benzeri render prop/asChild desteği. Aynı ihtiyaç
Badge/Tag gibi link olabilen primitive'lerde de geçerli.

### 6.8 Button icon anatomisi — orta öncelik

`leadingIcon` / `trailingIcon` içerikleri doğrudan root'a geliyor; ayrı public
`data-part="icon"` anatomisi ve dekoratif `aria-hidden` garantisi yok. Phoenix adapter'ı
bu nedenle kendi dekoratif span'ini ekledi.

Öneri:

- Leading/trailing icon için public anatomy part'ları.
- Varsayılan dekoratif icon'u `aria-hidden` yapmak veya `iconLabel` ile explicit
  accessible icon yolunu ayırmak.

### 6.9 Root type export eksikleri — orta öncelik

Component declaration dosyalarında bulunan bazı tipler root barrel'dan çıkmıyor:
`DialogRenderProps` ve `TabsVariant` bunlara örnek. Uygulamada `TabsVariant`,
`TabsProps["variant"]` üzerinden türetildi.

Öneri: build-time export parity testi; her component `.d.ts` public tipinin
`@manti-ui/react` root export'unda bulunmasını doğrulamalı.

### 6.10 Toast yerelleştirmesi — orta öncelik

`createToaster` ve per-toast options, close button etiketi için translations alanı
sunmuyor. Türkçe uygulamada hazır close affordance'ın accessible metnini bileşen
seviyesinde yerelleştirmek mümkün değil.

Öneri: toaster factory seviyesinde `translations`, en azından `closeLabel`.

### 6.11 Input/Textarea required göstergesi — düşük/orta öncelik

`required` alanlarda label metnine görünür `*` otomatik ekleniyor. Bu davranış bazı
tasarım sistemlerinde istenir, bazılarında yalnızca ARIA/native required semantiği
istenir. Görsel göstergeyi kapatma veya özelleştirme prop'u yok.

Öneri: `requiredIndicator`, `showRequiredIndicator` veya render slot'u. Dokümantasyonda
label'ın görünen metninin değişeceği açık yazılmalı.

### 6.12 Form ve Skeleton kapsamı — düşük öncelik

Manti Input/Textarea kendi alan kabuğunu iyi sağlıyor; fakat native submit shell'i için
Form primitive'i yok. Phoenix bu nedenle native `<form>` adapter'ını koruyor. Manti'de
genel Skeleton da bulunmadığı için Phoenix atomu kaldı.

Öneri: state yönetmeyen semantic Form shell zorunlu değil; ancak dokümantasyonda önerilen
native kompozisyon örneği yararlı olur. Skeleton ise ortak loading yüzeyleri için anlamlı
bir ekleme olabilir.

### 6.13 jsdom test kurulumu belgelenmeli — düşük öncelik

Zag/Floating UI tabanlı Menu, Popover ve Tooltip jsdom'da `PointerEvent` ve
`ResizeObserver` bekliyor. Uygulamanın test setup'ına iki küçük shim eklemek gerekti.

Öneri: Manti test rehberinde Vitest/jsdom setup örneği ve önerilen polyfill'ler yer almalı.

## 7. Uygulama tarafında alınan özel kararlar

- `Card`/`Surface`, semantic element polymorphism kaybolmasın diye Phoenix'te kaldı.
- `Form` native `<form>` olarak kaldı; alanların kendisi Manti Input/Textarea.
- `CountToggle`, `MetaRow`, `Tag`, `Skeleton`, `Code`, `Kbd`, `Mark` ve domain
  bileşenleri Manti'nin genel amaçlı primitive kapsamına zorla sokulmadı.
- Signed-in tema kontrolü, Manti Menu custom interactive child desteklemediği için menu
  command group'a dönüştürüldü. Aktif seçenek check ile gösteriliyor.
- Manti Tooltip provider istemediği için mevcut uygulama root'unu kırmamak adına eski
  provider export'u geçici no-op bırakıldı. Yeni kod bu provider'a bağımlı olmamalı.
- Mobilde Manti ToggleGroup'lu tema seçimi üst çubuğu genişlettiği için 640 px altında
  arama tam genişlikte ikinci satıra alındı. 390 px ölçümde document overflow sıfırlandı.

## 8. Doğrulama sonuçları

- `pnpm lint` — geçti. Değişen Manti dosyalarında hata/uyarı yok; repo genelinde bu
  çalışmadan bağımsız mevcut uyarılar raporlanmaya devam ediyor.
- `pnpm --filter @kampus/web typecheck` — geçti.
- `pnpm --filter @kampus/web build` — Vite production build geçti.
- Client testleri — 55 dosya, 264 test geçti.
- Unit testleri — 287 dosya, 2.420 test geçti.
- A11y paketi — 1 dosya, 14 test geçti.
- `design-inventory check` — 30 primitive ile fresh.
- `git diff --check` — whitespace hatası yok.
- Base UI taraması — uygulama kodu, workspace kataloğu ve lockfile temiz.
- Gerçek tarayıcı — 1440 px Button/Form/Dialog/Menu ve etkileşimleri; 390 px
  ToggleGroup/topbar kontrolü yapıldı. Dialog Escape, Menu select-close, Tabs selection,
  Tooltip hover görünürlüğü doğrulandı. Mobil document `scrollWidth`, viewport ile eşit.

Tam integration ve uzak E2E paketi çalıştırılmadı; bunlar gerçek Cloudflare
deploy/uzak servis ve kimlik akışlarına bağlı. Kullanıcının açık talimatına uygun olarak
deploy, GitHub push, commit veya PR işlemi yapılmadı.

## 9. Önerilen Manti öncelik sırası

1. Menu programatik click/onSelect tutarlılığı.
2. Switch ve ToggleGroup ARIA/native prop passthrough.
3. Menu radio/checkbox item modeli ve item props.
4. Overlay z-index token'ları; Tooltip placement/portal/controlled API.
5. Card polymorphism ve Button icon anatomy.
6. Root type export parity ve Toast localization.
7. Required indicator özelleştirmesi ve test setup dokümantasyonu.

