/* eslint-disable no-console */

// ------------------------------------------------------------
// orders.js (CLEAN REWRITE — Pro Card Design)
// + Order Counter Badge on bottom-nav "orders" icon (real-time)
// ------------------------------------------------------------

(function () {
  window.P2P = window.P2P || {};
  window.P2P.orders = window.P2P.orders || {};
  window.P2P.state = window.P2P.state || {};

  const getDb = () => window.db; // ✅ defensive: don't cache
  const ORDER_WINDOW_MS = 15 * 60 * 1000;
  const ADS_COLLECTION = "ads";
  const ORDERS_COLLECTION = "Orders";

  window.P2P.state.ordersTab = window.P2P.state.ordersTab || "active";

  let selectedAd = null;
  let selectedAction = null;
  let unsubOrders = null;
  let unsubOrdersBadge = null; // ✅ separate listener للـ badge عشان يفضل شغال حتى لو المستخدم بدّل tab
  let orderTimerInterval = null;
  let orderExpiresAt = 0;
  let cardsTickerInterval = null;
  const userNamesCache = {};

  // ⭐ EXPIRY: Guard set عشان ما نبعتش update مرتين لنفس الطلب
  const _autoCancelInFlight = new Set();

  // ---------- Inject Pro Card CSS (one-time) ----------
  (function injectOrdersStyles() {
    if (document.getElementById("p2p-orders-card-styles")) return;
    const s = document.createElement("style");
    s.id = "p2p-orders-card-styles";
    s.textContent = `
      .orderCard {
        background: #ffffff;
        border-radius: 18px;
        padding: 14px 16px;
        margin-bottom: 14px;
        border: 1px solid #EAECEF;
        box-shadow: 0 4px 14px rgba(0,0,0,0.04);
        font-family: 'Segoe UI', Tahoma, sans-serif;
      }
      .orderCard__head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 4px; }
      .orderCard__type { font-size: 16px; font-weight: 800; letter-spacing: -0.3px; }
      .orderCard__type.is-buy  { color: #02C076; }
      .orderCard__type.is-sell { color: #FF4D4F; }

      .orderCard__status {
        display: inline-flex; align-items: center; gap: 6px;
        background: rgba(0, 255, 200, 0.12);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(0, 255, 200, 0.32);
        color: #00766b;
        font-size: 12px; font-weight: 700;
        padding: 6px 12px; border-radius: 999px;
        cursor: pointer;
        transition: transform .15s ease;
      }
      .orderCard__status:hover { transform: translateY(-1px); }
      .orderCard__status.is-processing { background: rgba(240,185,11,0.14); border-color: rgba(240,185,11,0.4); color:#8a6a00; }
      .orderCard__status.is-completed  { background: rgba(2,192,118,0.14); border-color: rgba(2,192,118,0.4); color:#02704a; }
      .orderCard__status.is-canceled   { background: rgba(255,77,79,0.12); border-color: rgba(255,77,79,0.4); color:#a02427; }
      .statusDot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px rgba(0,255,200,0.18); }

      .orderCard__timer {
        display: flex; justify-content: flex-end; align-items: center; gap: 6px;
        font-size: 12px; font-weight: 700; color: #f0b90b;
        margin-bottom: 12px;
      }
      .orderCard__timer i { font-size: 12px; }

      .orderCard__body { padding: 10px 0; border-top: 1px dashed #F0F1F3; border-bottom: 1px dashed #F0F1F3; }
      .orderRow { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; }
      .orderLabel { color: #848E9C; font-size: 13px; font-weight: 500; }
      .orderVal   { color: #1E2329; font-size: 14px; font-weight: 700; display: inline-flex; align-items: center; gap: 8px; }
      .orderIdText { font-family: 'SFMono-Regular', Menlo, monospace; color: #5E6673; font-size: 13px; }
      .orderCopyBtn {
        background: transparent; border: none; cursor: pointer;
        color: #848E9C; padding: 4px 6px; border-radius: 6px;
        transition: background .15s ease, color .15s ease;
      }
      .orderCopyBtn:hover { background: #F5F5F7; color: #1E2329; }

      .orderCard__footer { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-top: 12px; }
      .orderChatBtn {
        display: inline-flex; align-items: center; gap: 8px;
        background: rgba(0, 255, 200, 0.15);
        backdrop-filter: blur(15px);
        border: 2px solid rgba(0, 255, 200, 0.32);
        color: #1E2329;
        font-size: 13px; font-weight: 700;
        padding: 7px 14px; border-radius: 12px;
        cursor: pointer;
        transition: transform .15s ease;
      }
      .orderChatBtn:hover { transform: translateY(-1px); }
      .orderChatBtn .chatName { max-width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .orderDate { color: #9AA0A6; font-size: 11px; font-weight: 500; direction: ltr; }

      .ordersEmpty { padding: 30px; text-align: center; color: #848E9C; font-size: 14px; }
    `;
    document.head.appendChild(s);
  })();

  // ---------- Helpers ----------
  function fmt2(n) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(2) : "0.00"; }
  function fmtTime(ms) {
    if (ms <= 0) return "00:00";
    const t = Math.floor(ms / 1000);
    const m = Math.floor(t / 60), s = t % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function fmtDateTime(ts) {
    if (!ts) return "";
    let d;
    if (typeof ts.toDate === "function") d = ts.toDate();
    else if (typeof ts === "number") d = new Date(ts);
    else if (ts.seconds) d = new Date(ts.seconds * 1000);
    else return "";
    const pad = (n) => (n < 10 ? "0" + n : n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function shortId(id) { return id ? id.slice(0, 8) + "…" : "—"; }
  function escapeAttr(s) { return String(s || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

  function statusLabel(o) {
    if (o.status === "completed")               return { text: "مكتمل",            cls: "is-completed"  };
    if (o.status === "canceled")                return { text: "ملغي",             cls: "is-canceled"   };
    if (o.status === "pending_admin_release")   return { text: "قيد المعالجة",      cls: "is-processing" };
    if (o.status === "active") {
      if (!o.paymentConfirmed) return { text: "في انتظار الدفع",     cls: "" };
      return                          { text: "في انتظار التأكيد",   cls: "" };
    }
    return { text: o.status || "—", cls: "" };
  }

  function actionForRole(o, myAddr) {
    const me = String(myAddr || "").toLowerCase();
    if (String(o.buyerAddress || "").toLowerCase()  === me) return { label: "شراء USDT", cls: "is-buy"  };
    if (String(o.sellerAddress || "").toLowerCase() === me) return { label: "بيع USDT",  cls: "is-sell" };
    return { label: (String(o.userAction).toLowerCase() === "buy" ? "شراء USDT" : "بيع USDT"), cls: (String(o.userAction).toLowerCase() === "buy" ? "is-buy" : "is-sell") };
  }
  function counterpartyAddr(o, myAddr) {
    const me = String(myAddr || "").toLowerCase();
    if (String(o.buyerAddress  || "").toLowerCase() === me) return o.sellerAddress;
    if (String(o.sellerAddress || "").toLowerCase() === me) return o.buyerAddress;
    return o.merchantAddress;
  }

  async function getDisplayName(addr) {
    const db = getDb();
    if (!addr) return "Trader";
    if (userNamesCache[addr]) return userNamesCache[addr];
    if (!db) return "Trader_" + addr.slice(-4);
    try {
      const doc = await db.collection("users").doc(addr).get();
      const data = (doc.exists && doc.data()) || {};
      const name = data.displayName || data.name || data.username || ("Trader_" + addr.slice(-4));
      userNamesCache[addr] = name;
      return name;
    } catch {
      const fallback = "Trader_" + addr.slice(-4);
      userNamesCache[addr] = fallback;
      return fallback;
    }
  }

  // ---------- Copy Order ID ----------
  window.copyOrderId = function (e, id) {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (!id) return;
    navigator.clipboard.writeText(id).then(() => window.P2P.toast?.("تم نسخ رقم الطلب ✓"));
  };

  // ---------- Order Sheet (Buy/Sell) — unchanged from previous version ----------
  function userActionForAdType(adType) { return String(adType || "") === "sell" ? "buy" : "sell"; }
  function isSelfTrade() {
    const me = String(window.P2P.state.connectedAddress || "");
    const owner = String(selectedAd?.merchantAddress || "");
    return !!me && !!owner && me === owner;
  }
  function setOrderHint(msg, color) {
    const hint = document.getElementById("orderHint"); if (!hint) return;
    if (!msg) { hint.style.display = "none"; hint.textContent = ""; return; }
    hint.style.display = "block"; hint.textContent = msg; hint.style.color = color || "";
  }
  function paymentIconFor(method) {
    const m = String(method || "").toLowerCase();
    if (m.includes("vodafone")) return "fa-mobile-screen";
    if (m.includes("insta"))    return "fa-building-columns";
    if (m.includes("etisalat")) return "fa-sim-card";
    if (m.includes("bank"))     return "fa-building-columns";
    return "fa-credit-card";
  }
  function getOrderPrice() {
    const el = document.getElementById("orderPrice"); if (!el) return 0;
    return Number((el.textContent || "0").replace(/,/g, "")) || 0;
  }
  function setOrderTimerUI() { const el = document.getElementById("orderTimer"); if (el) el.textContent = "(15 min payment window)"; }
  function stopOrderTimer() { if (orderTimerInterval) clearInterval(orderTimerInterval); orderTimerInterval = null; orderExpiresAt = 0; }
  function startOrderTimer() {
    stopOrderTimer();
    orderExpiresAt = Date.now() + ORDER_WINDOW_MS;
    setOrderTimerUI();
    orderTimerInterval = setInterval(() => {
      setOrderTimerUI();
      const btn = document.getElementById("orderActionBtn");
      if (btn && orderExpiresAt && Date.now() >= orderExpiresAt) btn.disabled = true;
      if (orderExpiresAt && Date.now() >= orderExpiresAt) stopOrderTimer();
    }, 500);
  }
  function setOrderActionUI(action) {
    const title = document.getElementById("orderTitle");
    const btn = document.getElementById("orderActionBtn");
    if (title) title.textContent = action === "sell" ? "Sell USDT" : "Buy USDT";
    if (btn) {
      btn.textContent = action === "sell" ? "Sell USDT with 0 Fees" : "Buy USDT with 0 Fees";
      btn.classList.toggle("primaryBtn--red", action === "sell");
    }
  }
  function setOrderPaymentUI(method) {
    const el = document.getElementById("orderPaymentMethod");
    const iconEl = document.getElementById("orderPaymentIcon");
    if (el) el.textContent = method || "—";
    if (iconEl) iconEl.className = `fa-solid ${paymentIconFor(method)}`;
  }
  function calcQtyFromAmount(a, p) { a = Number(a) || 0; p = Number(p) || 0; return a > 0 && p > 0 ? a / p : 0; }
  function calcAmountFromQty(q, p) { q = Number(q) || 0; p = Number(p) || 0; return q > 0 && p > 0 ? q * p : 0; }

  async function openOrder(adId) {
    const db = getDb();
    if (!db) return window.P2P.toast("Firebase غير جاهز");
    if (!adId) return window.P2P.toast("الإعلان غير موجود");
    const doc = await db.collection(ADS_COLLECTION).doc(adId).get();
    if (!doc.exists) return window.P2P.toast("الإعلان غير موجود");
    const d = doc.data() || {};
    selectedAd = {
      id: doc.id, type: d.type, price: Number(d.price) || 0,
      availableQuantity: Number(d.availableQuantity ?? d.quantity) || 0,
      merchantAddress: String(d.merchantAddress || ""),
      minLimit: Number(d.minLimit) || 0, maxLimit: Number(d.maxLimit) || 0,
      paymentMethod: String(d.paymentMethod || ""),
    };
    selectedAction = userActionForAdType(selectedAd.type);

      // ⭐ SELL GUARD
      if (selectedAction === "sell") {
        let hasPm = false;
        try {
          if (typeof window.P2P.hasPaymentMethod === "function") hasPm = await window.P2P.hasPaymentMethod();
          else {
            const _db = getDb(), _addr = window.P2P.state.connectedAddress;
            if (_db && _addr) { const _d = await _db.collection("users").doc(_addr).get(); hasPm = ((_d.exists && _d.data()?.paymentMethods)||[]).length > 0; }
          }
        } catch(_) { hasPm = false; }
        if (!hasPm) {
          window.P2P.toast("يجب إضافة طريقة دفع أولاً قبل البيع");
          setTimeout(() => { if (typeof window.openPaymentMethodsPage === "function") window.openPaymentMethodsPage(); }, 1200);
          return;
        }
      }
  
    document.getElementById("orderOverlay").style.display = "flex";
    document.getElementById("orderPrice").textContent = window.P2P.utils.format2(selectedAd.price);
    document.getElementById("orderAvailable").textContent = window.P2P.utils.format2(selectedAd.availableQuantity);
    document.getElementById("orderMinLimit").textContent = window.P2P.utils.format2(selectedAd.minLimit);
    document.getElementById("orderMaxLimit").textContent = window.P2P.utils.format2(selectedAd.maxLimit);
    setOrderPaymentUI(selectedAd.paymentMethod);
    setOrderActionUI(selectedAction);
    const amountIn = document.getElementById("orderAmountIn"); const qtyIn = document.getElementById("orderQtyIn");
    if (amountIn) amountIn.value = ""; if (qtyIn) qtyIn.value = "";
    startOrderTimer(); await validateOrder();
  }
  function closeOrder() { document.getElementById("orderOverlay").style.display = "none"; selectedAd = null; selectedAction = null; stopOrderTimer(); }
  function onOrderAmountInput() {
    if (!selectedAd) return validateOrder();
    const amount = Number(document.getElementById("orderAmountIn")?.value || 0);
    const qty = calcQtyFromAmount(amount, getOrderPrice());
    const qtyIn = document.getElementById("orderQtyIn"); if (qtyIn) qtyIn.value = qty > 0 ? window.P2P.utils.format2(qty) : "";
    validateOrder();
  }
  function onOrderQtyInput() {
    if (!selectedAd) return validateOrder();
    const qty = Number(document.getElementById("orderQtyIn")?.value || 0);
    const amount = calcAmountFromQty(qty, getOrderPrice());
    const amountIn = document.getElementById("orderAmountIn"); if (amountIn) amountIn.value = amount > 0 ? window.P2P.utils.format2(amount) : "";
    validateOrder();
  }
  async function getMaxAvailableForAction(action) {
    const db = getDb();
    if (!selectedAd) return 0;
    let maxQty = selectedAd.availableQuantity;
    if (action === "sell") {
      const addr = window.P2P.state.connectedAddress; if (!addr || !db) return 0;
      try { const u = await db.collection("users").doc(addr).get(); maxQty = Math.min(maxQty, Number(u.data()?.availableBalance) || 0); }
      catch (e) { console.error("[orders] balance lookup failed", e); }
    }
    return maxQty;
  }
  async function orderAllQty() {
    if (!selectedAd) return;
    const maxQty = await getMaxAvailableForAction(selectedAction || userActionForAdType(selectedAd.type));
    const qtyIn = document.getElementById("orderQtyIn"); if (qtyIn) qtyIn.value = window.P2P.utils.format2(maxQty);
    onOrderQtyInput();
  }
  async function orderAllAmount() {
    if (!selectedAd) return;
    const maxQty = await getMaxAvailableForAction(selectedAction || userActionForAdType(selectedAd.type));
    const amount = calcAmountFromQty(maxQty, selectedAd.price);
    const amountIn = document.getElementById("orderAmountIn"); if (amountIn) amountIn.value = window.P2P.utils.format2(amount);
    onOrderAmountInput();
  }
  async function validateOrder() {
    const db = getDb();
    const btn = document.getElementById("orderActionBtn"); if (!btn) return;
    const qtyVal = Number(document.getElementById("orderQtyIn")?.value || 0);
    const amountVal = Number(document.getElementById("orderAmountIn")?.value || 0);
    setOrderHint("");
    if (!selectedAd) { btn.disabled = true; return; }
    if (isSelfTrade()) { btn.disabled = true; setOrderHint("لا يمكنك تنفيذ طلب على إعلانك الخاص."); return; }
    if (orderExpiresAt && Date.now() >= orderExpiresAt) { btn.disabled = true; setOrderHint("انتهت مدة الدفع (15 دقيقة)"); return; }
    if (!(selectedAd.price > 0)) { btn.disabled = true; setOrderHint("سعر الإعلان غير صالح"); return; }
    if (!(qtyVal > 0) || qtyVal > selectedAd.availableQuantity) {
      btn.disabled = true;
      if (qtyVal > selectedAd.availableQuantity) setOrderHint("لا يمكنك إدخال كمية أكبر من المتاح في الإعلان");
      return;
    }
    const amount = amountVal > 0 ? amountVal : calcAmountFromQty(qtyVal, selectedAd.price);
    if (selectedAd.minLimit > 0 && amount < selectedAd.minLimit) { btn.disabled = true; setOrderHint(`الحد الأدنى هو ${window.P2P.utils.format2(selectedAd.minLimit)} EGP`); return; }
    if (selectedAd.maxLimit > 0 && amount > selectedAd.maxLimit) { btn.disabled = true; setOrderHint(`الحد الأقصى هو ${window.P2P.utils.format2(selectedAd.maxLimit)} EGP`); return; }
    const action = selectedAction || userActionForAdType(selectedAd.type);
    if (action === "sell") {
      const addr = window.P2P.state.connectedAddress;
      if (!addr) { btn.disabled = true; setOrderHint("اربط محفظتك للتحقق من الرصيد"); return; }
      if (!db) { btn.disabled = true; setOrderHint("قاعدة البيانات غير جاهزة"); return; }
      try {
        const userDoc = await db.collection("users").doc(addr).get();
        const platformBalance = Number(userDoc.data()?.availableBalance) || 0;
        if (platformBalance < qtyVal) { btn.disabled = true; setOrderHint(`رصيدك في المنصة غير كافٍ. المتاح: ${platformBalance} USDT`, "red"); return; }
      } catch (e) { console.error("[orders] balance check failed", e); }
    }
    btn.disabled = false;
  }
  async function confirmOrder() {
    const db = getDb();
    if (!selectedAd) return; if (!db) return window.P2P.toast("Firebase غير جاهز");
    const qty = Number(document.getElementById("orderQtyIn")?.value || 0); if (!(qty > 0)) return;
    const addr = window.P2P.state.connectedAddress; if (!addr) return window.P2P.toast("اربط المحفظة أولاً");
    if (String(addr) === String(selectedAd.merchantAddress || "")) return window.P2P.toast("لا يمكنك تنفيذ طلب على إعلانك الخاص.");
    const action = selectedAction || userActionForAdType(selectedAd.type);
    const expiresAt = Date.now() + ORDER_WINDOW_MS;
    let createdOrderId = null;
    const adRef = db.collection(ADS_COLLECTION).doc(selectedAd.id);
    const isAdSell = String(selectedAd.type || "").toLowerCase() === "sell";
    const sellerAddress = isAdSell ? selectedAd.merchantAddress : addr;
    const buyerAddress  = isAdSell ? addr : selectedAd.merchantAddress;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(adRef); if (!snap.exists) throw new Error("ad_missing");
        const ad = snap.data() || {};
        const owner = String(ad.merchantAddress || selectedAd.merchantAddress || "");
        if (addr && owner && addr === owner) throw new Error("self_trade");
        const available = Number(ad.availableQuantity ?? ad.quantity) || 0;
        if (qty > available) throw new Error("not_enough_available");
        if (action === "sell") {
          const userRef = db.collection("users").doc(addr);
          const userSnap = await tx.get(userRef);
          const platformBalance = Number(userSnap.data()?.availableBalance) || 0;
          if (platformBalance < qty) throw new Error("insufficient_platform_balance");
        }
        if (!buyerAddress || !sellerAddress || buyerAddress === sellerAddress) throw new Error("buyer_seller_invalid");
        tx.update(adRef, { availableQuantity: available - qty });
        const orderRef = db.collection(ORDERS_COLLECTION).doc();
        createdOrderId = orderRef.id;
        tx.set(orderRef, {
          adId: selectedAd.id, adType: ad.type, merchantAddress: selectedAd.merchantAddress,
          userAddress: addr, userAction: action, buyerAddress, sellerAddress,
          price: selectedAd.price, quantity: qty, amount: calcAmountFromQty(qty, selectedAd.price),
          paymentMethod: selectedAd.paymentMethod || "", currency: "EGP", asset: "USDT",
          status: "active", paymentConfirmed: false, released: false, proofImage: null,
          expiresAt,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
      if (createdOrderId) {
        db.collection("Notifications").add({
          to: selectedAd.merchantAddress, from: addr, orderId: createdOrderId,
          type: "new_order", timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        }).catch((e) => console.warn("[orders] notification failed", e));
      }
      window.P2P.toast("تم إنشاء الطلب بنجاح ✓");
      closeOrder();
      if (createdOrderId) window.location.href = `order-details.html?orderId=${encodeURIComponent(createdOrderId)}`;
    } catch (e) {
      console.error("[orders] confirmOrder failed", e);
      const map = {
        self_trade: "لا يمكنك تنفيذ طلب على إعلانك الخاص.",
        ad_missing: "الإعلان لم يعد موجوداً.",
        not_enough_available: "الكمية المطلوبة أكبر من المتاح في الإعلان.",
        insufficient_platform_balance: "رصيدك في المنصة غير كافٍ.",
        buyer_seller_invalid: "تعذر تحديد البائع والمشتري بشكل صحيح.",
      };
      window.P2P.toast(map[String(e?.message || "")] || "فشل إنشاء الطلب، حاول مرة أخرى.");
    }
  }

  // ---------- Tabs ----------
  function setOrdersTab(tab) {
    window.P2P.state.ordersTab = tab;
    document.getElementById("ordersTabActive")?.classList.toggle("tab--active", tab === "active");
    document.getElementById("ordersTabCompleted")?.classList.toggle("tab--active", tab === "completed");
    document.getElementById("ordersTabCanceled")?.classList.toggle("tab--active", tab === "canceled");
    subscribeOrders();
  }

  // ---------- ⭐ EXPIRY: Helpers ----------
  // الطلب يعتبر منتهي الصلاحية لو:
  //   status = "active" + لسه ما اتأكدش الدفع + expiresAt موجود + الوقت عدى
  // (الطلبات اللي في pending_admin_release لا تنتهي — لأن الدفع تم وفي مرحلة المراجعة)
  function isOrderExpired(o) {
    if (!o) return false;
    if (o.status !== "active") return false;
    if (o.paymentConfirmed) return false;
    const exp = Number(o.expiresAt || 0);
    if (exp <= 0) return false;
    return Date.now() >= exp;
  }

  // ⭐ EXPIRY: تحديث Firestore لما الوقت يخلص — مع guard ضد التكرار
  async function autoCancelExpiredOrder(orderId) {
    if (!orderId || _autoCancelInFlight.has(orderId)) return;
    const db = getDb();
    if (!db) return;
    _autoCancelInFlight.add(orderId);
    try {
      // اقرأ بيانات الأوردر عشان تعرف adId والكمية
      const orderSnap = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
      if (orderSnap.exists) {
        const o = orderSnap.data();
        // ⭐ استرداد availableQuantity في الإعلان
        if (o.adId && Number(o.quantity) > 0) {
          try {
            const adRef = db.collection(ADS_COLLECTION).doc(o.adId);
            await db.runTransaction(async (tx) => {
              const adSnap = await tx.get(adRef);
              if (!adSnap.exists) return;
              const cur = Number(adSnap.data().availableQuantity ?? adSnap.data().quantity ?? 0);
              tx.update(adRef, { availableQuantity: cur + Number(o.quantity) });
            });
          } catch (re) {
            console.warn("[orders] restoreQty on expiry failed", re);
          }
        }
      }
      await db.collection(ORDERS_COLLECTION).doc(orderId).update({
        status: "canceled",
        canceledAt: firebase.firestore.FieldValue.serverTimestamp(),
        cancelReason: "expired",
      });
    } catch (e) {
      console.warn("[orders] autoCancelExpiredOrder failed", orderId, e);
    } finally {
      // نسيب الـ id في الـ set لمدة بسيطة عشان snapshot يلحق يجيب الحالة الجديدة
      setTimeout(() => _autoCancelInFlight.delete(orderId), 5000);
    }
  }

  // ---------- Live Cards Timer (single interval) ----------
  function startCardsTicker() {
    if (cardsTickerInterval) return;
    cardsTickerInterval = setInterval(() => {
      const list = document.querySelectorAll(".orderCard__timer .timerVal[data-expires]");
      if (!list.length) return;
      const now = Date.now();
      list.forEach((el) => {
        const exp = Number(el.getAttribute("data-expires")) || 0;
        const remaining = exp - now;
        el.textContent = exp > 0 ? fmtTime(remaining) : "—";

        // ⭐ EXPIRY: لما العداد يوصل لصفر، اطلب auto-cancel لـ Firestore.
        // الـ snapshot listener هيحدّث الواجهة تلقائياً (الكارت ينتقل من active → canceled).
        if (exp > 0 && remaining <= 0) {
          const card = el.closest(".orderCard");
          const orderId = card?.getAttribute("data-id");
          if (orderId) autoCancelExpiredOrder(orderId);
        }
      });
    }, 1000);
  }

  // ---------- Subscribe + Render Orders ----------
  function subscribeOrders() {
    const db = getDb();
    if (!db) return;
    const addr = window.P2P.state.connectedAddress; if (!addr) return;
    if (typeof unsubOrders === "function") unsubOrders();
    const list = document.getElementById("ordersList"); if (!list) return;

    unsubOrders = db.collection(ORDERS_COLLECTION).onSnapshot((snap) => {
      const currentTab = window.P2P.state.ordersTab;

      // ⭐ EXPIRY: قبل الفلترة، شوف لو فيه طلبات خلصت مدتها (مثلاً المستخدم كان قافل التطبيق)
      //           وابعتلها update لـ Firestore عشان تتحدّث في كل الأجهزة.
      snap.docs.forEach((d) => {
        const o = { id: d.id, ...d.data() };
        const isParticipant = o.userAddress === addr || o.merchantAddress === addr
                           || o.buyerAddress === addr || o.sellerAddress === addr;
        if (isParticipant && isOrderExpired(o)) {
          autoCancelExpiredOrder(o.id);
        }
      });

      const mine = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((o) => {
          const isParticipant = o.userAddress === addr || o.merchantAddress === addr
                             || o.buyerAddress === addr || o.sellerAddress === addr;
          if (!isParticipant) return false;

          // ⭐ EXPIRY: الطلب اللي خلصت مدته يبقى ملغي فوراً في الـ UI
          //   (حتى قبل ما الـ update يوصل من Firestore) — يختفي من active،
          //   يظهر في canceled، ومايظهرش في completed.
          const expired = isOrderExpired(o);

          if (currentTab === "active") {
            if (expired) return false;
            return o.status === "active" || o.status === "pending_admin_release";
          }
          if (currentTab === "completed") return o.status === "completed";
          if (currentTab === "canceled")  return o.status === "canceled" || expired;
          return false;
        })
        .sort((a, b) => {
          const ta = (a.createdAt?.seconds || a.timestamp?.seconds || a.expiresAt || 0);
          const tb = (b.createdAt?.seconds || b.timestamp?.seconds || b.expiresAt || 0);
          return tb - ta;
        });

      if (!mine.length) {
        list.innerHTML = `<div class="ordersEmpty">لا توجد طلبات في هذا القسم</div>`;
        return;
      }

      list.innerHTML = mine.map((o) => renderOrderCard(o, addr)).join("");
      startCardsTicker();

      // Async fill counterparty names
      mine.forEach((o) => {
        const cp = counterpartyAddr(o, addr);
        getDisplayName(cp).then((name) => {
          document
            .querySelectorAll(`.orderChatBtn[data-order="${o.id}"] .chatName`)
            .forEach((el) => { el.textContent = name; });
        });
      });
    });
  }

  // ===============================================================
  // ORDER COUNTER BADGE — listener منفصل بيشتغل دايماً
  // ===============================================================
  // - بيعد الطلبات النشطة (active + pending_admin_release) للمستخدم
  // - بيحدّث badge أحمر فوق أيقونة "الطلبات" في الـ bottomNav
  // - بيشتغل بـ snapshot listener موجود أصلاً (مفيش overhead إضافي)
  // ===============================================================
  function subscribeOrdersBadge() {
    const db = getDb();
    if (!db) return;
    const addr = window.P2P.state.connectedAddress; if (!addr) return;
    if (typeof unsubOrdersBadge === "function") unsubOrdersBadge();

    unsubOrdersBadge = db.collection(ORDERS_COLLECTION).onSnapshot((snap) => {
      let count = 0;
      snap.docs.forEach((d) => {
        const o = { id: d.id, ...(d.data() || {}) };
        const isParticipant = o.userAddress === addr || o.merchantAddress === addr
                           || o.buyerAddress === addr || o.sellerAddress === addr;
        if (!isParticipant) return;
        // ⭐ EXPIRY: الطلبات اللي خلصت مدتها ما تنعدش كـ "نشطة"
        if (isOrderExpired(o)) return;
        if (o.status === "active" || o.status === "pending_admin_release") count++;
      });
      updateOrdersBadge(count);
    });
  }

  function updateOrdersBadge(count) {
    // (1) Badge في الـ bottom-nav (orders = idx 1)
    const navItems = document.querySelectorAll(".bottomNav__item");
    const ordersBtn = navItems[1];
    if (ordersBtn) {
      let badge = ordersBtn.querySelector(".navBadge");
      if (count > 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "navBadge";
          ordersBtn.style.position = "relative";
          ordersBtn.appendChild(badge);
        }
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.style.display = "flex";
      } else if (badge) {
        badge.style.display = "none";
      }
    }

    // (2) ⛔ ordersHeaderBadge اتشال — كانت دايرة عايمة برّه الكونتينر
    //     سيبنا الـ badge بس على أيقونة الـ bottom-nav (مكانها الطبيعي).
    //     بنشيل أي بقايا قديمة لو موجودة في الـ DOM:
    document.querySelectorAll(".ordersHeaderBadge").forEach((el) => el.remove());
  }

  function renderOrderCard(o, myAddr) {
    const action = actionForRole(o, myAddr);
    const status = statusLabel(o);
    const cp = counterpartyAddr(o, myAddr);
    const cpFallback = cp ? "Trader_" + String(cp).slice(-4) : "Trader";
    const created = fmtDateTime(o.createdAt || o.timestamp);
    const expires = Number(o.expiresAt || 0);
    const showTimer = o.status === "active" && !o.paymentConfirmed && expires > 0;

    return `
      <article class="orderCard" data-id="${o.id}">
        <div class="orderCard__head">
          <div class="orderCard__type ${action.cls}">${action.label}</div>
          <div class="orderCard__status ${status.cls}" onclick="openOrderDetails('${o.id}')">
            <span class="statusDot"></span>${status.text}
          </div>
        </div>

        ${showTimer ? `
        <div class="orderCard__timer">
          <i class="fa-regular fa-clock"></i>
          <span class="timerVal" data-expires="${expires}">${fmtTime(expires - Date.now())}</span>
        </div>` : `<div style="height:6px;"></div>`}

        <div class="orderCard__body">
          <div class="orderRow"><span class="orderLabel">المبلغ</span><span class="orderVal">E£ ${fmt2(o.amount)}</span></div>
          <div class="orderRow"><span class="orderLabel">السعر</span><span class="orderVal">E£ ${fmt2(o.price)}</span></div>
          <div class="orderRow"><span class="orderLabel">الكمية</span><span class="orderVal">${fmt2(o.quantity)} USDT</span></div>
          <div class="orderRow">
            <span class="orderLabel">رقم الطلب</span>
            <span class="orderVal">
              <button class="orderCopyBtn" type="button" onclick="copyOrderId(event, '${o.id}')" aria-label="نسخ رقم الطلب">
                <i class="fa-regular fa-copy"></i>
              </button>
              <span class="orderIdText" title="${escapeAttr(o.id)}">${shortId(o.id)}</span>
            </span>
          </div>
        </div>

        <div class="orderCard__footer">
          <button class="orderChatBtn" type="button" data-order="${o.id}" onclick="openChat('${o.id}')">
            <i class="fa-regular fa-comment"></i>
            <span class="chatName">${cpFallback}</span>
          </button>
          <div class="orderDate">${created}</div>
        </div>
      </article>`;
  }

  function openOrderDetails(orderId) {
    if (!orderId) return;
    window.location.href = `order-details.html?orderId=${encodeURIComponent(orderId)}`;
  }

  // ---------- Globals ----------
  window.openOrder = openOrder;
  window.closeOrder = closeOrder;
  window.validateOrder = validateOrder;
  window.confirmOrder = confirmOrder;
  window.onOrderAmountInput = onOrderAmountInput;
  window.onOrderQtyInput = onOrderQtyInput;
  window.orderAllQty = orderAllQty;
  window.orderAllAmount = orderAllAmount;
  window.setOrdersTab = setOrdersTab;
  window.openOrderDetails = openOrderDetails;

  document.addEventListener("p2p:walletConnected", () => {
    subscribeOrders();
    subscribeOrdersBadge(); // ✅ ابدأ الـ badge listener فور ما المحفظة تتربط
  });
})();
