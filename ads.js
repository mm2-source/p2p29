/* eslint-disable no-console */

// ------------------------------------------------------------
// ads.js (CLEAN REWRITE)
// ------------------------------------------------------------
// Responsibilities:
// - Market Ads feed (P2P page)
// - Create/Edit Ad form (Firestore)
// - My Ads page (empty state + active ad card + edit/cancel)
// - Page navigation/header (+) visibility

(function () {
  const P2P = (window.P2P = window.P2P || {});
  P2P.state = P2P.state || {};

  const state = P2P.state;
  state.marketTab = state.marketTab || "buy";
  state.createMode = state.createMode || "buy";
  state.currentPageKey = state.currentPageKey || "p2p";

  const getDb = () => window.db;
  const getFieldValue = () => window.firebase?.firestore?.FieldValue;
  const ADS_COLLECTION = "ads";

  let unsubMarketAds = null;
  let unsubMyAds = null;

  function clearPublishErrorState() {
    state.lastPublishError = null;
    state.lastPublishErrorCode = null;
    try {
      sessionStorage.removeItem("ads_publish_error");
      sessionStorage.removeItem("ads_publish_error_code");
    } catch (_) {}
  }

  async function ensureFirestoreOnline(db) {
    if (!db || typeof db.enableNetwork !== "function") return;
    try {
      await db.enableNetwork();
    } catch (e) {
      console.warn("[ads] enableNetwork", e);
    }
  }

  function toast(msg) {
    if (typeof P2P.toast === "function") return P2P.toast(msg);
    console.log(msg);
  }

  function fmt2(n) {
    if (P2P.utils?.format2) return P2P.utils.format2(n);
    const v = Number(n);
    if (!Number.isFinite(v)) return "0.00";
    return v.toFixed(2);
  }

  async function addDoc(collectionRef, data) {
    if (!collectionRef || typeof collectionRef.add !== "function") {
      throw new Error("Invalid collection reference");
    }
    return await collectionRef.add(data);
  }


    // ── Inject blue-edit button + ads confirm modal CSS ──
    (function _injectAdsExtrasCSS() {
      if (document.getElementById("_adsExtrasCss")) return;
      const s = document.createElement("style");
      s.id = "_adsExtrasCss";
      s.textContent = `
        /* ── "تعديل الإعلان" — transparent blue (Binance/Instapay style) ── */
        .btn--edit {
          background: color-mix(in oklab, #2563eb 10%, transparent);
          border-color: color-mix(in oklab, #2563eb 24%, var(--line, rgba(0,0,0,.08)) 76%);
          color: #1d4ed8;
        }
        .btn--edit:active { background: color-mix(in oklab, #2563eb 18%, transparent); }

        /* ── Confirm modal overlay ── */
        #_adsConfirmModal {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.60);
          z-index: 99999;
          display: flex; align-items: center; justify-content: center;
          padding: 20px;
          font-family: "IBM Plex Sans Arabic", system-ui, sans-serif;
        }
        #_adsConfirmModal .cm__card {
          background: var(--panel, #fff);
          border-radius: 22px;
          padding: 28px 22px 22px;
          width: 100%; max-width: 340px;
          box-shadow: 0 24px 64px rgba(0,0,0,0.28);
          border: 1px solid var(--line, rgba(0,0,0,.08));
          direction: rtl; text-align: center;
        }
        #_adsConfirmModal .cm__icon {
          width: 56px; height: 56px;
          background: color-mix(in oklab, #dc2626 12%, transparent);
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          margin: 0 auto 16px;
          font-size: 24px; color: #dc2626;
        }
        #_adsConfirmModal .cm__title {
          font-size: 18px; font-weight: 800;
          color: var(--text, #0b0f19);
          margin-bottom: 8px;
        }
        #_adsConfirmModal .cm__msg {
          font-size: 14px; color: var(--muted, #6b7280);
          font-weight: 500; line-height: 1.6;
          margin-bottom: 24px;
        }
        #_adsConfirmModal .cm__actions {
          display: flex; gap: 10px;
        }
        #_adsConfirmModal .cm__cancel {
          flex: 1; padding: 14px;
          background: var(--chip, #f3f4f6);
          color: var(--text, #0b0f19);
          border: none; border-radius: 14px;
          font-size: 15px; font-weight: 700;
          cursor: pointer; font-family: inherit;
        }
        #_adsConfirmModal .cm__confirm {
          flex: 1; padding: 14px;
          background: #dc2626;
          color: #fff;
          border: none; border-radius: 14px;
          font-size: 15px; font-weight: 700;
          cursor: pointer; font-family: inherit;
        }
        #_adsConfirmModal .cm__confirm:active { opacity: .88; }
      `;
      document.head.appendChild(s);
    })();

  
  function setPage(pageId) {
    const pages = ["marketPage", "createAdPage", "ordersPage", "adsPage", "chatPage", "profilePage"];
    for (const id of pages) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("page--active", id === pageId);
    }
    const bottomNav = document.getElementById("bottomNav");
    if (bottomNav) bottomNav.style.display = pageId === "createAdPage" ? "none" : "flex";
    updateHeaderForPageId(pageId);
  }

  function updateHeaderForPageId(pageId) {
    const map = {
      marketPage: "p2p",
      ordersPage: "orders",
      adsPage: "ads",
      chatPage: "chat",
      profilePage: "profile",
      createAdPage: "createAd",
    };
    updateHeaderForPageKey(map[pageId] || "p2p");
  }

  function updateHeaderForPageKey(pageKey) {
    state.currentPageKey = pageKey;
    const plusBtn     = document.getElementById("headerPlusBtn");
    const bal         = document.getElementById("headerBalance");          // التمويل
    const onchainBox  = document.getElementById("headerInstantOnchain");   // الفوري الحي
    const arrow       = document.getElementById("headerBalanceArrow");     // ↔ الطويل

    // ⭐ STRICT: صناديق الأرصدة + السهم تظهر في كل الصفحات عدا صفحة إعلاناتي (ads).
    //   صفحة إعلاناتي → display:none.
    //   باقي الصفحات (p2p, orders, chat, profile, createAd) → تظهر.
    const showBalances = (pageKey !== "ads");

    if (plusBtn)    plusBtn.style.display    = pageKey === "ads" ? "inline-flex" : "none";
    if (bal)        bal.style.display        = showBalances ? "inline-flex" : "none";
    if (onchainBox) onchainBox.style.display = showBalances ? "inline-flex" : "none";
    if (arrow)      arrow.style.display      = showBalances ? "inline-flex" : "none";

    if (showBalances && typeof P2P.refreshHeaderBalanceUI === "function") {
      P2P.refreshHeaderBalanceUI();
    }
  }

  function navTo(pageKey) {
    state.currentPageKey = pageKey;
    const map = { p2p: "marketPage", orders: "ordersPage", ads: "adsPage", chat: "chatPage", profile: "profilePage" };
    setPage(map[pageKey] || "marketPage");

    const items = document.querySelectorAll(".bottomNav__item");
    items.forEach((el) => el.classList.remove("bottomNav__item--active"));
    const idx = { p2p: 0, orders: 1, ads: 2, chat: 3, profile: 4 }[pageKey] ?? 0;
    if (items[idx]) items[idx].classList.add("bottomNav__item--active");

    updateHeaderForPageKey(pageKey);

    if (pageKey === "ads") subscribeMyAds();
    if (pageKey === "p2p") subscribeMarketAds();
  }

  function firestoreTypeForMarketTab(tab) {
    return tab === "sell" ? "buy" : "sell";
  }

  function userActionForMarketTab(tab) {
    return tab === "sell" ? "sell" : "buy";
  }

  function setMarketTab(tab) {
    state.marketTab = tab;
    const buyBtn = document.getElementById("tabBuy");
    const sellBtn = document.getElementById("tabSell");
    const toggle = document.getElementById("marketToggle");

    buyBtn?.classList.toggle("marketToggle__btn--active", tab === "buy");
    sellBtn?.classList.toggle("marketToggle__btn--active", tab === "sell");
    buyBtn?.setAttribute("aria-selected", tab === "buy" ? "true" : "false");
    sellBtn?.setAttribute("aria-selected", tab === "sell" ? "true" : "false");

    if (toggle) {
      toggle.classList.toggle("marketToggle--buy", tab === "buy");
      toggle.classList.toggle("marketToggle--sell", tab === "sell");
    }
    subscribeMarketAds();
  }

  function renderMarketEmpty(el) {
    el.innerHTML = `
      <div class="emptyState emptyState--compact">
        <div class="emptyState__title">لم يتم العثور على إعلانات</div>
        <div class="emptyState__sub">أنشئ إعلانًا لشراء العملات الرقمية أو بيعها.</div>
      </div>
    `;
  }

  function paymentBadgeClass(method) {
    const raw = String(method || "").toLowerCase().trim();
    const slug = raw.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    return slug ? `payBadge--${slug}` : "";
  }

  function paymentBarClass(method) {
    const raw = String(method || "").toLowerCase().trim();
    const slug = raw.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    return slug ? `payBar--${slug}` : "";
  }

  // ⭐ Merchant Stats Cache: query "Orders" collection per merchant address.
  //    Cache the Promise (not the value) so concurrent calls dedupe to one query.
  const _merchantStatsCache = new Map();
  function getMerchantStats(addr) {
    const key = String(addr || "");
    if (!key) return Promise.resolve({ totalOrders: 0, completedOrders: 0, completionPct: 100 });
    if (_merchantStatsCache.has(key)) return _merchantStatsCache.get(key);

    const p = (async () => {
      try {
        const db = getDb();
        if (!db) return { totalOrders: 0, completedOrders: 0, completionPct: 100 };
        const snap = await db.collection("Orders")
          .where("merchantAddress", "==", key)
          .get();
        let total = 0, completed = 0;
        snap.forEach((doc) => {
          total++;
          const s = String((doc.data() || {}).status || "");
          if (s === "completed") completed++;
        });
        // ⭐ قاعدة: عند أول أوردر للتاجر النسبة 100% تلقائياً.
        //    بعد كده تحسب (completed/total)*100.
        const completionPct = total <= 1 ? 100 : (completed / total) * 100;
        return { totalOrders: total, completedOrders: completed, completionPct };
      } catch (e) {
        console.warn("[ads] getMerchantStats failed for", key, e);
        return { totalOrders: 0, completedOrders: 0, completionPct: 100 };
      }
    })();
    _merchantStatsCache.set(key, p);
    return p;
  }

  function applyMerchantStatsToDom(addr, stats) {
    const safeAddr = String(addr || "").replace(/"/g, '\\"');
    document.querySelectorAll(`[data-merchant-orders="${safeAddr}"]`).forEach((el) => {
      el.textContent = String(stats.totalOrders);
    });
    document.querySelectorAll(`[data-merchant-pct="${safeAddr}"]`).forEach((el) => {
      el.textContent = (Number(stats.completionPct) || 0).toFixed(2) + "%";
    });
  }

  function subscribeMarketAds() {
    const db = getDb();
    const adsList = document.getElementById("adsList");
    if (!adsList) return;

    if (!db) {
      renderMarketEmpty(adsList);
      console.error("[ads] Firestore not initialized. Ensure firebase-config.js loads before ads.js.");
      return;
    }

    if (typeof unsubMarketAds === "function") unsubMarketAds();
    adsList.innerHTML = "";

    const wantedType = firestoreTypeForMarketTab(state.marketTab);
    const action = userActionForMarketTab(state.marketTab);

    unsubMarketAds = db
      .collection(ADS_COLLECTION)
      .where("status", "==", "active")
      .onSnapshot(
        (snap) => {
          if (snap.empty) return renderMarketEmpty(adsList);

          const docs = snap.docs
            .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
            .filter((d) => String(d.type || "") === wantedType);

          if (docs.length === 0) return renderMarketEmpty(adsList);

          adsList.innerHTML = docs
            .map((d) => {
              const price = Number(d.price) || 0;
              const available = Number(d.availableQuantity ?? d.quantity) || 0;
              const merchantAddress = String(d.merchantAddress || "");
              const paymentMethod = String(d.paymentMethod || "").trim();
              const payBar = paymentBarClass(paymentMethod);
              // ⭐ binAd__action: كلاس إضافي عشان قاعدة order:3 في style.css تتفعّل
              //    وتخلّي الزر تحت خالص (والوقت order:1 فوق، الدفع order:2 في النص).
              const btnClass = action === "buy"
                ? "binAd__btn binAd__action binAd__btn--green"
                : "binAd__btn binAd__action binAd__btn--red";
              const btnText = action === "buy" ? "شراء" : "بيع";

              // اسم التاجر + أول حرف للأفاتار (نشتق من آخر 4 من العنوان للتنوع)
              const tail = merchantAddress.slice(-4) || "----";
              const merchantName = `Merchant_${tail}`;
              const avatarLetter = (tail.match(/[A-Za-z]/)?.[0] || tail[0] || "M").toUpperCase();
              const safeAddrAttr = merchantAddress.replace(/"/g, "&quot;");

              return `
                <article class="adCard binAd">
                  <div class="binAd__row">
                    <!-- ⭐ ترتيب عمود الأكشن — حسب أمر المهندس النهائي:
                         من فوق لتحت (top-aligned، الفراغ ينزل تحت):
                           1- .binAd__time    → "15 دقيقة" (فوق خالص)
                           2- .binAd__payment → طريقة الدفع + الشريط الملوّن
                           3- .binAd__btn     → زر الشراء/البيع
                         في column flex مع justify-content: flex-start،
                         أول DOM child بيظهر فوق ⇒ time أول. -->
                    <div class="binAd__left">
                      <div class="binAd__time" aria-label="مدة الدفع">
                        <span>15 دقيقة</span>
                        <svg class="icon-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/><path d="M12 2v3"/></svg>
                      </div>
                      ${paymentMethod ? `
                        <div class="binAd__payment ${payBar}" title="${paymentMethod}">
                          <span class="binAd__paymentName">${paymentMethod}</span>
                          <span class="payment-bar"></span>
                        </div>
                      ` : `<div class="binAd__payment payBar--default"><span class="binAd__paymentName">—</span><span class="payment-bar"></span></div>`}
                      <button class="${btnClass}" type="button" onclick="openOrder('${d.id}')">${btnText}</button>
                    </div>

                    <!-- ⭐ العمود اليمين (DOM ثاني): التاجر + الإحصائيات + السعر + الحدود + المتاح -->
                    <div class="binAd__right">
                      <!-- ⭐ الآفاتار DOM أول → في RTL مع row الافتراضية يظهر على اليمين (آخر الكارت)،
                           والاسم على شماله — زي صورة باينانس بالظبط (P بجوار _pikata من اليمين) -->
                      <div class="binAd__merchant">
                        <span class="binAd__avatar" aria-hidden="true">
                          ${avatarLetter}
                          <span class="binAd__avatarDot"></span>
                        </span>
                        <span class="binAd__name">${merchantName}</span>
                      </div>

                      <div class="binAd__stats">
                        <span class="binAd__statsRate" data-merchant-pct="${safeAddrAttr}">…%</span>
                        <span class="binAd__statsSep">|</span>
                        <span class="binAd__statsOrders">
                          تداول من الطلبات:
                          <b data-merchant-orders="${safeAddrAttr}">…</b>
                        </span>
                      </div>

                      <!-- ⭐ السعر زي صورة باينانس بالظبط: USDT/ شمال (slash بعد USDT)،
                           السعر في النص، E£ على اليمين ملصوقة بالسعر. -->
                      <div class="binAd__price">
                        <span class="binAd__priceFiat">E£</span>
                        <span class="binAd__priceVal">${fmt2(price)}</span>
                        <span class="binAd__priceCurr">/USDT</span>
                      </div>

                      <div class="binAd__line">
                        <span class="binAd__lineLbl">الحدّ</span>
                        <span class="binAd__lineVal" dir="ltr">${fmt2(d.minLimit)} - ${fmt2(d.maxLimit)} EGP</span>
                      </div>

                      <div class="binAd__line">
                        <span class="binAd__lineLbl">متاح</span>
                        <span class="binAd__lineVal" dir="ltr">${fmt2(available)} USDT</span>
                      </div>
                    </div>
                  </div>
                </article>
              `;
            })
            .join("");

          // ⭐ بعد ما الكروت تترسم، نجيب إحصائيات كل تاجر فريد (مرة واحدة بفضل الـ cache)
          const uniqueAddrs = [...new Set(docs.map((d) => String(d.merchantAddress || "")).filter(Boolean))];
          uniqueAddrs.forEach((addr) => {
            getMerchantStats(addr).then((stats) => applyMerchantStatsToDom(addr, stats));
          });
        },
        (err) => {
          console.error("[ads] Market snapshot error", err);
          renderMarketEmpty(adsList);
          toast("تعذر تحميل الإعلانات");
        }
      );
  }

  function openCreateAd() { setPage("createAdPage"); }
  function showAdForm() { openCreateAd(); }
  function backToMarket() { navTo("p2p"); }

  async function setCreateMode(mode) {
    state.createMode = mode;

    document.getElementById("createModeBuy")?.classList.toggle("segmented__btn--active", mode === "buy");
    document.getElementById("createModeSell")?.classList.toggle("segmented__btn--active", mode === "sell");

    const sellOnly = document.getElementById("sellOnlyBox");
    if (sellOnly) sellOnly.style.display = mode === "sell" ? "flex" : "none";

    const maxBtn = document.getElementById("maxBtn");
    if (maxBtn) maxBtn.style.display = mode === "sell" ? "inline-flex" : "none";

    const publishBtn = document.getElementById("publishBtn");
    if (publishBtn) publishBtn.classList.toggle("primaryBtn--red", mode === "sell");

    if (mode === "sell" && typeof P2P.refreshWalletBalanceUI === "function") {
      await P2P.refreshWalletBalanceUI();
    }
    validatePublish();
  }

  // ---------- Payment type style lookup ----------
  const PM_TYPE_STYLES = {
    "Vodafone Cash":   { icon: "fa-mobile-screen",    color: "#E60026" },
    "Instapay":        { icon: "fa-building-columns",  color: "#00A850" },
    "Etisalat Cash":   { icon: "fa-sim-card",          color: "#FF6600" },
    "Banque Misr":     { icon: "fa-university",        color: "#B22222" },
    "NBE":             { icon: "fa-university",        color: "#003087" },
    "Alex Bank":       { icon: "fa-university",        color: "#0066CC" },
    "Ahlibank":        { icon: "fa-university",        color: "#006633" },
    "AL MASHREQ Bank": { icon: "fa-university",        color: "#CC0000" },
    "CIB":             { icon: "fa-university",        color: "#003366" },
    "ADIB BANK":       { icon: "fa-university",        color: "#8B0000" },
    "HSBC":            { icon: "fa-university",        color: "#DB0011" },
    "QNB":             { icon: "fa-university",        color: "#8B008B" },
  };

  // ---------- Arabic display names for payment types ----------
  const PM_ARABIC_NAMES = {
    "Vodafone Cash":   "فودافون كاش",
    "Instapay":        "إنستاباي",
    "Etisalat Cash":   "اتصالات كاش",
    "Banque Misr":     "بنك مصر",
    "NBE":             "البنك الأهلي المصري",
    "Alex Bank":       "بنك الإسكندرية",
    "Ahlibank":        "البنك الأهلي",
    "AL MASHREQ Bank": "بنك المشرق",
    "CIB":             "البنك التجاري الدولي",
    "ADIB BANK":       "بنك أبوظبي الإسلامي",
    "HSBC":            "HSBC",
    "QNB":             "بنك قطر الوطني",
  };

  function pmArabicName(type) {
    return PM_ARABIC_NAMES[type] || type;
  }

  // ⭐ Add payment footer row for dropdown
  const PM_ADD_BTN_HTML = `
    <div class="pm-dropdown-divider"></div>
    <button class="pm-dropdown-add" type="button" onclick="navTo('profile');closePaymentDropdown();">
      <i class="fa-solid fa-plus-circle"></i>
      إضافة طريقة دفع
    </button>`;

  // ⭐ Populate payment dropdown from user's Firestore payment methods
  async function populatePaymentDropdown() {
    const db = getDb();
    const addr = state.connectedAddress;
    const dd = document.getElementById("paymentDropdown");
    if (!dd) return;

    dd.innerHTML = `<div class="pm-dropdown-loading">
      <i class="fa-solid fa-spinner fa-spin"></i> جاري التحميل...
    </div>`;

    if (!addr || !db) {
      dd.innerHTML = `<div class="pm-dropdown-empty">
        <i class="fa-solid fa-wallet"></i>
        اربط محفظتك أولاً
      </div>${PM_ADD_BTN_HTML}`;
      return;
    }

    try {
      const doc = await db.collection("users").doc(addr).get();
      const methods = (doc.exists && doc.data()?.paymentMethods) || [];

      if (methods.length === 0) {
        dd.innerHTML = `<div class="pm-dropdown-empty">
          <i class="fa-solid fa-credit-card"></i>
          لا توجد وسائل دفع مضافة
        </div>${PM_ADD_BTN_HTML}`;
        return;
      }

      dd.innerHTML = methods.map((m, idx) => {
        const style = PM_TYPE_STYLES[m.type] || { icon: "fa-credit-card", color: "#848E9C" };
        const isCash = ["Vodafone Cash", "Instapay", "Etisalat Cash"].includes(m.type);
        const sub = isCash ? (m.mobile || m.number || "") : (m.iban || m.number || "");
        const subShort = sub.length > 16 ? sub.slice(0, 6) + "••••" + sub.slice(-4) : sub;
        const displayName = pmArabicName(m.type);
        return `
          <button class="pm-dropdown-item" type="button" onclick="selectPayment('${m.type.replace(/'/g,"\\'")}', ${idx})">
            <div class="pm-dropdown-icon" style="background:${style.color}20;color:${style.color}">
              <i class="fa-solid ${style.icon}"></i>
            </div>
            <div class="pm-dropdown-info">
              <div class="pm-dropdown-type">${displayName}</div>
              <div class="pm-dropdown-sub">${m.name || ""}${subShort ? " · " + subShort : ""}</div>
            </div>
            <i class="fa-solid fa-check pm-dropdown-check" id="pmCheck_${idx}" style="display:none"></i>
          </button>`;
      }).join("") + PM_ADD_BTN_HTML;
    } catch (e) {
      console.warn("[ads] populatePaymentDropdown error", e);
      dd.innerHTML = `<div class="pm-dropdown-empty">تعذر تحميل وسائل الدفع</div>${PM_ADD_BTN_HTML}`;
    }
  }

  function closePaymentDropdown() {
    const dd = document.getElementById("paymentDropdown");
    if (dd) dd.style.display = "none";
  }

  function togglePaymentDropdown() {
    const dd = document.getElementById("paymentDropdown");
    if (!dd) return;
    const isOpen = dd.style.display === "block";
    if (isOpen) {
      dd.style.display = "none";
    } else {
      dd.style.display = "block";
      populatePaymentDropdown();
    }
  }

  function selectPayment(v, idx) {
    const t = document.getElementById("selectedPaymentText");
    const style = PM_TYPE_STYLES[v] || { icon: "fa-credit-card", color: "#848E9C" };
    const displayName = pmArabicName(v);
    if (t) {
      t.innerHTML = `
        <span class="pm-selected-inner">
          <span class="pm-selected-icon" style="background:${style.color}20;color:${style.color}">
            <i class="fa-solid ${style.icon}"></i>
          </span>
          <span class="pm-selected-label">${displayName}</span>
        </span>`;
    }
    state._selectedPaymentValue = v;
    // Show check mark on selected item
    document.querySelectorAll(".pm-dropdown-check").forEach(el => el.style.display = "none");
    const chk = document.getElementById("pmCheck_" + idx);
    if (chk) chk.style.display = "inline";
    closePaymentDropdown();
    validatePublish();
  }

  function updateTotal() {
    const price = Number(document.getElementById("priceIn")?.value || 0);
    const qty = Number(document.getElementById("adAmount")?.value || 0);
    const totalEl = document.getElementById("totalAmount");
    const total = price * qty;
    if (totalEl) {
      totalEl.textContent = total > 0 ? total.toFixed(2) : "0.00";
    }
  }

  function validatePublish() {
    updateTotal();

    const price = Number(document.getElementById("priceIn")?.value || 0);
    const qty = Number(document.getElementById("adAmount")?.value || 0);
    const minL = Number(document.getElementById("minLimitIn")?.value || 0);
    const maxL = Number(document.getElementById("maxLimitIn")?.value || 0);
    // ⭐ Use stored value (not textContent which may contain HTML/icons)
    const payment = (state._selectedPaymentValue || "").trim();
    const publishBtn = document.getElementById("publishBtn");

    if (!publishBtn) return;

    const isPriceOk = price > 0;
    const isQtyOk = qty > 0;
    const isLimitsOk = minL > 0 && maxL > 0 && minL <= maxL;
    const isPaymentOk = payment !== "" && !payment.includes("اختر");

    publishBtn.disabled = !(isPriceOk && isQtyOk && isLimitsOk && isPaymentOk);
  }

  async function fillMaxFromWallet() {
    const db = getDb();
    if (state.createMode !== "sell") return;
    const addr = state.connectedAddress;
    if (!addr) return toast("اربط المحفظة أولاً");
    if (!db) return toast("تعذر الاتصال بقاعدة البيانات");

    try {
      const userSnap = await db.collection("users").doc(addr).get();
      const bal = Number(userSnap.data()?.availableBalance) || 0;
      const qtyIn = document.getElementById("adAmount");
      if (qtyIn) qtyIn.value = bal;
      if (typeof P2P.refreshWalletBalanceUI === "function") await P2P.refreshWalletBalanceUI();
      validatePublish();
    } catch (e) {
      console.error("[ads] fillMaxFromWallet error", e);
      toast("تعذر قراءة الرصيد");
    }
  }
  // Alias for HTML inline handler `window.P2P.setMaxAmount()`
  P2P.setMaxAmount = fillMaxFromWallet;

  function getCreateFormValues() {
    const price = Number(document.getElementById("priceIn")?.value || 0);
    const qty = Number(document.getElementById("adAmount")?.value || 0);
    const minLimit = Number(document.getElementById("minLimitIn")?.value || 0);
    const maxLimit = Number(document.getElementById("maxLimitIn")?.value || 0);
    // ⭐ Read from state — textContent may contain HTML icons now
    const paymentMethod = (state._selectedPaymentValue || "").trim();
    return { price, qty, minLimit, maxLimit, paymentMethod };
  }

  function resetCreateForm() {
    ["priceIn", "adAmount", "minLimitIn", "maxLimitIn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    // Reset payment selector to placeholder
    const payment = document.getElementById("selectedPaymentText");
    if (payment) payment.innerHTML = "اختر طريقة الدفع";
    state._selectedPaymentValue = null;
    const publishBtn = document.getElementById("publishBtn");
    if (publishBtn) delete publishBtn.dataset.editingId;
    updateTotal();
    validatePublish();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function publishAd() {
    clearPublishErrorState();

    const db = getDb();
    const FieldValue = getFieldValue();
    const btn = document.getElementById("publishBtn");

    if (!btn) return;
    if (!db || !FieldValue) {
      console.error("[ads] Firebase not ready", { db: !!db, FieldValue: !!FieldValue });
      return toast("تعذر الاتصال بقاعدة البيانات");
    }
    if (!state.connectedAddress) {
      return toast("اربط المحفظة أولاً");
    }

    const { price, qty, minLimit, maxLimit, paymentMethod } = getCreateFormValues();

    if (!(price > 0 && qty > 0 && minLimit > 0 && maxLimit > 0 && minLimit <= maxLimit)) {
      return toast("يرجى تعبئة السعر والكمية والحدود بشكل صحيح");
    }
    if (!paymentMethod || paymentMethod === "اختر طريقة الدفع") {
      return toast("يرجى اختيار طريقة الدفع");
    }
    if (maxLimit > price * qty) {
      return toast("الحد الأقصى لا يمكن أن يتجاوز إجمالي قيمة الإعلان");
    }

    // Payment method check (only for sell ads) — must have the SAME method as the ad
    if (state.createMode === "sell") {
      try {
        const userDoc = await db.collection("users").doc(state.connectedAddress).get();
        const savedMethods = (userDoc.exists && userDoc.data()?.paymentMethods) || [];
        const hasMatchingMethod = savedMethods.some(
          (m) => String(m.type || "").toLowerCase() === String(paymentMethod || "").toLowerCase()
        );
        if (!hasMatchingMethod) {
          toast(`⚠️ يجب إضافة وسيلة دفع "${paymentMethod}" في ملفك الشخصي أولاً`);
          setTimeout(() => {
            navTo("profile");
            try {
              const hint = document.getElementById("profilePaymentHint");
              if (hint) {
                hint.style.display = "block";
                hint.textContent = `أضف وسيلة دفع من نوع "${paymentMethod}" لتتمكن من نشر هذا الإعلان`;
              }
            } catch (_) {}
          }, 400);
          return;
        }
      } catch (pmErr) {
        console.warn("[ads] payment method match check error", pmErr);
      }
    }

    // Balance check (only for sell ads) — happens BEFORE we mutate the button
    if (state.createMode === "sell") {
      try {
        const userDoc = await db.collection("users").doc(state.connectedAddress).get();
        const realAvailable = Number(userDoc.data()?.availableBalance) || 0;
        if (realAvailable <= 0) {
          return toast("رصيدك الحالي صفر، لا يمكنك نشر إعلان بيع.");
        }
        if (qty > realAvailable) {
          return toast(`عفواً، رصيدك المتاح (${realAvailable} USDT) لا يكفي لنشر هذا الإعلان.`);
        }
      } catch (err) {
        console.error("[ads] Error checking balance:", err);
        return toast("حدث خطأ أثناء التحقق من الرصيد.");
      }
    }

    await ensureFirestoreOnline(db);

    btn.disabled = true;
    btn.classList.add("is-loading");
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>جاري الحفظ...</span>`;

    const editingId = btn.dataset.editingId || "";
    const payload = {
      type: state.createMode,
      price,
      amount: qty,
      quantity: qty,
      availableQuantity: qty,
      minLimit,
      maxLimit,
      paymentMethod,
      currency: "EGP",
      asset: "USDT",
      merchantAddress: state.connectedAddress,
      status: "active",
      active: true,
    };

    const commitOnce = async () => {
      if (editingId) {
        await db.collection(ADS_COLLECTION).doc(editingId).update({
          ...payload,
          updatedAt: FieldValue.serverTimestamp(),
        });
        const snap = await db.collection(ADS_COLLECTION).doc(editingId).get();
        if (!snap.exists) throw new Error("verify_failed_update");
        return editingId;
      }
      const docRef = await addDoc(db.collection(ADS_COLLECTION), {
        ...payload,
        timestamp: FieldValue.serverTimestamp(),
      });
      const id = docRef.id;
      const created = await db.collection(ADS_COLLECTION).doc(id).get();
      if (!created.exists) throw new Error("verify_failed_create");
      return id;
    };

    try {
      let newId;
      try {
        newId = await commitOnce();
      } catch (first) {
        if (first?.code === "permission-denied") {
          console.warn("[ads] permission-denied; retrying after 1.6s");
          await sleep(1600);
          await ensureFirestoreOnline(db);
          newId = await commitOnce();
        } else {
          throw first;
        }
      }

      if (editingId) delete btn.dataset.editingId;
      clearPublishErrorState();
      state.lastPublishDocId = newId;

      toast("تم نشر الإعلان بنجاح");
      resetCreateForm();
      navTo("ads");
      subscribeMyAds();
      subscribeMarketAds();
    } catch (e) {
      state.lastPublishError = e?.message || String(e);
      state.lastPublishErrorCode = e?.code || null;
      try {
        sessionStorage.setItem("ads_publish_error", state.lastPublishError);
        if (state.lastPublishErrorCode) {
          sessionStorage.setItem("ads_publish_error_code", state.lastPublishErrorCode);
        }
      } catch (_) {}
      console.error("[ads] publishAd failed", { code: e?.code, message: e?.message }, e);
      const code = e?.code ? ` (${e.code})` : "";
      toast(`فشل نشر الإعلان${code}.`);
    } finally {
      btn.classList.remove("is-loading");
      btn.innerHTML = originalHTML;
      validatePublish();
    }
  }

  function applyMyAdsEmptyStateCopy() {
    const empty = document.getElementById("myAdsEmpty");
    if (!empty) return;
    empty.querySelector(".emptyState__title")?.replaceChildren(document.createTextNode("لم يتم العثور على إعلانات"));
    empty.querySelector(".emptyState__sub")?.replaceChildren(document.createTextNode("أنشئ إعلانًا لشراء العملات الرقمية أو بيعها."));
    const btn = empty.querySelector("button");
    if (btn) {
      btn.textContent = "إنشاء إعلان";
      btn.onclick = showAdForm;
    }
  }

  function renderMyAdsEmpty(isVisible) {
    const empty = document.getElementById("myAdsEmpty");
    if (empty) empty.style.display = isVisible ? "block" : "none";
  }

  function renderMyAdsList(ads) {
    const list = document.getElementById("myAdsList");
    if (!list) return;

    list.innerHTML = ads
      .map((a, idx) => {
        const price = Number(a.price) || 0;
        const amount = Number(a.quantity) || 0;
        return `
          <article class="myAdCard">
            <div class="myAdCard__top">
              <div class="myAdCard__title">إعلان</div>
              <span class="badge">نشط (${idx + 1})</span>
            </div>
            <div class="myAdStats">
              <div class="myAdStat">
                <div class="myAdStat__label">السعر</div>
                <div class="myAdStat__value">${fmt2(price)} <span class="unit">EGP</span></div>
              </div>
              <div class="myAdStat">
                <div class="myAdStat__label">العملة</div>
                <div class="myAdStat__value">USDT</div>
              </div>
              <div class="myAdStat">
                <div class="myAdStat__label">الكمية</div>
                <div class="myAdStat__value">${fmt2(amount)} <span class="unit">USDT</span></div>
              </div>
            </div>
            <div class="myAdActions">
              <button class="btn btn--edit" type="button" onclick="editMyAd('${a.id}')">تعديل الإعلان</button>
              <button class="btn btn--danger" type="button" onclick="cancelMyAd('${a.id}')">إلغاء الإعلان</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function subscribeMyAds() {
    const db = getDb();
    const addr = state.connectedAddress;

    applyMyAdsEmptyStateCopy();

    const activeCount = document.getElementById("myAdsActiveCount");
    const list = document.getElementById("myAdsList");
    if (!list) return;

    if (!addr) {
      list.innerHTML = "";
      if (activeCount) activeCount.textContent = "0";
      renderMyAdsEmpty(true);
      return;
    }

    if (!db) {
      console.error("[ads] Firestore not initialized for My Ads.");
      list.innerHTML = "";
      if (activeCount) activeCount.textContent = "0";
      renderMyAdsEmpty(true);
      return;
    }

    if (typeof unsubMyAds === "function") unsubMyAds();

    unsubMyAds = db
      .collection(ADS_COLLECTION)
      .where("merchantAddress", "==", addr)
      .onSnapshot(
        (snap) => {
          const ads = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
          const activeAds = ads.filter((a) => a.status === "active");
          if (activeCount) activeCount.textContent = String(activeAds.length);

          if (activeAds.length === 0) {
            list.innerHTML = "";
            renderMyAdsEmpty(true);
            return;
          }
          renderMyAdsEmpty(false);
          renderMyAdsList(activeAds);
        },
        (err) => {
          console.error("[ads] My Ads snapshot error", err);
          list.innerHTML = "";
          if (activeCount) activeCount.textContent = "0";
          renderMyAdsEmpty(true);
          toast("تعذر تحميل الإعلانات");
        }
      );
  }

  async function editMyAd(adId) {
    const db = getDb();
    if (!db) return toast("تعذر الاتصال بقاعدة البيانات");

    try {
      const doc = await db.collection(ADS_COLLECTION).doc(adId).get();
      if (!doc.exists) return toast("الإعلان غير موجود");
      const a = doc.data() || {};

      const priceIn = document.getElementById("priceIn");
      const qtyIn = document.getElementById("adAmount");
      const minIn = document.getElementById("minLimitIn");
      const maxIn = document.getElementById("maxLimitIn");
      const pay = document.getElementById("selectedPaymentText");

      if (priceIn) priceIn.value = a.price ?? "";
      if (qtyIn) qtyIn.value = a.quantity ?? "";
      if (minIn) minIn.value = a.minLimit ?? "";
      if (maxIn) maxIn.value = a.maxLimit ?? "";
      // ⭐ Use selectPayment to show icon + set state value
      if (a.paymentMethod) selectPayment(a.paymentMethod);
      else if (pay) pay.innerHTML = "اختر طريقة الدفع";

      await setCreateMode(a.type === "sell" ? "sell" : "buy");

      const publishBtn = document.getElementById("publishBtn");
      if (publishBtn) publishBtn.dataset.editingId = adId;

      showAdForm();
      validatePublish();
    } catch (e) {
      console.error("[ads] editMyAd error", e);
      toast("حدث خطأ أثناء تحميل الإعلان");
    }
  }


    // ── Custom confirm modal — يحل محل confirm() المدمج ──
    function _showConfirmModal(msg) {
      return new Promise(function(resolve) {
        var old = document.getElementById('_adsConfirmModal');
        if (old) old.remove();
        var ov = document.createElement('div');
        ov.id = '_adsConfirmModal';
        ov.innerHTML =
          '<div class="cm__card">' +
            '<div class="cm__icon"><i class="fa-solid fa-triangle-exclamation"></i></div>' +
            '<div class="cm__title">\u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0625\u0644\u063a\u0627\u0621</div>' +
            '<div class="cm__msg">' + msg + '</div>' +
            '<div class="cm__actions">' +
              '<button class="cm__cancel" type="button">\u0625\u0644\u063a\u0627\u0621</button>' +
              '<button class="cm__confirm" type="button">\u0646\u0639\u0645\u060c \u0625\u0644\u063a\u0627\u0621 \u0627\u0644\u0625\u0639\u0644\u0627\u0646</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(ov);
        function done(v) { ov.remove(); resolve(v); }
        ov.querySelector('.cm__cancel').addEventListener('click', function() { done(false); });
        ov.querySelector('.cm__confirm').addEventListener('click', function() { done(true); });
        ov.addEventListener('click', function(e) { if (e.target === ov) done(false); });
      });
    }

  
  async function cancelMyAd(adId) {
    const db = getDb();
    if (!db) return toast("تعذر الاتصال بقاعدة البيانات");

    const ok = await _showConfirmModal("هل أنت متأكد من إلغاء هذا الإعلان؟\nلا يمكن التراجع عن هذا الإجراء.");
    if (!ok) return;

    try {
      await db.collection(ADS_COLLECTION).doc(adId).delete();
      toast("تم إلغاء الإعلان");
    } catch (e) {
      console.error("[ads] cancelMyAd error", e);
      toast("حدث خطأ أثناء إلغاء الإعلان");
    }
  }

  function bindCreateInputs() {
    ["priceIn", "adAmount", "minLimitIn", "maxLimitIn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", validatePublish);
    });
  }

  function sanityCheckFirebase() {
    const db = getDb();
    const FieldValue = getFieldValue();
    if (!db || !FieldValue) {
      console.error("[ads] Firebase sanity check failed.", { hasDb: !!db, hasFieldValue: !!FieldValue });
    }
  }

  // Expose globals for inline HTML handlers.
  window.navTo = navTo;
  window.setMarketTab = setMarketTab;
  window.openCreateAd = openCreateAd;
  window.showAdForm = showAdForm;
  window.showCreateAdForm = showAdForm;
  window.backToMarket = backToMarket;
  window.setCreateMode = setCreateMode;
  window.fillMaxFromWallet = fillMaxFromWallet;
  window.togglePaymentDropdown = togglePaymentDropdown;
  window.selectPayment = selectPayment;
  window.closePaymentDropdown = closePaymentDropdown;
  window.publishAd = publishAd;
  window.editMyAd = editMyAd;
  window.cancelMyAd = cancelMyAd;

  document.addEventListener("DOMContentLoaded", async () => {
    sanityCheckFirebase();
    bindCreateInputs();
    applyMyAdsEmptyStateCopy();

    // Close payment dropdown when clicking outside
    document.addEventListener("click", (e) => {
      const dd = document.getElementById("paymentDropdown");
      const selector = e.target.closest(".select");
      if (!dd || dd.style.display !== "block") return;
      if (!selector && !e.target.closest(".pm-dropdown")) {
        dd.style.display = "none";
      }
    });

    await setCreateMode("buy");
    setMarketTab("buy");
    navTo("p2p");
    subscribeMarketAds();
  });

  document.addEventListener("p2p:walletConnected", () => {
    subscribeMyAds();
    if (typeof P2P.refreshWalletBalanceUI === "function") P2P.refreshWalletBalanceUI();
    validatePublish();
  });
})();
