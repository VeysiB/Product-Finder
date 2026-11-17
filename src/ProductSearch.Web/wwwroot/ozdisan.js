/*
 * Özdisan Elektronik bölümü.
 * Her işlem POST /api/ozdisan/{işlem} ile sunucudaki Özdisan bileşenini çağırır; yanıt { isError, data } biçimindedir.
 */
(function () {
  "use strict";

  const API = "/api/ozdisan";
  const CURRENCY_TOOLS = new Set(["search_products", "filter_products", "get_product", "get_alternatives", "compare_products", "check_bom"]);
  const TABS = [
    ["search", "Ürün Ara"],
    ["categories", "Kategoriler"],
    ["filter", "Parametrik Filtre"],
    ["product", "Ürün Detayı"],
    ["alternatives", "Muadiller"],
    ["compare", "Karşılaştır"],
    ["bom", "BOM Kontrolü"],
    ["datasheet", "Datasheet"],
  ];
  /** Bileşen mesajlarında geçen teknik işlem adlarının arayüzdeki karşılığı. */
  const OP_TABS = {
    search_products: "Ürün Ara", filter_products: "Parametrik Filtre", get_category_filters: "Parametrik Filtre",
    search_categories: "Kategoriler", browse_categories: "Kategoriler", get_product: "Ürün Detayı",
    get_alternatives: "Muadiller", compare_products: "Karşılaştır", check_bom: "BOM Kontrolü",
    read_datasheet: "Datasheet", download_datasheet: "Datasheet",
  };
  const ALT_TYPES = [["substitute", "Muadil (birebir)"], ["similar", "Benzer"], ["accessory", "Aksesuar"], ["parametric", "Parametrik eşdeğer"]];
  const ALT_LABELS = { substitutes: "Muadiller (birebir)", similar: "Benzer ürünler", accessories: "Aksesuarlar", parametric_matches: "Parametrik eşdeğerler" };
  const SYMBOL = { TRY: "₺", USD: "$", EUR: "€" };

  // ---------------------------------------------------------------- yardımcılar
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const qs = (sel, el) => (el || document).querySelector(sel);
  const qsa = (sel, el) => [...(el || document).querySelectorAll(sel)];
  const num = (n, d = 0) => (n == null || n === "" ? "-" : Number(n).toLocaleString("tr-TR", { maximumFractionDigits: d }));
  const money = (n, cur) =>
    n == null ? "-" : `${Number(n).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 5 })} ${SYMBOL[cur] || cur || ""}`.trim();
  const store = {
    get(k, d) { try { const v = localStorage.getItem("oz." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("oz." + k, JSON.stringify(v)); } catch { /* özel pencere vb. */ } },
  };
  const toNum = (v) => (v === "" || v == null || isNaN(Number(v)) ? undefined : Number(v));

  const state = {
    started: false,
    status: null,
    currency: store.get("currency", "TRY"),
    language: store.get("language", "tr"),
    compare: store.get("compare", []), // [{product, label}]
    tab: "search",
  };

  let toastTimer;
  function toast(msg) {
    let t = qs(".oz-toast");
    if (!t) { t = document.createElement("div"); t.className = "oz-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  /**
   * Bileşen mesajlarını kullanıcıya uygun hale getirir: teknik işlem adlarını sekme adlarına çevirir,
   * yalnızca geliştiriciye yönelik İngilizce notları gizler (boş döner).
   */
  function human(text) {
    if (typeof text !== "string" || !text.trim()) return "";
    if (/^[\x20-\x7E]+$/.test(text) && /\b(the|use|call|with|more|pages|continue|entries|results|limit|matches|argument)\b/i.test(text)) return "";
    return text
      .replace(/get_category_filters'a mevcut filtreleri vererek hâlâ seçilebilir değerleri görebilirsiniz/g,
        "filtre panelinde soluk görünen değerler mevcut seçimlerle artık sonuç vermeyen değerlerdir")
      .replace(/\b([a-z]+_[a-z_]+)'(a|e|ya|ye)\b/g, (m, op) => (OP_TABS[op] ? `"${OP_TABS[op]}" sekmesine` : m))
      .replace(/\b([a-z]+_[a-z_]+)\b/g, (m, op) => (OP_TABS[op] ? `"${OP_TABS[op]}" sekmesi` : m))
      .replace(/sekmesi ile /g, "sekmesinden ")
      .replace(/sekmesi kullan/g, "sekmesini kullan")
      .replace(/'other_quick_matches'/g, "\"Diğer kategorilerden hızlı eşleşmeler\" listesindekiler")
      .replace(/\b(OZDISAN_[A-Z_]+)\b/g, "ayarlardaki sınır");
  }

  // ---------------------------------------------------------------- sunucu çağrısı
  async function call(tool, args, signal) {
    const body = { ...args };
    if (CURRENCY_TOOLS.has(tool) && !body.currency) body.currency = state.currency;
    if (!body.language) body.language = state.language;
    let res;
    try {
      res = await fetch(`${API}/${tool}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      return { isError: true, data: { error: "Sunucuya ulaşılamadı: " + e.message } };
    }
    try { return await res.json(); } catch { return { isError: true, data: { error: `HTTP ${res.status}` } }; }
  }

  /** Bir çıktı alanında işlemi çalıştırır: yükleniyor göstergesi ve hata kutusu dahil. */
  async function run(out, tool, args, render, opts = {}) {
    if (out._abort) out._abort.abort();
    const ctrl = new AbortController();
    out._abort = ctrl;
    const started = Date.now();
    out.innerHTML = `<div class="oz-loading"><span class="spinner"></span><span>${esc(opts.loadingText || "Özdisan'dan alınıyor")} · <span class="t">0</span> sn</span></div>`;
    const tick = setInterval(() => { const t = qs(".t", out); if (t) t.textContent = Math.round((Date.now() - started) / 1000); }, 500);
    try {
      const res = await call(tool, args, ctrl.signal);
      if (ctrl.signal.aborted) return null;
      out.innerHTML = res.isError ? errorBox(res.data) : render(res.data);
      opts.after?.(res.data, res.isError);
      return res;
    } catch (e) {
      if (e.name !== "AbortError") out.innerHTML = errorBox({ error: e.message });
      return null;
    } finally {
      clearInterval(tick);
    }
  }

  // ---------------------------------------------------------------- ortak görünümler
  function errorBox(d) {
    d = d || {};
    let html = `<div class="oz-error"><b>${esc(human(d.error) || "Hata")}</b>`;
    if (human(d.hint)) html += `<div>${esc(human(d.hint))}</div>`;
    for (const [k, v] of Object.entries(d)) {
      if (k === "error" || k === "hint") continue;
      html += `<div style="margin-top:8px"><small>${esc(labelFor(k))}</small>${detailValue(k, v)}</div>`;
    }
    return html + "</div>";
  }

  function labelFor(k) {
    return ({
      suggestions: "Öneriler", available_properties: "Kullanılabilir özellikler", sort_options: "Sıralama seçenekleri",
      subcategories: "Alt kategoriler", units: "Birimler", sample_values: "Örnek değerler", property: "Özellik",
      product: "Ürün", url: "Bağlantı",
    })[k] || k;
  }

  function detailValue(k, v) {
    if (Array.isArray(v)) {
      return `<div class="chips">${v.map((x) => {
        if (typeof x !== "object" || x === null) return `<span class="oz-chip static">${esc(x)}</span>`;
        if (x.category) return `<button class="oz-chip" data-act="cat-filter" data-category="${esc(x.category)}" title="${esc(x.path || "")}">${esc(x.name || x.category)}${x.product_count != null ? ` <small>${num(x.product_count)}</small>` : ""}</button>`;
        if (x.product) return `<button class="oz-chip" data-act="detail" data-product="${esc(x.product)}" title="${esc(x.description || "")}">${esc(x.part_number || x.product)}</button>`;
        return `<span class="oz-chip static">${esc(JSON.stringify(x))}</span>`;
      }).join("")}</div>`;
    }
    if (typeof v === "string" && /^https?:\/\//.test(v)) return `<div><a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a></div>`;
    if (typeof v === "object" && v !== null) return `<pre style="margin:4px 0">${esc(JSON.stringify(v, null, 2))}</pre>`;
    return `<div>${esc(typeof v === "string" ? human(v) || v : v)}</div>`;
  }

  function info(text, kind) { const t = human(text); return t ? `<div class="oz-info ${kind || ""}">${esc(t)}</div>` : ""; }

  function stockCell(p) {
    const s = Number(p.stock || 0);
    let html = s > 0 ? num(s) : `<span class="stock-0">Yok</span>`;
    if (p.upcoming_stock) html += `<br><small class="hint">+${num(p.upcoming_stock)} yolda</small>`;
    return html;
  }

  function priceCell(p, quantity) {
    if (p.price_on_request) return `<span class="hint">Teklif gerekli</span>`;
    const cur = p.currency || state.currency;
    const breaks = p.price_breaks || [];
    if (!breaks.length) return "-";
    let html = "";
    if (p.unit_price_for_quantity != null) html += `<b>${money(p.unit_price_for_quantity, cur)}</b><br><small class="hint">${num(quantity)} adet için</small>`;
    else html += `${money(breaks[0].unit_price, cur)}<br><small class="hint">${num(breaks[0].qty)}+ adet</small>`;
    if (breaks.length > 1) {
      html += `<details><summary class="hint">${breaks.length} kırılım</summary><div class="kv">${breaks
        .map((b) => `<span>${num(b.qty)}+</span><span>${money(b.unit_price, cur)}</span>`).join("")}</div></details>`;
    }
    return html;
  }

  function specsKv(specs) {
    const entries = Object.entries(specs || {});
    if (!entries.length) return `<span class="hint">Özellik bilgisi yok</span>`;
    return `<div class="kv">${entries.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join("")}</div>`;
  }

  function productActions(p) {
    const code = esc(p.product);
    const label = esc(p.part_number || p.product);
    return `<button class="btn-s" data-act="detail" data-product="${code}" title="Ürün detayı">Detay</button>` +
      `<button class="btn-s" data-act="alt" data-product="${code}" title="Muadil / benzer ürünler">Muadil</button>` +
      `<button class="btn-s" data-act="cmp-add" data-product="${code}" data-label="${label}" title="Karşılaştırma listesine ekle">+Karş.</button>` +
      `<button class="btn-s" data-act="bom-add" data-product="${label}" title="BOM listesine ekle">+BOM</button>` +
      (p.has_datasheet !== false ? `<button class="btn-s" data-act="ds-read" data-product="${code}" title="Datasheet oku">DS</button>` : "") +
      (p.url ? `<a class="btn-s" href="${esc(p.url)}" target="_blank" rel="noopener" title="ozdisan.com'da aç">↗</a>` : "");
  }

  let rowSeq = 0;
  function productTable(products, opts = {}) {
    if (!products?.length) return info(opts.empty || "Ürün yok.");
    const showSpecs = products.some((p) => p.specs && Object.keys(p.specs).length);
    const rows = products.map((p) => {
      const id = "ozr" + ++rowSeq;
      return `<tr>
        <td class="part"><button class="btn-link" data-act="detail" data-product="${esc(p.product)}">${esc(p.part_number || p.product)}</button><br><small class="hint">#${esc(p.product)}${p.rohs ? " · RoHS" : ""}</small></td>
        <td>${esc(p.manufacturer || "")}</td>
        <td class="desc">${esc(p.description || "")}${p.package ? `<br><small>Paket: ${esc(p.package)}</small>` : ""}${showSpecs && p.specs ? `<br><button class="btn-link" data-act="toggle" data-target="${id}"><small>Özellikler (${Object.keys(p.specs).length})</small></button>` : ""}</td>
        <td class="num">${stockCell(p)}</td>
        <td class="num">${p.moq ? num(p.moq) : "-"}${p.order_multiple ? `<br><small class="hint">kat: ${num(p.order_multiple)}</small>` : ""}${p.mpq ? `<br><small class="hint">MPQ: ${num(p.mpq)}</small>` : ""}</td>
        <td class="num">${priceCell(p, opts.quantity)}</td>
        <td class="acts">${productActions(p)}</td>
      </tr>${showSpecs && p.specs ? `<tr class="specs-row" id="${id}" hidden><td colspan="7">${specsKv(p.specs)}</td></tr>` : ""}`;
    }).join("");
    return `<div class="oz-tablewrap"><table class="oz-table"><thead><tr><th>Parça No</th><th>Üretici</th><th>Açıklama</th><th class="num">Stok</th><th class="num">MOQ</th><th class="num">Birim fiyat (KDV hariç)</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function categoryChips(list, countKey) {
    if (!list?.length) return "";
    return `<div class="chips">${list.map((c) => `<span class="oz-chip static" title="${esc(c.path || "")}">${esc(c.name)} <small>${num(c[countKey])}</small>
      <button class="btn-s" data-act="cat-search" data-category="${esc(c.category)}" title="Bu kategoride ara">Ara</button>
      <button class="btn-s" data-act="cat-filter" data-category="${esc(c.category)}" title="Parametrik filtrele">Filtrele</button></span>`).join("")}</div>`;
  }

  // ---------------------------------------------------------------- iskelet
  function shell() {
    const root = document.getElementById("view-ozdisan");
    root.innerHTML = `<div class="oz">
      <div class="oz-bar">
        <span class="oz-pill" id="oz-status"><span class="dot"></span><span>Bağlanıyor…</span></span>
        <span class="grow"></span>
        <label class="hint">Para birimi <select id="oz-currency"><option>TRY</option><option>USD</option><option>EUR</option></select></label>
        <label class="hint">Dil <select id="oz-language"><option value="tr">Türkçe</option><option value="en">English</option></select></label>
        <button class="oz-basket" data-act="go" data-tab="compare">Karşılaştırma <b id="oz-cmp-count">0</b></button>
        <button class="oz-basket" data-act="go" data-tab="bom">BOM <b id="oz-bom-count">0</b></button>
      </div>
      <div class="oz-shell">
        <nav class="oz-nav">${TABS.map(([id, label]) => `<a href="#ozdisan/${id}" data-tab="${id}">${esc(label)}</a>`).join("")}</nav>
        <div>${TABS.map(([id]) => `<section class="oz-panel" id="oz-tab-${id}" hidden></section>`).join("")}</div>
      </div>
    </div>`;
    qs("#oz-currency").value = state.currency;
    qs("#oz-language").value = state.language;
    qs("#oz-currency").addEventListener("change", (e) => { state.currency = e.target.value; store.set("currency", state.currency); toast("Para birimi: " + state.currency + " (sonraki aramalarda geçerli)"); });
    qs("#oz-language").addEventListener("change", (e) => { state.language = e.target.value; store.set("language", state.language); toast("Dil değişti; filtreleri yeniden yükleyin."); });
    root.addEventListener("click", onClick);

    buildSearch(); buildCategories(); buildFilter(); buildProduct(); buildAlternatives(); buildCompare(); buildBom(); buildDatasheet();
    updateBaskets();
    loadStatus();
  }

  async function loadStatus() {
    const el = qs("#oz-status");
    try {
      const s = await (await fetch(`${API}/status`)).json();
      state.status = s;
      if (s.available) {
        el.className = "oz-pill ok";
        el.innerHTML = `<span class="dot"></span><span>Özdisan'a bağlı</span>`;
        el.title = "Datasheet indirme klasörü: " + shortPath(s.downloadDir);
      } else {
        el.className = "oz-pill bad";
        el.innerHTML = `<span class="dot"></span><span>Özdisan bölümü kullanılamıyor</span>`;
        el.title = s.error || "";
        qsa(".oz-panel").forEach((p) => p.insertAdjacentHTML("afterbegin", errorBox({ error: s.error })));
      }
    } catch (e) {
      el.className = "oz-pill bad";
      el.innerHTML = `<span class="dot"></span><span>Sunucuya ulaşılamadı</span>`;
    }
  }

  function showTab(tab) {
    if (!TABS.some((t) => t[0] === tab)) tab = "search";
    state.tab = tab;
    TABS.forEach(([id]) => { qs("#oz-tab-" + id).hidden = id !== tab; });
    qsa(".oz-nav a").forEach((a) => a.setAttribute("aria-current", a.dataset.tab === tab ? "page" : "false"));
  }

  function go(tab) {
    if (location.hash !== "#ozdisan/" + tab) location.hash = "#ozdisan/" + tab;
    else showTab(tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const d = el.dataset;
    switch (d.act) {
      case "go": go(d.tab); break;
      case "toggle": { const t = document.getElementById(d.target); if (t) t.hidden = !t.hidden; break; }
      case "detail": openProduct(d.product); break;
      case "alt": openAlternatives(d.product); break;
      case "cmp-add": addCompare(d.product, d.label); break;
      case "bom-add": addBom(d.product, Number(d.qty) || 1); break;
      case "ds-read": openDatasheet(d.product); break;
      case "cat-filter": openFilter(d.category); break;
      case "cat-search": openSearch(qs("#oz-s-query").value || "", d.category); break;
      case "cat-browse": browse(d.category); break;
      default: return;
    }
    e.preventDefault();
  }

  // ---------------------------------------------------------------- 1) Ürün ara
  function buildSearch() {
    const p = qs("#oz-tab-search");
    p.innerHTML = `<h2>Ürün Ara</h2>
      <p class="lead">Parça numarası veya anahtar kelimeyle ~960.000 üründe arama (ör. <code>STM32F103</code>, <code>NE555</code>, <code>10uF 0805</code>, <code>ESP32</code>).</p>
      <form class="oz-form" id="oz-s-form">
        <div class="f wide"><label for="oz-s-query">Parça no / anahtar kelime</label><input type="text" id="oz-s-query" required placeholder="ör. LM317, 10uF 0805"></div>
        <div class="f wide"><label for="oz-s-category">Kategori (isteğe bağlı)</label><input type="text" id="oz-s-category" placeholder="slug, numara veya ad"></div>
        <div class="f" style="width:110px"><label for="oz-s-size">Ürün sayısı</label><input type="number" id="oz-s-size" min="1" max="50" value="10"></div>
        <div class="f check"><input type="checkbox" id="oz-s-stock"><label for="oz-s-stock">Stokta olanlar</label></div>
        <div class="f check"><input type="checkbox" id="oz-s-specs" checked><label for="oz-s-specs">Özellikler</label></div>
        <button class="primary" type="submit">Ara</button>
      </form>
      <div class="oz-info">Gereksinime göre parça seçimi (ör. <i>3.3 V, en az 500 mA, SOT-23 LDO</i>) için:
        <button class="btn-link" data-act="go" data-tab="categories">Kategori bul</button> →
        <button class="btn-link" data-act="go" data-tab="filter">Parametrik filtrele</button> →
        <button class="btn-link" data-act="go" data-tab="compare">Karşılaştır</button> →
        <button class="btn-link" data-act="go" data-tab="datasheet">Datasheet ile doğrula</button>.
        Malzeme listesi maliyeti için <button class="btn-link" data-act="go" data-tab="bom">BOM Kontrolü</button>.</div>
      <div class="oz-out" id="oz-s-out"></div>`;
    qs("#oz-s-form").addEventListener("submit", (e) => { e.preventDefault(); doSearch(); });
  }

  function openSearch(query, category) {
    if (query) qs("#oz-s-query").value = query;
    qs("#oz-s-category").value = category || "";
    go("search");
    if (qs("#oz-s-query").value.trim()) doSearch();
    else qs("#oz-s-query").focus();
  }

  function doSearch() {
    const args = {
      query: qs("#oz-s-query").value.trim(),
      category: qs("#oz-s-category").value.trim() || undefined,
      in_stock: qs("#oz-s-stock").checked || undefined,
      page_size: toNum(qs("#oz-s-size").value) || 10,
      include_specs: qs("#oz-s-specs").checked,
    };
    if (!args.query) return;
    run(qs("#oz-s-out"), "search_products", args, (d) => {
      let html = "";
      if (d.message) html += info(d.message, "warn");
      html += `<div class="status"><span><b>${num(d.total_matches)}</b> eşleşme</span>`;
      if (d.category) html += `<span>Kategori: <b>${esc(d.category.name)}</b></span>`;
      if (d.exact_match_product) html += `<button class="btn-s" data-act="detail" data-product="${esc(d.exact_match_product)}">Birebir eşleşen ürün: #${esc(d.exact_match_product)}</button>`;
      html += `</div>`;
      if (d.categories?.length) html += `<h3 class="oz-section-title">Eşleşmelerin kategorileri</h3>` + categoryChips(d.categories, "matches");
      if (d.products_from_category) html += `<h3 class="oz-section-title">${esc(d.products_from_category.name)} kategorisinden ürünler <small class="hint">(${num(d.products_from_category.matches)} eşleşme)</small></h3>`;
      else if (d.category) html += `<h3 class="oz-section-title">Ürünler</h3>`;
      html += productTable(d.products, { empty: "Bu aramada ayrıntılı ürün yok." });
      if (d.other_quick_matches?.length) {
        html += `<h3 class="oz-section-title">Diğer kategorilerden hızlı eşleşmeler <small class="hint">(stok/fiyat bilgisi yok)</small></h3>
          <div class="oz-tablewrap"><table class="oz-table"><thead><tr><th>Parça No</th><th>Açıklama</th><th>Kategori</th><th></th></tr></thead><tbody>${d.other_quick_matches.map((q) => `<tr>
            <td class="part"><button class="btn-link" data-act="detail" data-product="${esc(q.product)}">${esc(q.part_number)}</button></td>
            <td class="desc">${esc(q.description || "")}</td>
            <td>${q.category ? `<button class="btn-link" data-act="cat-filter" data-category="${esc(q.category)}">${esc(q.category)}</button>` : ""}</td>
            <td class="acts">${productActions({ ...q, has_datasheet: true })}</td></tr>`).join("")}</tbody></table></div>`;
      }
      html += info(d.note) + info(d.hint) + info(d.more);
      return html;
    });
  }

  // ---------------------------------------------------------------- 2) Kategoriler
  const catState = { trail: [] }; // [{category, name}]

  function buildCategories() {
    const p = qs("#oz-tab-categories");
    p.innerHTML = `<h2>Kategoriler</h2>
      <p class="lead">Kategori adında (Türkçe/İngilizce) veya ürün içeriğinde arayın ya da kategori ağacında gezin. Parametrik filtre için en alt seviyedeki kategoriyi seçin.</p>
      <div class="oz-cols">
        <div>
          <form class="oz-form" id="oz-c-form">
            <div class="f wide"><label for="oz-c-query">Kategori / komponent türü</label><input type="text" id="oz-c-query" required placeholder="ör. mosfet, lineer regülatör, MLCC"></div>
            <div class="f" style="width:90px"><label for="oz-c-limit">En fazla</label><input type="number" id="oz-c-limit" min="1" max="30" value="10"></div>
            <button class="primary" type="submit">Ara</button>
          </form>
          <div class="oz-out" id="oz-c-out"></div>
        </div>
        <div>
          <div class="oz-crumbs" id="oz-c-crumbs"></div>
          <div class="oz-out" id="oz-b-out"></div>
        </div>
      </div>`;
    qs("#oz-c-form").addEventListener("submit", (e) => { e.preventDefault(); searchCategories(); });
  }

  function catRow(c, countLabel, count) {
    const leaf = c.has_subcategories === false || (c.subcategory_count == null && c.has_subcategories == null);
    return `<li><div><button class="btn-link" data-act="cat-browse" data-category="${esc(c.category)}">${esc(c.name)}</button>
        ${c.path ? `<span class="path">${esc(c.path)}</span>` : ""}
        <small class="hint">${num(count)} ${esc(countLabel)}${c.subcategory_count ? ` · ${c.subcategory_count} alt kategori` : ""}${c.match_score != null ? ` · skor ${c.match_score}` : ""}</small></div>
      <div style="white-space:nowrap">${leaf ? `<button class="btn-s" data-act="cat-filter" data-category="${esc(c.category)}">Filtrele</button><button class="btn-s" data-act="cat-search" data-category="${esc(c.category)}">Ara</button>` : `<button class="btn-s" data-act="cat-browse" data-category="${esc(c.category)}">Aç</button>`}</div></li>`;
  }

  function searchCategories() {
    const args = { query: qs("#oz-c-query").value.trim(), limit: toNum(qs("#oz-c-limit").value) || 10 };
    if (!args.query) return;
    run(qs("#oz-c-out"), "search_categories", args, (d) => {
      let html = "";
      if (d.categories_by_name?.length) html += `<h3 class="oz-section-title">Adı eşleşen kategoriler</h3><ul class="oz-catlist">${d.categories_by_name.map((c) => catRow(c, "ürün", c.product_count)).join("")}</ul>`;
      if (d.categories_with_matching_products?.length) html += `<h3 class="oz-section-title">Ürünleri eşleşen kategoriler <small class="hint">(toplam ${num(d.total_matching_products)} ürün)</small></h3><ul class="oz-catlist">${d.categories_with_matching_products.map((c) => catRow({ ...c, has_subcategories: false }, "eşleşen ürün", c.matching_products)).join("")}</ul>`;
      if (!html) html = info("Kategori bulunamadı. Daha genel ya da İngilizce/Türkçe eşanlamlı bir ifade deneyin.", "warn");
      return html;
    });
  }

  function browse(category) {
    if (!category) catState.trail = [];
    const args = category ? { category, depth: 1 } : {};
    run(qs("#oz-b-out"), "browse_categories", args, (d) => {
      if (!category) {
        catState.trail = [];
        renderCrumbs();
        return `<h3 class="oz-section-title">Ana gruplar <small class="hint">(${num(d.total_products)} ürün)</small></h3><ul class="oz-catlist">${(d.categories || []).map((c) => catRow(c, "ürün", c.product_count)).join("")}</ul>`;
      }
      const c = d.category;
      const names = (c.path || "").split(" > ");
      // Yol bilgisinden ekmek kırıntısı: son öğe bu kategori, öncekiler (slug bilinmiyorsa) yalnızca ad olarak.
      const idx = catState.trail.findIndex((t) => t.category === c.category);
      if (idx >= 0) catState.trail = catState.trail.slice(0, idx + 1);
      else catState.trail.push({ category: c.category, name: c.name });
      renderCrumbs(names);
      let html = `<h3 class="oz-section-title">${esc(c.name)} <small class="hint">(${num(c.product_count)} ürün)</small></h3>
        <div class="oz-actions"><button data-act="cat-filter" data-category="${esc(c.category)}">Parametrik filtrele</button><button data-act="cat-search" data-category="${esc(c.category)}">Bu kategoride ara</button>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">ozdisan.com'da aç ↗</a>` : ""}</div>`;
      if (d.subcategories?.length) html += `<ul class="oz-catlist">${d.subcategories.map((s) => catRow(s, "ürün", s.product_count)).join("")}</ul>`;
      html += info(d.note);
      return html;
    });
  }

  function renderCrumbs() {
    const el = qs("#oz-c-crumbs");
    el.innerHTML = `<button class="btn-link" data-act="cat-browse" data-category="">Tüm kategoriler</button>` +
      catState.trail.map((t) => `<span>›</span><button class="btn-link" data-act="cat-browse" data-category="${esc(t.category)}">${esc(t.name)}</button>`).join("");
  }

  // ---------------------------------------------------------------- 3) Parametrik filtre
  const F = {
    meta: null,          // get_category_filters yanıtı
    selected: {},        // propId -> Set(değer)
    contains: {},        // propId -> metin
    ranges: {},          // propId -> {min, max, unit}
    page: 1,
    availTimer: null,
  };

  function buildFilter() {
    const p = qs("#oz-tab-filter");
    p.innerHTML = `<h2>Parametrik Filtre</h2>
      <p class="lead">ozdisan.com'daki filtre paneliyle aynı: değer seçimleri, birimli sayısal aralıklar, üretici, stok/RoHS/datasheet bayrakları, sıralama ve sayfalama. Seçtikçe kalan ürün sayısı ve hâlâ seçilebilir değerler güncellenir.</p>
      <form class="oz-form" id="oz-f-load">
        <div class="f wide"><label for="oz-f-category">Kategori</label><input type="text" id="oz-f-category" required placeholder="ör. lineer-voltaj-regulatorleri-279 veya 'Lineer Voltaj Regülatörleri'"></div>
        <button class="primary" type="submit">Filtreleri yükle</button>
      </form>
      <div class="oz-out" id="oz-f-meta"></div>`;
    qs("#oz-f-load").addEventListener("submit", (e) => { e.preventDefault(); loadFilters(qs("#oz-f-category").value.trim()); });
  }

  function openFilter(category) {
    qs("#oz-f-category").value = category;
    go("filter");
    loadFilters(category);
  }

  function loadFilters(category) {
    if (!category) return;
    F.meta = null; F.selected = {}; F.contains = {}; F.ranges = {}; F.page = 1;
    run(qs("#oz-f-meta"), "get_category_filters", { category, max_values: 1000 }, (d) => {
      F.meta = d;
      return filterLayout(d);
    }, {
      after: (d, isError) => {
        if (isError) return;
        qs("#oz-f-category").value = d.category.category;
        bindFilterEvents();
      },
    });
  }

  function filterLayout(d) {
    const c = d.category;
    const sortOpts = (d.sort_by || []).map((s) => `<option value="${esc(s)}">${esc(({ price: "Fiyat", stock: "Stok", manufacturer: "Üretici", moq: "MOQ" })[s] || s)}</option>`).join("");
    const props = (d.properties || []).map(propCard).join("");
    return `<div class="status"><span><b>${esc(c.name)}</b> · ${num(d.total_products)} ürün</span><span class="hint">${esc(c.path || "")}</span>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">ozdisan.com ↗</a>` : ""}</div>
      <div class="oz-filter">
        <div>
          <div class="oz-count" id="oz-f-count">Filtre seçilmedi</div>
          <div class="oz-form" style="margin-bottom:8px">
            <div class="f wide"><label for="oz-f-query">Kategori içinde anahtar kelime</label><input type="text" id="oz-f-query" placeholder="ör. 1117"></div>
          </div>
          <div class="checks" style="margin-bottom:10px">
            <label><input type="checkbox" id="oz-f-in_stock"> Stokta</label>
            <label><input type="checkbox" id="oz-f-has_upcoming_stock"> Gelecek stok</label>
            <label><input type="checkbox" id="oz-f-has_datasheet"> Datasheet var</label>
            <label><input type="checkbox" id="oz-f-discounted"> İndirimli</label>
            <label>RoHS <select id="oz-f-rohs" style="width:auto;padding:2px 4px"><option value="">fark etmez</option><option value="true">uyumlu</option><option value="false">uyumsuz</option></select></label>
          </div>
          <div class="oz-props" id="oz-f-props">${props || info("Bu kategoride filtrelenebilir özellik yok.")}</div>
        </div>
        <div>
          <div class="oz-form">
            <div class="f"><label for="oz-f-sort">Sıralama</label><select id="oz-f-sort"><option value="">Site varsayılanı</option>${sortOpts}</select></div>
            <div class="f"><label for="oz-f-order">Yön</label><select id="oz-f-order"><option value="">Varsayılan</option><option value="asc">Artan</option><option value="desc">Azalan</option></select></div>
            <div class="f" style="width:110px"><label for="oz-f-qty">Adet (fiyat için)</label><input type="number" id="oz-f-qty" min="1" placeholder="ör. 100"></div>
            <div class="f" style="width:100px"><label for="oz-f-size">Sayfa boyutu</label><input type="number" id="oz-f-size" min="1" max="100" value="20"></div>
            <div class="f check"><input type="checkbox" id="oz-f-specs" checked><label for="oz-f-specs">Özellikler</label></div>
            <button class="primary" type="button" id="oz-f-run">Ürünleri listele</button>
            <button type="button" id="oz-f-clear">Temizle</button>
          </div>
          <div class="oz-out" id="oz-f-out">${info("Filtreleri seçip 'Ürünleri listele'ye basın.")}</div>
        </div>
      </div>`;
  }

  function propCard(p) {
    const isMfr = p.id === "Manufacturer";
    const numeric = p.type === "numeric";
    const opts = (p.options || []).map((v) => `<label><input type="checkbox" data-pid="${esc(p.id)}" value="${esc(v)}"> <span>${esc(v)}</span></label>`).join("");
    return `<details class="oz-prop" data-pid="${esc(p.id)}" ${isMfr ? "open" : ""}>
      <summary><span><b>${esc(p.name)}</b> <small>${numeric ? "sayısal" : "metin"} · ${num(p.option_count)} seçenek</small></span><span class="selcount" hidden></span></summary>
      <div class="body">
        ${numeric ? `<div class="row"><input type="number" step="any" placeholder="en az" data-range="min" data-pid="${esc(p.id)}"><input type="number" step="any" placeholder="en çok" data-range="max" data-pid="${esc(p.id)}">
          <select data-range="unit" data-pid="${esc(p.id)}" title="Birim">${(p.units || []).map((u) => `<option>${esc(u)}</option>`).join("") || "<option value=''>-</option>"}</select></div>
          <small class="hint">Aralıkla kesişen değerler (ör. ayarlanabilir 1.2–37 V) dahil edilir.</small>` : ""}
        ${!isMfr && !numeric ? `<input type="text" placeholder="İçeren metin (ör. SOT23 → SOT23-3, SOT23-5…)" data-contains data-pid="${esc(p.id)}">` : ""}
        ${(p.options || []).length > 8 ? `<input type="text" placeholder="Seçeneklerde ara" data-optsearch>` : ""}
        <div class="oz-opts">${opts}</div>
        ${p.more_options ? `<small class="hint">+${num(p.more_options)} seçenek daha listelenmedi.</small>` : ""}
      </div></details>`;
  }

  function bindFilterEvents() {
    const box = qs("#oz-tab-filter");
    const changed = () => { updateSelCounts(); scheduleAvailability(); };
    box.querySelectorAll(".oz-opts input[type=checkbox]").forEach((cb) => cb.addEventListener("change", () => {
      const set = (F.selected[cb.dataset.pid] ||= new Set());
      cb.checked ? set.add(cb.value) : set.delete(cb.value);
      changed();
    }));
    box.querySelectorAll("[data-range]").forEach((inp) => inp.addEventListener("change", () => {
      const r = (F.ranges[inp.dataset.pid] ||= { min: "", max: "", unit: "" });
      r[inp.dataset.range] = inp.value;
      if (inp.dataset.range !== "unit") r.unit = inp.closest(".row")?.querySelector("select[data-range=unit]")?.value || "";
      changed();
    }));
    box.querySelectorAll("[data-contains]").forEach((inp) => inp.addEventListener("change", () => { F.contains[inp.dataset.pid] = inp.value; changed(); }));
    box.querySelectorAll("[data-optsearch]").forEach((inp) => inp.addEventListener("input", () => {
      const q = inp.value.toLocaleLowerCase("tr");
      inp.parentElement.querySelectorAll(".oz-opts label").forEach((l) => l.classList.toggle("hide", !!q && !l.textContent.toLocaleLowerCase("tr").includes(q)));
    }));
    qs("#oz-f-query").addEventListener("change", scheduleAvailability);
    qs("#oz-f-run").addEventListener("click", () => { F.page = 1; runFilter(); });
    qs("#oz-f-clear").addEventListener("click", () => { loadFilters(qs("#oz-f-category").value.trim()); });
  }

  function updateSelCounts() {
    qsa("#oz-f-props .oz-prop").forEach((el) => {
      const pid = el.dataset.pid;
      const r = F.ranges[pid];
      const n = (F.selected[pid]?.size || 0) + (F.contains[pid]?.trim() ? 1 : 0) + (r && (r.min !== "" || r.max !== "") ? 1 : 0);
      const badge = qs(".selcount", el);
      badge.hidden = n === 0;
      badge.textContent = n;
    });
  }

  /** Mevcut seçimlerden filtreleme parametrelerini üretir. */
  function filterSpec() {
    const filters = [], ranges = [], manufacturers = [];
    for (const p of F.meta?.properties || []) {
      const sel = [...(F.selected[p.id] || [])];
      if (p.id === "Manufacturer") { manufacturers.push(...sel); continue; }
      if (sel.length) filters.push({ property: p.id, values: sel });
      const c = (F.contains[p.id] || "").trim();
      if (c) filters.push({ property: p.id, values: [c], match: "contains" });
      const r = F.ranges[p.id];
      if (r && (r.min !== "" || r.max !== "")) {
        ranges.push({ property: p.id, min: toNum(r.min), max: toNum(r.max), unit: r.unit || undefined });
      }
    }
    const query = qs("#oz-f-query")?.value.trim() || undefined;
    return { filters: filters.length ? filters : undefined, ranges: ranges.length ? ranges : undefined, manufacturers: manufacturers.length ? manufacturers : undefined, query };
  }

  function scheduleAvailability() {
    clearTimeout(F.availTimer);
    F.availTimer = setTimeout(checkAvailability, 500);
  }

  let availCtrl;
  async function checkAvailability() {
    const spec = filterSpec();
    const countEl = qs("#oz-f-count");
    const any = spec.filters || spec.ranges || spec.manufacturers || spec.query;
    if (!any) {
      countEl.textContent = "Filtre seçilmedi";
      qsa("#oz-f-props .oz-opts label").forEach((l) => l.classList.remove("na"));
      return;
    }
    availCtrl?.abort();
    availCtrl = new AbortController();
    countEl.innerHTML = `<span class="spinner"></span> Kalan ürünler hesaplanıyor…`;
    try {
      const res = await call("get_category_filters", { category: F.meta.category.category, max_values: 1000, ...spec }, availCtrl.signal);
      if (res.isError) { countEl.innerHTML = errorBox(res.data); return; }
      const d = res.data;
      // get_category_filters stok/RoHS/datasheet bayraklarını almaz; sayı bu bayraklar uygulanmadan hesaplanır.
      const flagsOn = ["in_stock", "has_upcoming_stock", "has_datasheet", "discounted"].some((f) => qs("#oz-f-" + f)?.checked) || !!qs("#oz-f-rohs")?.value;
      countEl.innerHTML = `Bu filtrelerle <b>${num(d.matching_products)}</b> ürün` +
        (flagsOn ? ` <small class="hint">(stok/RoHS/datasheet bayrakları hariç)</small>` : "") +
        (d.applied_filters?.length ? `<br><small class="hint">${d.applied_filters.map(esc).join(" · ")}</small>` : "");
      const avail = new Map((d.properties || []).map((p) => [p.id, new Set(p.options || [])]));
      qsa("#oz-f-props .oz-opts input[type=checkbox]").forEach((cb) => {
        const set = avail.get(cb.dataset.pid);
        cb.closest("label").classList.toggle("na", !cb.checked && !!set && !set.has(cb.value));
      });
    } catch (e) {
      if (e.name !== "AbortError") countEl.textContent = "Kalan ürün sayısı alınamadı";
    }
  }

  function runFilter() {
    const spec = filterSpec();
    const flags = {};
    for (const f of ["in_stock", "has_upcoming_stock", "has_datasheet", "discounted"]) if (qs("#oz-f-" + f).checked) flags[f] = true;
    const rohs = qs("#oz-f-rohs").value;
    if (rohs) flags.rohs = rohs === "true";
    const sortBy = qs("#oz-f-sort").value;
    const quantity = toNum(qs("#oz-f-qty").value);
    const args = {
      category: F.meta.category.category,
      ...spec,
      ...flags,
      sort: sortBy ? { by: sortBy, order: qs("#oz-f-order").value || undefined } : undefined,
      quantity,
      page: F.page,
      page_size: toNum(qs("#oz-f-size").value) || 20,
      include_specs: qs("#oz-f-specs").checked,
    };
    run(qs("#oz-f-out"), "filter_products", args, (d) => {
      const pager = d.total_pages > 1 ? `<div class="oz-pager">
          <button class="btn-s" data-fpage="-1" ${d.page <= 1 ? "disabled" : ""}>‹ Önceki</button>
          <span>Sayfa ${num(d.page)} / ${num(d.total_pages)}</span>
          <button class="btn-s" data-fpage="1" ${d.page >= d.total_pages ? "disabled" : ""}>Sonraki ›</button></div>` : "";
      return `<div class="status"><span><b>${num(d.total_matches)}</b> ürün</span><span>Para birimi: ${esc(d.currency)}</span></div>
        ${d.applied_filters?.length ? `<div class="chips" style="margin-bottom:6px">${d.applied_filters.map((a) => `<span class="oz-chip static">${esc(a)}</span>`).join("")}</div>` : ""}
        ${pager}${productTable(d.products, { quantity: args.quantity, empty: "Hiç ürün eşleşmedi." })}${pager}${info(d.note, d.total_matches === 0 ? "warn" : "")}`;
    }, {
      after: () => {
        // Sayfalayıcı üstte ve altta: ikisi de aynı işi yapar
        qsa("#oz-f-out [data-fpage]").forEach((b) => b.addEventListener("click", () => {
          F.page += Number(b.dataset.fpage);
          runFilter();
          qs("#oz-f-out").scrollIntoView({ behavior: "smooth", block: "start" });
        }));
      },
    });
  }

  // ---------------------------------------------------------------- 4) Ürün detayı
  function buildProduct() {
    const p = qs("#oz-tab-product");
    p.innerHTML = `<h2>Ürün Detayı</h2>
      <p class="lead">Ürün kodu (ör. <code>368374</code>), ozdisan.com ürün bağlantısı veya birebir parça numarası (ör. <code>STM32F103C8T6</code>).</p>
      <form class="oz-form" id="oz-p-form">
        <div class="f wide"><label for="oz-p-product">Ürün</label><input type="text" id="oz-p-product" required placeholder="kod, URL veya parça no"></div>
        <div class="f check"><input type="checkbox" id="oz-p-alt"><label for="oz-p-alt">Muadilleri de getir</label></div>
        <button class="primary" type="submit">Getir</button>
      </form>
      <div class="oz-out" id="oz-p-out"></div>`;
    qs("#oz-p-form").addEventListener("submit", (e) => { e.preventDefault(); loadProduct(); });
  }

  function openProduct(product) {
    qs("#oz-p-product").value = product;
    go("product");
    loadProduct();
  }

  /** Adet için fiyat hesabı: MOQ ve sipariş katına göre yukarı yuvarlar, uygun fiyat kırılımını seçer (yalnızca gösterim). */
  function priceForQty(breaks, qty, moq = 1, multiple = 1) {
    const m = Math.max(1, multiple || 1);
    let q = Math.max(qty, moq || 1);
    if (q % m) q = Math.ceil(q / m) * m;
    const sorted = [...breaks].sort((a, b) => a.qty - b.qty);
    let at;
    for (const b of sorted) if (q >= b.qty) at = b;
    if (!at && sorted.length) { at = sorted[0]; q = Math.max(q, at.qty); if (q % m) q = Math.ceil(q / m) * m; }
    return at ? { orderQty: q, unit: at.unit_price, total: Math.round(at.unit_price * q * 100) / 100 } : null;
  }

  function loadProduct() {
    const args = { product: qs("#oz-p-product").value.trim(), include_alternatives: qs("#oz-p-alt").checked || undefined };
    if (!args.product) return;
    run(qs("#oz-p-out"), "get_product", args, (d) => {
      const pr = d.pricing || {};
      const cur = pr.currency || state.currency;
      const breaks = pr.price_breaks || [];
      const kv = [
        ["Üretici", d.manufacturer], ["Durum", d.status], ["RoHS", d.rohs == null ? null : d.rohs ? "Uyumlu" : "Uyumsuz"],
        ["Stok", d.stock > 0 ? num(d.stock) : "Stokta yok"], ["Gelecek stok", d.upcoming_stock ? num(d.upcoming_stock) : null],
        ["Tedarik süresi", d.lead_time], ["Min. sipariş (MOQ)", d.moq ? num(d.moq) : null], ["Sipariş katı", d.order_multiple ? num(d.order_multiple) : null],
        ["MPQ", d.mpq ? num(d.mpq) : null], ["Paket", d.package], ["Etiketler", d.tags?.join(", ")],
      ].filter(([, v]) => v != null && v !== "");
      let html = `<div class="oz-detail">
        <div>${d.image ? `<img src="${esc(d.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</div>
        <div>
          <h3>${esc(d.part_number)} <small class="hint">#${esc(d.product)}</small></h3>
          <div>${esc(d.description || "")}</div>
          ${d.detailed_description ? `<div class="hint">${esc(d.detailed_description)}</div>` : ""}
          ${d.category ? `<div style="margin-top:6px"><small class="hint">${esc((d.category.path || []).join(" › "))}</small> <button class="btn-s" data-act="cat-filter" data-category="${esc(d.category.category)}">Kategoride filtrele</button></div>` : ""}
          <dl class="oz-kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
          <div class="oz-actions">
            <button data-act="alt" data-product="${esc(d.product)}">Muadil / benzer bul</button>
            <button data-act="cmp-add" data-product="${esc(d.product)}" data-label="${esc(d.part_number)}">Karşılaştırmaya ekle</button>
            <button data-act="bom-add" data-product="${esc(d.part_number)}">BOM'a ekle</button>
            ${d.datasheet_url ? `<button data-act="ds-read" data-product="${esc(d.product)}">Datasheet oku</button>
              <a href="${API}/datasheet?product=${encodeURIComponent(d.product)}">Datasheet indir (PDF)</a>
              <a href="${esc(d.datasheet_url)}" target="_blank" rel="noopener">Datasheet kaynağı ↗</a>` : `<span class="hint">Datasheet yok</span>`}
            <a href="${esc(d.url)}" target="_blank" rel="noopener">ozdisan.com'da aç ↗</a>
          </div>
        </div></div>`;

      html += `<h3 class="oz-section-title">Fiyat (${esc(cur)}, KDV hariç)</h3>`;
      if (pr.price_on_request || pr.price_unavailable) html += info(pr.note, "warn");
      else {
        html += `<div class="oz-tablewrap" style="max-width:520px"><table class="oz-table"><thead><tr><th class="num">Adet</th><th class="num">Birim fiyat</th></tr></thead><tbody>${breaks.map((b) => `<tr><td class="num">${num(b.qty)}+</td><td class="num">${money(b.unit_price, cur)}</td></tr>`).join("")}</tbody></table></div>
          <div class="oz-form"><div class="f" style="width:140px"><label for="oz-p-qty">Adet hesapla</label><input type="number" id="oz-p-qty" min="1" value="${d.moq || 1}"></div><div id="oz-p-calc" class="hint" style="padding-bottom:8px"></div></div>
          ${info(pr.note)}`;
      }

      html += `<h3 class="oz-section-title">Teknik özellikler</h3><div class="oz-tablewrap" style="max-width:720px"><table class="oz-table"><tbody>${Object.entries(d.specs || {}).map(([k, v]) => `<tr><td style="width:40%" class="hint">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("") || `<tr><td>Özellik bilgisi yok</td></tr>`}</tbody></table></div>`;

      if (d.other_media?.length) html += `<h3 class="oz-section-title">Diğer dosyalar</h3><div class="chips">${d.other_media.map((m) => `<a class="oz-chip" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.type)} ↗</a>`).join("")}</div>`;
      if (d.other_products_with_same_part_number?.length) {
        html += `<h3 class="oz-section-title">Aynı parça numarasıyla diğer ilanlar</h3><div class="chips">${d.other_products_with_same_part_number.map((o) => `<button class="oz-chip" data-act="detail" data-product="${esc(o.erpRefId)}" title="${esc(o.description || "")}">${esc(o.sku)} <small>#${esc(o.erpRefId)}</small></button>`).join("")}</div>`;
      }
      if (d.alternatives) html += altGroups(d.alternatives, d.alternative_counts);
      html += info(d.alternatives_note, "warn");
      return html;
    }, {
      after: (d, isError) => {
        if (isError) return;
        const inp = qs("#oz-p-qty");
        if (!inp) return;
        const calc = () => {
          const r = priceForQty(d.pricing?.price_breaks || [], Number(inp.value) || 1, d.moq, d.order_multiple);
          const cur = d.pricing?.currency || state.currency;
          qs("#oz-p-calc").innerHTML = r ? `Sipariş adedi <b>${num(r.orderQty)}</b> · birim <b>${money(r.unit, cur)}</b> · toplam <b>${money(r.total, cur)}</b>${r.orderQty > (Number(inp.value) || 1) ? " (MOQ / sipariş katı / fiyat kırılımı nedeniyle yukarı yuvarlandı)" : ""}` : "";
        };
        inp.addEventListener("input", calc);
        calc();
      },
    });
  }

  function altGroups(groups, counts) {
    let html = "";
    for (const [key, list] of Object.entries(groups || {})) {
      if (!Array.isArray(list)) continue;
      html += `<h3 class="oz-section-title">${esc(ALT_LABELS[key] || key)} <small class="hint">(${num(counts?.[key] ?? list.length)})</small></h3>${productTable(list)}`;
    }
    return html;
  }

  // ---------------------------------------------------------------- 5) Muadiller
  function buildAlternatives() {
    const p = qs("#oz-tab-alternatives");
    p.innerHTML = `<h2>Muadil ve Benzer Ürünler</h2>
      <p class="lead">Stokta olmayan, üretimi biten (EOL) veya pahalı bir parça için birebir muadil, benzer, aksesuar ve aynı ana özelliklere sahip parametrik eşdeğerler.</p>
      <form class="oz-form" id="oz-a-form">
        <div class="f wide"><label for="oz-a-product">Ürün</label><input type="text" id="oz-a-product" required placeholder="kod, URL veya parça no (ör. LM317T)"></div>
        <div class="f"><label>Türler</label><div class="checks">${ALT_TYPES.map(([v, l]) => `<label><input type="checkbox" name="oz-a-type" value="${v}" checked> ${esc(l)}</label>`).join("")}</div></div>
        <div class="f" style="width:110px"><label for="oz-a-limit">Tür başına</label><input type="number" id="oz-a-limit" min="1" max="50" value="10"></div>
        <button class="primary" type="submit">Bul</button>
      </form>
      <div class="oz-out" id="oz-a-out"></div>`;
    qs("#oz-a-form").addEventListener("submit", (e) => { e.preventDefault(); loadAlternatives(); });
  }

  function openAlternatives(product) {
    qs("#oz-a-product").value = product;
    go("alternatives");
    loadAlternatives();
  }

  function loadAlternatives() {
    const types = qsa("input[name=oz-a-type]:checked").map((c) => c.value);
    const args = { product: qs("#oz-a-product").value.trim(), types: types.length ? types : undefined, limit: toNum(qs("#oz-a-limit").value) || 10 };
    if (!args.product) return;
    run(qs("#oz-a-out"), "get_alternatives", args, (d) => {
      const groups = {};
      for (const k of Object.keys(ALT_LABELS)) if (Array.isArray(d[k])) groups[k] = d[k];
      return `<div class="status"><span>Kaynak: <button class="btn-link" data-act="detail" data-product="${esc(d.product)}"><b>${esc(d.part_number)}</b></button> · ${esc(d.manufacturer || "")} · stok ${d.stock > 0 ? num(d.stock) : `<span class="stock-0">yok</span>`}</span></div>
        ${altGroups(groups, d.counts)}${info(d.note, "warn")}`;
    });
  }

  // ---------------------------------------------------------------- 6) Karşılaştır
  function buildCompare() {
    const p = qs("#oz-tab-compare");
    p.innerHTML = `<h2>Ürünleri Karşılaştır</h2>
      <p class="lead">2–10 ürünü özellik özellik karşılaştırır; farklı olan özellikler vurgulanır. Listelerdeki <b>+Karş.</b> düğmesiyle ekleyin veya aşağıya yazın.</p>
      <div class="chips" id="oz-cmp-list" style="margin-bottom:10px"></div>
      <form class="oz-form" id="oz-cmp-form">
        <div class="f wide"><label for="oz-cmp-add">Ürün ekle (virgülle birden fazla)</label><input type="text" id="oz-cmp-add" placeholder="ör. NE555P, NE555DR, 14278"></div>
        <button type="submit">Ekle</button>
        <div class="f" style="width:120px"><label for="oz-cmp-qty">Fiyat adedi</label><input type="number" id="oz-cmp-qty" min="1" value="1"></div>
        <div class="f check"><input type="checkbox" id="oz-cmp-diff"><label for="oz-cmp-diff">Yalnızca farklı özellikler</label></div>
        <button class="primary" type="button" id="oz-cmp-run">Karşılaştır</button>
        <button type="button" id="oz-cmp-clear">Listeyi temizle</button>
      </form>
      <div class="oz-out" id="oz-cmp-out"></div>`;
    qs("#oz-cmp-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = qs("#oz-cmp-add");
      inp.value.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).forEach((s) => addCompare(s, s, true));
      inp.value = "";
    });
    qs("#oz-cmp-run").addEventListener("click", runCompare);
    qs("#oz-cmp-clear").addEventListener("click", () => { state.compare = []; saveCompare(); });
    qs("#oz-cmp-diff").addEventListener("change", () => qsa("#oz-cmp-out tr.same").forEach((r) => { r.hidden = qs("#oz-cmp-diff").checked; }));
    qs("#oz-cmp-list").addEventListener("click", (e) => {
      const x = e.target.closest(".x");
      if (!x) return;
      state.compare = state.compare.filter((c) => c.product !== x.dataset.product);
      saveCompare();
    });
  }

  function addCompare(product, label, silent) {
    if (!product) return;
    if (state.compare.some((c) => c.product === product)) { if (!silent) toast(`${label || product} zaten listede`); return; }
    if (state.compare.length >= 10) { toast("En fazla 10 ürün karşılaştırılabilir"); return; }
    state.compare.push({ product, label: label || product });
    saveCompare();
    if (!silent) toast(`${label || product} karşılaştırmaya eklendi (${state.compare.length})`);
  }

  function saveCompare() { store.set("compare", state.compare); updateBaskets(); }

  function runCompare() {
    if (state.compare.length < 2) { qs("#oz-cmp-out").innerHTML = info("Karşılaştırmak için en az 2 ürün ekleyin.", "warn"); return; }
    const args = { products: state.compare.map((c) => c.product), quantity: toNum(qs("#oz-cmp-qty").value) || 1 };
    run(qs("#oz-cmp-out"), "compare_products", args, (d) => {
      const cols = d.columns || [];
      const cur = d.currency;
      const prices = cols.map((c) => c.unit_price).filter((x) => x != null);
      const minPrice = prices.length ? Math.min(...prices) : null;
      const maxStock = Math.max(...cols.map((c) => c.stock || 0));
      const row = (label, cells, cls) => `<tr class="${cls || ""}"><td class="hint">${esc(label)}</td>${cells.join("")}</tr>`;
      const diff = new Set(d.differing_specs || []);
      let body = "";
      body += row("Üretici", cols.map((c) => `<td>${esc(c.manufacturer || "")}</td>`));
      body += row("Açıklama", cols.map((c) => `<td class="desc">${esc(c.description || "")}</td>`));
      body += row("Kategori", cols.map((c) => `<td>${esc(c.category || "")}</td>`));
      body += row("Durum", cols.map((c) => `<td>${esc(c.status || "")}</td>`));
      body += row("Stok", cols.map((c) => `<td class="num ${c.stock && c.stock === maxStock ? "best" : ""}">${c.stock > 0 ? num(c.stock) : '<span class="stock-0">Yok</span>'}</td>`));
      body += row("Tedarik süresi", cols.map((c) => `<td>${esc(c.lead_time || "-")}</td>`));
      body += row("MOQ", cols.map((c) => `<td class="num">${c.moq ? num(c.moq) : "-"}</td>`));
      body += row(`Birim fiyat (${num(d.quantity)} adet)`, cols.map((c) => `<td class="num ${c.unit_price != null && c.unit_price === minPrice ? "best" : ""}">${c.price_on_request ? '<span class="hint">Teklif</span>' : money(c.unit_price, cur)}</td>`));
      body += row("Datasheet", cols.map((c) => `<td>${c.datasheet_url ? `<button class="btn-s" data-act="ds-read" data-product="${esc(c.product)}">Oku</button><a class="btn-s" href="${API}/datasheet?product=${encodeURIComponent(c.product)}">PDF</a>` : "-"}</td>`));
      for (const [name, values] of Object.entries(d.specs || {})) {
        body += row(name, values.map((v) => `<td>${esc(v ?? "—")}</td>`), diff.has(name) ? "diff" : "same");
      }
      const head = `<tr><th></th>${cols.map((c) => `<th><button class="btn-link" data-act="detail" data-product="${esc(c.product)}">${esc(c.part_number)}</button><br><small>#${esc(c.product)}</small>${c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">↗</a>` : ""}</th>`).join("")}</tr>`;
      let html = `<div class="status"><span>${cols.length} ürün · ${diff.size} özellik farklı</span><span class="hint">Yeşil: en düşük fiyat / en yüksek stok · Sarı: farklı özellik</span></div>
        <div class="oz-tablewrap"><table class="oz-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
      if (d.not_found?.length) html += errorBox({ error: "Bulunamayan ürünler", not_found: d.not_found.map((n) => `${n.input}: ${n.error}`) });
      if (d.duplicates_skipped?.length) html += info("Aynı ürüne çözümlendiği için atlananlar: " + d.duplicates_skipped.join(", "), "warn");
      return html;
    }, { after: () => { if (qs("#oz-cmp-diff").checked) qsa("#oz-cmp-out tr.same").forEach((r) => { r.hidden = true; }); } });
  }

  // ---------------------------------------------------------------- 7) BOM
  function buildBom() {
    const p = qs("#oz-tab-bom");
    p.innerHTML = `<h2>BOM (Malzeme Listesi) Kontrolü</h2>
      <p class="lead">Her satır: <code>parça_no adet [referans]</code>. Excel/CSV'den yapıştırabilirsiniz (sekme, virgül veya noktalı virgül ayraçlı). Her kalem için MOQ/sipariş katı, fiyat kırılımı, stok, EOL ve teklif durumu kontrol edilir; KDV hariç toplam hesaplanır.</p>
      <textarea id="oz-bom-text" rows="9" placeholder="STM32F103C8T6 1 U1&#10;AMS1117-3.3 1 U2&#10;CL10B104KB8NNNC 12 C1-C12&#10;RC0603FR-0710KL 8 R1-R8"></textarea>
      <div class="oz-form" style="margin-top:10px">
        <div class="f" style="width:120px"><label for="oz-bom-boards">Kart sayısı</label><input type="number" id="oz-bom-boards" min="1" value="1"></div>
        <div class="f"><span class="hint" id="oz-bom-parsed"></span></div>
        <button class="primary" type="button" id="oz-bom-run">BOM'u kontrol et</button>
        <button type="button" id="oz-bom-clear">Temizle</button>
      </div>
      <div class="oz-out" id="oz-bom-out"></div>`;
    const ta = qs("#oz-bom-text");
    ta.value = store.get("bom", "");
    ta.addEventListener("input", () => { store.set("bom", ta.value); updateBaskets(); });
    qs("#oz-bom-run").addEventListener("click", runBom);
    qs("#oz-bom-clear").addEventListener("click", () => { ta.value = ""; store.set("bom", ""); updateBaskets(); qs("#oz-bom-out").innerHTML = ""; });
  }

  function parseBom(text) {
    const items = [], errors = [];
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      let part, qty, ref;
      // Ayraç: sekme veya noktalı virgül (Excel/CSV); virgül yalnızca 2. hücre sayıysa ("NE555P,2,U1").
      // "NE555P 2 U1,U2" gibi boşluklu satırlarda referanstaki virgül ayraç sayılmaz.
      const sep = /[\t;]/.test(line) ? /[\t;]/ : /^[^,]+,\s*\d+\s*(,|$)/.test(line) ? /,/ : null;
      if (sep) {
        const cells = line.split(sep).map((s) => s.trim());
        [part, qty, ...ref] = cells;
        ref = ref.filter(Boolean).join(", ");
      } else {
        const tokens = line.split(/\s+/);
        const qi = tokens.findIndex((t, k) => k > 0 && /^\d+$/.test(t));
        if (qi > 0) { part = tokens.slice(0, qi).join(" "); qty = tokens[qi]; ref = tokens.slice(qi + 1).join(" "); }
        else { part = line; qty = "1"; }
      }
      const q = Number(qty || 1);
      if (!part) return;
      if (!Number.isInteger(q) || q < 1) {
        // Başlık satırı (ör. "Parça;Adet;Ref") sessizce atlanır
        if (i === 0 && /adet|qty|quantity|miktar/i.test(line)) return;
        errors.push(`Satır ${i + 1}: adet geçersiz ("${qty}")`);
        return;
      }
      items.push({ part, quantity: q, reference: ref || undefined });
    });
    return { items, errors };
  }

  function addBom(part, qty) {
    const ta = qs("#oz-bom-text");
    ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + `${part} ${qty || 1}`;
    store.set("bom", ta.value);
    updateBaskets();
    toast(`${part} BOM listesine eklendi`);
  }

  async function runBom() {
    const out = qs("#oz-bom-out");
    const { items, errors } = parseBom(qs("#oz-bom-text").value);
    if (errors.length) { out.innerHTML = errorBox({ error: "BOM satırları okunamadı", satirlar: errors }); return; }
    if (!items.length) { out.innerHTML = info("BOM boş. Her satıra 'parça_no adet' yazın.", "warn"); return; }
    const boards = toNum(qs("#oz-bom-boards").value) || 1;
    // Tek istekte en fazla 60 satır işlenir; büyük listeler parçalara bölünür.
    const chunks = [];
    for (let i = 0; i < items.length; i += 60) chunks.push(items.slice(i, i + 60));
    const btn = qs("#oz-bom-run");
    btn.disabled = true;
    const merged = { lines: [], total: 0, currency: state.currency };
    try {
      for (let i = 0; i < chunks.length; i++) {
        out.innerHTML = `<div class="oz-loading"><span class="spinner"></span>${items.length} kalem kontrol ediliyor${chunks.length > 1 ? ` (bölüm ${i + 1}/${chunks.length})` : ""} · kalem başına ~1 sn</div>`;
        const res = await call("check_bom", { items: chunks[i], boards });
        if (res.isError) { out.innerHTML = errorBox(res.data); return; }
        merged.lines.push(...res.data.lines);
        merged.total += res.data.total_excl_vat || 0;
        merged.currency = res.data.currency;
        merged.note = res.data.note;
      }
      out.innerHTML = renderBom(merged, boards);
      qs("#oz-bom-csv")?.addEventListener("click", () => downloadCsv(merged));
    } finally {
      btn.disabled = false;
    }
  }

  function renderBom(d, boards) {
    const cur = d.currency;
    const count = (s) => d.lines.filter((l) => l.status === s).length;
    const label = { ok: "Uygun", warning: "Uyarı", not_found: "Bulunamadı" };
    const rows = d.lines.map((l) => `<tr>
      <td>${esc(l.reference || "")}</td>
      <td class="part">${l.product ? `<button class="btn-link" data-act="detail" data-product="${esc(l.product)}">${esc(l.part_number)}</button>` : esc(l.input)}${l.part_number && l.part_number !== l.input ? `<br><small class="hint">girdi: ${esc(l.input)}</small>` : ""}</td>
      <td>${esc(l.manufacturer || "")}<br><small class="hint">${esc(l.description || "")}</small></td>
      <td class="num">${num(l.required_qty)}</td>
      <td class="num">${l.order_qty != null ? num(l.order_qty) : "-"}</td>
      <td class="num">${l.stock != null ? (l.stock > 0 ? num(l.stock) : '<span class="stock-0">0</span>') : "-"}</td>
      <td class="num">${l.unit_price != null ? money(l.unit_price, cur) : "-"}</td>
      <td class="num"><b>${l.line_total != null ? money(l.line_total, cur) : "-"}</b></td>
      <td><span class="badge ${esc(l.status)}">${esc(label[l.status] || l.status)}</span></td>
      <td>${(l.issues || []).map((i) => `<div>${esc(i)}</div>`).join("")}
        ${l.suggestions?.length ? `<div class="chips" style="margin-top:4px">${l.suggestions.map((s) => `<button class="oz-chip" data-act="detail" data-product="${esc(s.product)}" title="${esc(s.description || "")}">${esc(s.part_number)}</button>`).join("")}</div>` : ""}
        ${l.other_listings?.length ? `<div class="chips" style="margin-top:4px">${l.other_listings.map((o) => `<button class="oz-chip" data-act="detail" data-product="${esc(o)}">#${esc(o)}</button>`).join("")}</div>` : ""}
        ${l.status !== "ok" && l.product ? `<button class="btn-s" data-act="alt" data-product="${esc(l.product)}">Muadil bul</button>` : ""}
        ${l.status === "not_found" ? `<button class="btn-s" data-act="go-search" data-q="${esc(l.input)}">Ara</button>` : ""}</td>
    </tr>`).join("");
    return `<div class="oz-cards">
        <div class="oz-stat"><small>Toplam (KDV hariç)</small><b>${money(Math.round(d.total * 100) / 100, cur)}</b></div>
        <div class="oz-stat"><small>Kalem</small><b>${d.lines.length}</b></div>
        <div class="oz-stat"><small>Uygun</small><b>${count("ok")}</b></div>
        <div class="oz-stat"><small>Uyarı</small><b>${count("warning")}</b></div>
        <div class="oz-stat"><small>Bulunamadı</small><b>${count("not_found")}</b></div>
        <div class="oz-stat"><small>Kart sayısı</small><b>${num(boards)}</b></div>
      </div>
      <div class="oz-actions"><button id="oz-bom-csv">Sonucu CSV indir</button></div>
      <div class="oz-tablewrap"><table class="oz-table"><thead><tr><th>Ref</th><th>Parça</th><th>Üretici / açıklama</th><th class="num">Gerekli</th><th class="num">Sipariş</th><th class="num">Stok</th><th class="num">Birim</th><th class="num">Satır toplamı</th><th>Durum</th><th>Notlar</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${info(d.note)}`;
  }

  function downloadCsv(d) {
    const head = ["Referans", "Girdi", "Ozdisan kodu", "Parca no", "Uretici", "Aciklama", "Gerekli", "Siparis", "Stok", "Birim fiyat", "Satir toplami", "Para birimi", "Durum", "Notlar", "Link"];
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = d.lines.map((l) => [l.reference, l.input, l.product, l.part_number, l.manufacturer, l.description, l.required_qty, l.order_qty, l.stock,
      l.unit_price, l.line_total, d.currency, l.status, (l.issues || []).join(" | "), l.url].map(cell).join(";"));
    const csv = "﻿" + [head.map(cell).join(";"), ...lines].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "ozdisan-bom.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------- 8) Datasheet
  function buildDatasheet() {
    const p = qs("#oz-tab-datasheet");
    p.innerHTML = `<h2>Datasheet</h2>
      <p class="lead">Datasheet PDF'inden metin okuyun: önce anahtar kelimeyle ilgili sayfaları bulun (ör. <code>absolute maximum</code>, <code>pin configuration</code>, <code>typical application</code>), sonra sayfa aralığı okuyun. Tablolar düz metin olarak gelir; çizimler dahil değildir.</p>
      <form class="oz-form" id="oz-d-form">
        <div class="f wide"><label for="oz-d-product">Ürün</label><input type="text" id="oz-d-product" placeholder="kod, URL veya parça no"></div>
        <div class="f wide"><label for="oz-d-url">veya doğrudan PDF bağlantısı</label><input type="text" id="oz-d-url" placeholder="https://…pdf"></div>
        <div class="f wide"><label for="oz-d-search">Ara (virgülle birden fazla)</label><input type="text" id="oz-d-search" placeholder="ör. absolute maximum, dropout"></div>
        <div class="f" style="width:120px"><label for="oz-d-pages">Sayfalar</label><input type="text" id="oz-d-pages" placeholder="ör. 1-3,7"></div>
        <div class="f" style="width:120px"><label for="oz-d-max">En fazla karakter</label><input type="number" id="oz-d-max" min="1000" max="150000" value="25000"></div>
        <button class="primary" type="submit">Oku</button>
      </form>
      <div class="oz-actions" id="oz-d-dl"></div>
      <div class="oz-out" id="oz-d-out"></div>`;
    qs("#oz-d-form").addEventListener("submit", (e) => { e.preventDefault(); readDatasheet(); });
    qs("#oz-d-product").addEventListener("input", updateDlLinks);
    updateDlLinks();
  }

  function updateDlLinks() {
    const prod = qs("#oz-d-product").value.trim();
    qs("#oz-d-dl").innerHTML = prod
      ? `<a href="${API}/datasheet?product=${encodeURIComponent(prod)}" title="PDF olarak indir">PDF indir</a>
         <a href="${API}/datasheet?product=${encodeURIComponent(prod)}&inline=true" target="_blank" rel="noopener">Tarayıcıda aç ↗</a>
         <span class="hint">Dosya ayrıca ${esc(shortPath(state.status?.downloadDir) || "~/Downloads/ozdisan-datasheets")} klasörüne kaydedilir.</span>`
      : "";
  }

  /** Kullanıcı klasörünü gizler: C:\Users\ad\Downloads\x → ~\Downloads\x */
  function shortPath(p) {
    if (!p) return "";
    return p.replace(/^([A-Za-z]:)?[\\/](Users|home)[\\/][^\\/]+/i, "~");
  }

  function openDatasheet(product) {
    qs("#oz-d-product").value = product;
    qs("#oz-d-url").value = "";
    if (!qs("#oz-d-search").value) qs("#oz-d-search").value = "absolute maximum, pin configuration";
    updateDlLinks();
    go("datasheet");
    readDatasheet();
  }

  function highlight(text, terms) {
    let html = esc(text);
    for (const t of terms) {
      if (t.length < 2) continue;
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      html = html.replace(re, (m) => `<mark>${m}</mark>`);
    }
    return html;
  }

  function readDatasheet(pagesOverride) {
    const product = qs("#oz-d-product").value.trim();
    const url = qs("#oz-d-url").value.trim();
    if (!product && !url) { qs("#oz-d-out").innerHTML = info("Ürün veya PDF bağlantısı girin.", "warn"); return; }
    const search = qs("#oz-d-search").value.trim();
    const pages = pagesOverride ?? qs("#oz-d-pages").value.trim();
    if (pagesOverride) qs("#oz-d-pages").value = pagesOverride;
    const args = {
      product: product || undefined,
      url: product ? undefined : url,
      search: search || undefined,
      pages: pages || undefined,
      max_chars: toNum(qs("#oz-d-max").value) || 25000,
    };
    const terms = (search || "").split(",").map((s) => s.trim()).filter(Boolean);
    run(qs("#oz-d-out"), "read_datasheet", args, (d) => {
      let html = `<div class="status"><span>${d.part_number ? `<b>${esc(d.part_number)}</b> · ${esc(d.manufacturer || "")} · ` : ""}${num(d.total_pages)} sayfa</span>
        <a href="${esc(d.source_url)}" target="_blank" rel="noopener">Kaynak PDF ↗</a></div>`;
      html += info(d.warning, "warn");
      if (d.search_results?.length) {
        html += `<h3 class="oz-section-title">Arama sonuçları (alaka sırasına göre)</h3><div class="oz-tablewrap"><table class="oz-table"><thead><tr><th>Sayfa</th><th class="num">Eşleşme</th><th>Örnekler</th><th></th></tr></thead><tbody>${d.search_results.map((r) => `<tr>
          <td>${r.page}</td><td class="num">${r.hits ?? ""}</td>
          <td class="oz-snippet">${(r.snippets || []).map((s) => `<div>${highlight(s, terms)}</div>`).join("")}</td>
          <td><button class="btn-s" data-ds-page="${r.page}">Oku</button></td></tr>`).join("")}</tbody></table></div>`;
      }
      for (const pg of d.pages || []) {
        html += `<div class="oz-page"><header><span>Sayfa ${pg.page}</span><span class="hint">${num(pg.text.length)} karakter</span></header><pre>${highlight(pg.text, terms)}</pre></div>`;
      }
      if (d.truncated) html += info("Metin sınırına ulaşıldı; devamını okumak için aşağıdaki düğmeyi kullanın veya 'En fazla karakter' değerini artırın.", "warn");
      if (d.search_results?.length && !args.pages) html += info("Sayfalar alaka sırasına göre gösterilir. Bir tablo sonraki sayfada devam ediyorsa 'Sayfalar' alanından o sayfayı okuyun.");
      const m = /pages="([^"]+)"/.exec(d.next || "");
      if (m) html += `<div class="oz-actions"><button data-ds-pages="${esc(m[1])}">Devamını oku (sayfa ${esc(m[1])})</button></div>`;
      return html;
    }, {
      loadingText: "Datasheet indiriliyor ve metne çevriliyor",
      after: () => {
        qsa("#oz-d-out [data-ds-page]").forEach((b) => b.addEventListener("click", () => readDatasheet(b.dataset.dsPage)));
        qsa("#oz-d-out [data-ds-pages]").forEach((b) => b.addEventListener("click", () => readDatasheet(b.dataset.dsPages)));
      },
    });
  }

  // ---------------------------------------------------------------- sepet sayaçları
  function updateBaskets() {
    const c = qs("#oz-cmp-count");
    if (!c) return;
    c.textContent = state.compare.length;
    qs("#oz-bom-count").textContent = parseBom(qs("#oz-bom-text")?.value ?? store.get("bom", "")).items.length;
    const list = qs("#oz-cmp-list");
    if (list) {
      list.innerHTML = state.compare.length
        ? state.compare.map((x) => `<span class="oz-chip static">${esc(x.label)}${x.label !== x.product ? ` <small>#${esc(x.product)}</small>` : ""}<button class="x" data-product="${esc(x.product)}" title="Çıkar">×</button></span>`).join("")
        : `<span class="hint">Liste boş.</span>`;
    }
    const parsed = qs("#oz-bom-parsed");
    if (parsed) {
      const r = parseBom(qs("#oz-bom-text").value);
      parsed.textContent = r.items.length ? `${r.items.length} kalem${r.items.length > 60 ? ` (${Math.ceil(r.items.length / 60)} parçada gönderilecek)` : ""}${r.errors.length ? ` · ${r.errors.length} hatalı satır` : ""}` : "";
    }
  }

  // ---------------------------------------------------------------- dış arayüz
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act=go-search]");
    if (!el) return;
    e.preventDefault();
    openSearch(el.dataset.q, "");
  });

  window.Ozdisan = {
    activate() {
      if (!state.started) { state.started = true; shell(); browse(""); }
      const m = /^#ozdisan\/(\w+)/.exec(location.hash);
      showTab(m ? m[1] : state.tab);
    },
  };
})();
