/* eslint-disable no-console */

// ------------------------------------------------------------
// profile.js — Profile Page + Payment Methods Management
// ------------------------------------------------------------
(function () {
  window.P2P = window.P2P || {};
  window.P2P.profile = window.P2P.profile || {};
  window.P2P.state = window.P2P.state || {};

  const getDb = () => window.db;

  // ---------- Payment method types catalog ----------
  const PAYMENT_TYPES = [
    { id: "Vodafone Cash",   label: "Vodafone Cash",              icon: "fa-mobile-screen",      color: "#E60026", kind: "cash" },
    { id: "Instapay",        label: "Instapay",                   icon: "fa-building-columns",   color: "#00A850", kind: "cash" },
    { id: "Etisalat Cash",   label: "Etisalat Cash",              icon: "fa-sim-card",           color: "#FF6600", kind: "cash" },
    { id: "Banque Misr",     label: "Banque Misr",                icon: "fa-university",         color: "#B22222", kind: "bank" },
    { id: "NBE",             label: "National Bank (NBE)",        icon: "fa-university",         color: "#003087", kind: "bank" },
    { id: "Alex Bank",       label: "Alex Bank",                  icon: "fa-university",         color: "#0066CC", kind: "bank" },
    { id: "Ahlibank",        label: "Ahlibank",                   icon: "fa-university",         color: "#006633", kind: "bank" },
    { id: "AL MASHREQ Bank", label: "AL MASHREQ Bank",            icon: "fa-university",         color: "#CC0000", kind: "bank" },
    { id: "CIB",             label: "CIB",                        icon: "fa-university",         color: "#003366", kind: "bank" },
    { id: "ADIB BANK",       label: "ADIB BANK",                  icon: "fa-university",         color: "#8B0000", kind: "bank" },
    { id: "HSBC",            label: "HSBC",                       icon: "fa-university",         color: "#DB0011", kind: "bank" },
    { id: "QNB",             label: "QNB",                        icon: "fa-university",         color: "#8B008B", kind: "bank" },
  ];

  function isCashType(typeId) {
    const t = PAYMENT_TYPES.find((x) => x.id === typeId);
    return t ? t.kind === "cash" : false;
  }

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const toast = (msg) => { if (typeof window.P2P.toast === "function") window.P2P.toast(msg); };

  function shortAddr(addr) {
    if (!addr) return "—";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  // ---------- Profile page render ----------
  function renderProfilePage(addr) {
    const addrEl = $("profileAddress");
    const avatarEl = $("profileAvatarImg");
    const profileFundingEl = $("profileFundingBalance");

    if (addrEl) addrEl.textContent = addr ? shortAddr(addr) : "—";
    if (avatarEl && addr) avatarEl.style.opacity = "1";

    const bal = window.P2P.state.availableBalance || 0;
    if (profileFundingEl) profileFundingEl.textContent = Number(bal).toFixed(2) + " USDT";

    if (addr) loadProfileStats(addr);
  }

  async function loadProfileStats(addr) {
    const db = getDb();
    if (!db || !addr) return;
    try {
      const snap = await db.collection("Orders")
        .where("merchantAddress", "==", addr)
        .get();
      let total = 0, completed = 0;
      snap.forEach((doc) => {
        total++;
        if ((doc.data().status || "") === "completed") completed++;
      });
      const rate = total === 0 ? 100 : Math.round((completed / total) * 100);
      const ordersEl = $("profileStatsOrders");
      const rateEl = $("profileStatsRate");
      if (ordersEl) ordersEl.textContent = total;
      if (rateEl) rateEl.textContent = rate + "%";
    } catch (e) {
      console.warn("[profile] loadProfileStats", e);
    }
  }

  document.addEventListener("p2p:walletConnected", (e) => {
    const addr = e?.detail?.address || window.P2P.state?.connectedAddress;
    renderProfilePage(addr);
    const balEl = $("profileFundingBalance");
    if (balEl) balEl.textContent = Number(window.P2P.state.availableBalance || 0).toFixed(2) + " USDT";
  });

  const _origRefreshHeader = window.P2P.refreshHeaderBalanceUI;
  window.P2P.refreshHeaderBalanceUI = function () {
    if (typeof _origRefreshHeader === "function") _origRefreshHeader();
    const balEl = $("profileFundingBalance");
    if (balEl) balEl.textContent = Number(window.P2P.state.availableBalance || 0).toFixed(2) + " USDT";
  };

  // ---------- Payment Methods Page ----------
  window.openPaymentMethodsPage = function () {
    const pages = ["marketPage", "createAdPage", "ordersPage", "adsPage", "chatPage", "profilePage", "paymentMethodsPage"];
    pages.forEach((id) => {
      const el = $(id);
      if (el) el.classList.toggle("page--active", id === "paymentMethodsPage");
    });
    const bottomNav = $("bottomNav");
    if (bottomNav) bottomNav.style.display = "none";
    loadPaymentMethods();
  };

  window.closePaymentMethodsPage = function () {
    const pages = ["marketPage", "createAdPage", "ordersPage", "adsPage", "chatPage", "profilePage", "paymentMethodsPage"];
    pages.forEach((id) => {
      const el = $(id);
      if (el) el.classList.toggle("page--active", id === "profilePage");
    });
    const bottomNav = $("bottomNav");
    if (bottomNav) bottomNav.style.display = "flex";
  };

  async function loadPaymentMethods() {
    const db = getDb();
    const addr = window.P2P.state.connectedAddress;
    const listEl = $("pmList");
    if (!listEl) return;

    if (!addr || !db) {
      listEl.innerHTML = renderPmEmpty();
      return;
    }

    try {
      const doc = await db.collection("users").doc(addr).get();
      const methods = (doc.exists && doc.data()?.paymentMethods) || [];
      window.P2P.state._paymentMethods = methods;

      if (methods.length === 0) {
        listEl.innerHTML = renderPmEmpty();
      } else {
        listEl.innerHTML = methods.map((m, idx) => renderPmCard(m, idx)).join("");
      }
    } catch (e) {
      console.warn("[profile] loadPaymentMethods", e);
      listEl.innerHTML = renderPmEmpty();
    }
  }

  function renderPmEmpty() {
    return `
      <div class="pmEmpty">
        <div class="pmEmpty__icon">
          <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="10" y="22" width="60" height="44" rx="10" stroke="#D2D6DB" stroke-width="3"/>
            <path d="M10 36h60" stroke="#D2D6DB" stroke-width="3"/>
            <rect x="20" y="48" width="20" height="6" rx="3" fill="#D2D6DB"/>
            <rect x="48" y="48" width="12" height="6" rx="3" fill="#EAECEF"/>
          </svg>
        </div>
        <div class="pmEmpty__text">لا يوجد شيء هنا...</div>
      </div>`;
  }

  function renderPmCard(m, idx) {
    const typeInfo = PAYMENT_TYPES.find((t) => t.id === m.type) || { label: m.type, icon: "fa-credit-card", color: "#848E9C" };
    const isCash = isCashType(m.type);
    const secondLine = isCash
      ? (m.mobile || m.number || "—")
      : (m.iban || m.number || "—");
    const thirdLine = !isCash && m.bankName ? `<div class="pmCard__bank">${m.bankName}</div>` : "";
    return `
      <div class="pmCard">
        <div class="pmCard__left">
          <div class="pmCard__iconWrap" style="background: ${typeInfo.color}18; color: ${typeInfo.color}">
            <i class="fa-solid ${typeInfo.icon}"></i>
          </div>
          <div class="pmCard__info">
            <div class="pmCard__type">${typeInfo.label}</div>
            <div class="pmCard__name">${m.name || "—"}</div>
            ${thirdLine}
            <div class="pmCard__number">${secondLine}</div>
          </div>
        </div>
        <button class="pmCard__del" type="button" onclick="deletePaymentMethod(${idx})" aria-label="حذف">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>`;
  }

  window.deletePaymentMethod = async function (idx) {
    const db = getDb();
    const addr = window.P2P.state.connectedAddress;
    if (!db || !addr) return;
    const methods = [...(window.P2P.state._paymentMethods || [])];
    methods.splice(idx, 1);
    try {
      await db.collection("users").doc(addr).set({ paymentMethods: methods }, { merge: true });
      window.P2P.state._paymentMethods = methods;
      toast("تم حذف طريقة الدفع");
      loadPaymentMethods();
    } catch (e) {
      toast("فشل الحذف");
    }
  };

  // ---------- Add Payment Method — Centered Modal ----------
    (function _injectPaymentModalCSS() {
      if (document.getElementById("_pmModalCss")) return;
      const s = document.createElement("style");
      s.id = "_pmModalCss";
      s.textContent = `
        #addPaymentOverlay._pmActive {
          display: flex !important; position: fixed !important; inset: 0 !important;
          background: rgba(0,0,0,0.60) !important; z-index: 10000 !important;
          align-items: center !important; justify-content: center !important;
          padding: 16px !important; backdrop-filter: blur(2px);
        }
        #addPaymentSheet._pmActive {
          position: fixed !important; bottom: auto !important;
          top: 50% !important; left: 50% !important; right: auto !important;
          transform: translate(-50%, -50%) !important;
          width: calc(100% - 32px) !important; max-width: 420px !important;
          max-height: 88vh !important; border-radius: 22px !important;
          z-index: 10001 !important; box-shadow: 0 28px 70px rgba(0,0,0,0.30) !important;
          overflow-y: auto !important;
          animation: _pmSlideIn 0.28s cubic-bezier(0.34,1.20,0.64,1) both;
        }
        @keyframes _pmSlideIn {
          from { opacity:0; transform: translate(-50%, -46%) scale(0.96); }
          to   { opacity:1; transform: translate(-50%, -50%) scale(1); }
        }
        #addPaymentSheet._pmActive .bottomSheet__handle { display: none; }
        #addPaymentSheet._pmActive > .bottomSheet__title { display: none; }
        #_pmModalHeader {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 16px; padding-bottom: 14px;
          border-bottom: 1px solid var(--line, rgba(0,0,0,.08));
        }
        #_pmModalHeader .bottomSheet__title { font-size: 18px; font-weight: 800; margin-bottom: 0; text-align: right; }
        #_pmCloseBtn {
          background: var(--chip,#f3f4f6); border: none; border-radius: 50%;
          width: 34px; height: 34px; display: flex; align-items: center;
          justify-content: center; cursor: pointer;
          color: var(--muted,#6b7280); font-size: 14px; flex-shrink: 0;
        }
      `;
      document.head.appendChild(s);
    })();

    function _wrapSheetHeader() {
      const sheet = $("addPaymentSheet");
      if (!sheet || sheet.querySelector("#_pmModalHeader")) return;
      const header = document.createElement("div");
      header.id = "_pmModalHeader";
      const titleEl = document.createElement("div");
      titleEl.className = "bottomSheet__title";
      titleEl.textContent = "إضافة طريقة دفع";
      header.appendChild(titleEl);
      const closeBtn = document.createElement("button");
      closeBtn.id = "_pmCloseBtn"; closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "إغلاق");
      closeBtn.textContent = "✕";
      closeBtn.addEventListener("click", () => window.closeAddPaymentSheet());
      header.appendChild(closeBtn);
      sheet.insertBefore(header, sheet.firstChild);
    }

    window.openAddPaymentSheet = function () {
      const sheet = $("addPaymentSheet");
      const overlay = $("addPaymentOverlay");
      _wrapSheetHeader();
      if (overlay) overlay.classList.add("_pmActive");
      if (sheet)   sheet.classList.add("_pmActive");
      resetPmForm();
      renderPaymentTypeSelector();
    };

    window.closeAddPaymentSheet = function () {
      const sheet = $("addPaymentSheet");
      const overlay = $("addPaymentOverlay");
      if (sheet)   sheet.classList.remove("_pmActive");
      if (overlay) overlay.classList.remove("_pmActive");
      resetPmForm();
    };

  function resetPmForm() {
    ["pmNameIn", "pmMobileIn", "pmIbanIn", "pmBankNameIn"].forEach((id) => {
      const el = $(id);
      if (el) el.value = "";
    });
    // Legacy field
    const numberIn = $("pmNumberIn");
    if (numberIn) numberIn.value = "";
    window.P2P.state._selectedPmType = null;
    hidePmDetails();
    renderPaymentTypeSelector();
  }

  function hidePmDetails() {
    const detailsSection = $("pmDetailsSection");
    if (detailsSection) detailsSection.style.display = "none";
    const cashFields = $("pmCashFields");
    const bankFields = $("pmBankFields");
    if (cashFields) cashFields.style.display = "none";
    if (bankFields) bankFields.style.display = "none";
  }

  function renderPaymentTypeSelector() {
    const container = $("pmTypeList");
    if (!container) return;
    const selected = window.P2P.state._selectedPmType;
    container.innerHTML = PAYMENT_TYPES.map((t) => `
      <button class="pmTypeItem ${selected === t.id ? "pmTypeItem--active" : ""}" type="button"
              onclick="selectPmType('${t.id}')">
        <div class="pmTypeItem__iconWrap" style="background: ${t.color}18; color: ${t.color}">
          <i class="fa-solid ${t.icon}"></i>
        </div>
        <span class="pmTypeItem__label">${t.label}</span>
        ${t.kind === "cash"
          ? '<span style="font-size:10px;background:#E8F5E9;color:#2E7D32;padding:2px 7px;border-radius:8px;font-weight:700;margin-right:auto;">كاش</span>'
          : '<span style="font-size:10px;background:#E3F2FD;color:#1565C0;padding:2px 7px;border-radius:8px;font-weight:700;margin-right:auto;">بنك</span>'
        }
        <i class="fa-solid fa-chevron-left pmTypeItem__arrow"></i>
      </button>`
    ).join("");
  }

  window.selectPmType = function (typeId) {
    window.P2P.state._selectedPmType = typeId;
    renderPaymentTypeSelector();

    const detailsSection = $("pmDetailsSection");
    const cashFields = $("pmCashFields");
    const bankFields = $("pmBankFields");
    const titleEl = $("pmDetailsTitle");

    if (!detailsSection) return;
    detailsSection.style.display = "block";

    const typeInfo = PAYMENT_TYPES.find((t) => t.id === typeId);
    if (titleEl) titleEl.textContent = `تفاصيل ${typeInfo?.label || typeId}`;

    const cash = isCashType(typeId);
    if (cashFields) cashFields.style.display = cash ? "block" : "none";
    if (bankFields) bankFields.style.display = cash ? "none" : "block";

    // Clear fields on switch
    ["pmNameIn", "pmMobileIn", "pmIbanIn", "pmBankNameIn"].forEach((id) => {
      const el = $(id);
      if (el) el.value = "";
    });

    // Ensure number-only enforcement on mobile/iban inputs
    _enforceMobileInput();
    _enforceIbanInput();
  };

  // Block letters from mobile input (allow digits, +, spaces only)
  function _enforceMobileInput() {
    const el = $("pmMobileIn");
    if (!el || el._enforced) return;
    el._enforced = true;
    el.addEventListener("input", () => {
      const cleaned = el.value.replace(/[^0-9+ ]/g, "");
      if (el.value !== cleaned) el.value = cleaned;
    });
    el.addEventListener("keypress", (e) => {
      if (!/[0-9+\s]/.test(e.key)) e.preventDefault();
    });
  }

  // Block letters from IBAN/account input
  function _enforceIbanInput() {
    const el = $("pmIbanIn");
    if (!el || el._enforced) return;
    el._enforced = true;
    el.addEventListener("input", () => {
      const cleaned = el.value.replace(/[^0-9A-Za-z ]/g, "");
      if (el.value !== cleaned) el.value = cleaned;
    });
    el.addEventListener("keypress", (e) => {
      if (!/[0-9A-Za-z\s]/.test(e.key)) e.preventDefault();
    });
  }

  window.savePaymentMethod = async function () {
    const db = getDb();
    const addr = window.P2P.state.connectedAddress;
    const type = window.P2P.state._selectedPmType;

    if (!addr) return toast("اربط محفظتك أولاً");
    if (!type) return toast("اختر نوع وسيلة الدفع");

    const name = ($("pmNameIn")?.value || "").trim();
    if (!name) return toast("أدخل الاسم الكامل");

    let methodEntry = { type, name, createdAt: Date.now() };

    if (isCashType(type)) {
      // Cash / Mobile Wallet
      const mobile = ($("pmMobileIn")?.value || "").trim();
      if (!mobile) return toast("أدخل رقم الموبايل");
      if (/[a-zA-Z\u0600-\u06FF]/.test(mobile)) return toast("رقم الموبايل يجب أن يحتوي على أرقام فقط");
      methodEntry.mobile = mobile;
      methodEntry.number = mobile; // backward compat
    } else {
      // Bank Transfer
      const bankName = ($("pmBankNameIn")?.value || "").trim();
      const iban = ($("pmIbanIn")?.value || "").trim();
      if (!bankName) return toast("أدخل اسم البنك");
      if (!iban) return toast("أدخل رقم الحساب أو IBAN");
      if (/[\u0600-\u06FF]/.test(iban)) return toast("رقم الحساب يجب أن يحتوي على أرقام وحروف إنجليزية فقط");
      methodEntry.bankName = bankName;
      methodEntry.iban = iban;
      methodEntry.number = iban; // backward compat
    }

    const methods = [...(window.P2P.state._paymentMethods || [])];
    methods.push(methodEntry);

    try {
      await db.collection("users").doc(addr).set({ paymentMethods: methods }, { merge: true });
      window.P2P.state._paymentMethods = methods;
      toast("تم إضافة طريقة الدفع بنجاح");
      closeAddPaymentSheet();
      loadPaymentMethods();
    } catch (e) {
      console.error("[profile] savePaymentMethod", e);
      toast("فشل الحفظ، حاول مجدداً");
    }
  };

  // ---------- Support Sheet ----------
  window.openSupportSheet = function () {
    const sheet = $("supportSheet");
    const overlay = $("supportOverlay");
    if (sheet) sheet.classList.add("show");
    if (overlay) overlay.style.display = "block";
  };

  window.closeSupportSheet = function () {
    const sheet = $("supportSheet");
    const overlay = $("supportOverlay");
    if (sheet) sheet.classList.remove("show");
    if (overlay) overlay.style.display = "none";
  };

  window.contactWhatsApp = function () {
    window.open("https://wa.me/201000000000?text=مرحباً، أحتاج مساعدة في منصة P2P", "_blank");
  };

  window.contactTelegram = function () {
    window.open("https://t.me/p2psupport3", "_blank");
  };

  // ---------- Expose payment methods getter for ads.js validation ----------
  window.P2P.hasPaymentMethod = async function () {
    const db = getDb();
    const addr = window.P2P.state.connectedAddress;
    if (!addr || !db) return false;
    try {
      const doc = await db.collection("users").doc(addr).get();
      const methods = (doc.exists && doc.data()?.paymentMethods) || [];
      return methods.length > 0;
    } catch {
      return false;
    }
  };

  // ---------- Get seller payment info for order-details ----------
  window.P2P.getSellerPaymentInfo = async function (sellerAddr, preferredMethod) {
    const db = getDb();
    if (!sellerAddr || !db) return null;
    try {
      const doc = await db.collection("users").doc(sellerAddr).get();
      if (!doc.exists) return null;
      const data = doc.data() || {};
      const methods = data.paymentMethods || [];
      const name = data.displayName || data.name || ("Trader_" + String(sellerAddr).slice(-4));

      // Try to find matching payment method for the ad's payment type
      let matched = null;
      if (preferredMethod) {
        matched = methods.find(
          (m) => String(m.type || "").toLowerCase() === String(preferredMethod).toLowerCase()
        );
      }
      const primary = matched || methods[0] || null;

      return {
        name,
        paymentMethods: methods,
        primaryMethod: primary,
      };
    } catch (e) {
      console.warn("[profile] getSellerPaymentInfo error", e);
      return null;
    }
  };

  // ---------- Init ----------
  window.addEventListener("DOMContentLoaded", () => {
    const savedAddr = (() => { try { return localStorage.getItem("p2p_address"); } catch { return null; } })();
    if (savedAddr) renderProfilePage(savedAddr);
    // Enforce number inputs on mobile/iban on load
    _enforceMobileInput();
    _enforceIbanInput();
  });

  window.P2P.profile.render = renderProfilePage;

})();
