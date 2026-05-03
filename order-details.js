/* eslint-disable no-console */

// ------------------------------------------------------------
// order-details.js — THE MAESTRO (Escrow Flow) — BSC Edition
// ------------------------------------------------------------
// Real-time "mirror" of admin release state:
//   pending_admin_release + releaseTxPending=false → spinner "قيد المراجعة"
//   pending_admin_release + releaseTxPending=true  → spinner "المعاملة على BSC" + txHash link
//   completed                                      → ✅ green checkmark + txHash link
// ------------------------------------------------------------

(function () {
  const db = window.db;
  if (!db) {
    alert("Firebase غير جاهز. تأكد من تحميل firebase-config.js قبل هذا الملف.");
    return;
  }

  const ORDERS_COLLECTION  = "Orders";
  const ADS_COLLECTION     = "ads";
  const REMINDER_WINDOW_MS = 3 * 60 * 1000;
  const BSC_EXPLORER       = "https://bscscan.com";

  // ⭐ استرداد الكمية المتاحة في الإعلان عند إلغاء الأوردر
  async function restoreAdAvailableQty(order) {
    if (!order || !order.adId || !(Number(order.quantity) > 0)) return;
    try {
      const adRef = db.collection(ADS_COLLECTION).doc(order.adId);
      await db.runTransaction(async (tx) => {
        const adSnap = await tx.get(adRef);
        if (!adSnap.exists) return;
        const cur = Number(adSnap.data().availableQuantity ?? adSnap.data().quantity ?? 0);
        tx.update(adRef, { availableQuantity: cur + Number(order.quantity) });
      });
    } catch (e) {
      console.warn("[order-details] restoreAdAvailableQty failed", e);
    }
  }

  // ---------- Inject Spinner / Completed Box Styles ----------
  (function injectStyles() {
    if (document.getElementById("p2p-od-runtime-styles")) return;
    const s = document.createElement("style");
    s.id = "p2p-od-runtime-styles";
    s.textContent = `
      .processing-box { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:35px 20px; background:#fff; border-radius:20px; border:1px solid #EAECEF; margin:20px; gap:18px; box-shadow:0 4px 16px rgba(0,0,0,0.04); }
      .processing-spinner { width:60px; height:60px; border:5px solid #EAECEF; border-top-color:#1E2329; border-radius:50%; animation:p2p-spin 0.9s linear infinite; }
      @keyframes p2p-spin { to { transform:rotate(360deg); } }
      .processing-text { font-size:17px; font-weight:800; color:#1E2329; text-align:center; }
      .processing-sub { font-size:13px; color:#848E9C; text-align:center; line-height:1.6; max-width:320px; }
      .processing-pulse { display:inline-block; width:8px; height:8px; border-radius:50%; background:#f0b90b; margin-right:6px; animation:p2p-pulse 1.4s ease-in-out infinite; }
      @keyframes p2p-pulse { 0%,100%{opacity:.3;transform:scale(.8)} 50%{opacity:1;transform:scale(1.1)} }
      .processing-tx-link { display:inline-block; margin-top:10px; font-size:11px; font-family:monospace; color:#3b82f6; background:#eff6ff; padding:5px 10px; border-radius:8px; border:1px solid #bfdbfe; text-decoration:none; word-break:break-all; max-width:280px; }
      .processing-tx-link:hover { text-decoration:underline; }
      .completed-box { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:40px 20px; background:#fff; border-radius:20px; border:1px solid #EAECEF; margin:20px; gap:16px; box-shadow:0 4px 16px rgba(0,0,0,0.04); }
      .completed-check { width:78px; height:78px; border-radius:50%; background:linear-gradient(135deg,#E8F8F0,#d4f4e2); display:flex; align-items:center; justify-content:center; box-shadow:0 6px 20px rgba(2,192,118,0.18); animation:p2p-pop 0.5s cubic-bezier(.2,1.2,.4,1); }
      @keyframes p2p-pop { from { transform:scale(0.4); opacity:0; } to { transform:scale(1); opacity:1; } }
      .completed-check svg { width:38px; height:38px; }
      .completed-title { font-size:19px; font-weight:800; color:#02C076; }
      .completed-sub { font-size:13px; color:#5E6673; text-align:center; line-height:1.6; max-width:320px; }
      .completed-tx-link { display:inline-block; font-size:11px; font-family:monospace; color:#3b82f6; background:#eff6ff; padding:5px 10px; border-radius:8px; border:1px solid #bfdbfe; text-decoration:none; word-break:break-all; max-width:280px; }
      .completed-tx-link:hover { text-decoration:underline; }
    `;
    document.head.appendChild(s);
  })();

  // ---------- Payment Method Helpers ----------
  function getPaymentTitle(method) {
    const titles = {
      "Instapay":        "افتح انستاباي للدفع",
      "Vodafone Cash":   "افتح فودافون كاش للدفع",
      "Etisalat Cash":   "افتح اتصالات كاش للدفع",
      "Banque Misr":     "حوّل عبر بنك مصر",
      "AL MASHREQ Bank": "حوّل عبر بنك المشرق",
      "Ahlibank":        "حوّل عبر البنك الأهلي",
      "Alex Bank":       "حوّل عبر بنك الإسكندرية",
      "NBE":             "حوّل عبر البنك الأهلي المصري",
      "CIB":             "حوّل عبر بنك CIB",
      "ADIB BANK":       "حوّل عبر بنك ADIB",
      "HSBC":            "حوّل عبر بنك HSBC",
      "QNB":             "حوّل عبر بنك QNB",
    };
    return titles[method] || "أكمل الدفع عبر " + (method || "وسيلة الدفع");
  }

  function getFallbackConfig(method) {
    return {
      title: getPaymentTitle(method),
      method: method || "—",
      receiver: "—",
      address: "—",
      addressLabel: "العنوان",
    };
  }

  async function fetchAndShowSellerPayment(order) {
    if (!order) return;
    if (userRole !== "buyer") return;
    const sellerAddr = order.sellerAddress || order.merchantAddress || null;
    if (!sellerAddr) return;
    try {
      let info = null;
      if (typeof window.P2P?.getSellerPaymentInfo === "function") {
        info = await window.P2P.getSellerPaymentInfo(sellerAddr, order.paymentMethod);
      } else {
        const doc = await db.collection("users").doc(sellerAddr).get();
        if (doc.exists) {
          const data = doc.data() || {};
          const methods = Array.isArray(data.paymentMethods) ? data.paymentMethods : [];
          const name = data.displayName || data.name || data.username || ("Trader_" + String(sellerAddr).slice(-4));
          let matched = null;
          if (order.paymentMethod && methods.length > 0) {
            matched = methods.find(
              (m) => String(m.type || "").toLowerCase() === String(order.paymentMethod).toLowerCase()
            );
          }
          const primary = matched || methods[0] || null;
          if (primary) info = { name, paymentMethods: methods, primaryMethod: primary };
        }
      }
      if (!info || !info.primaryMethod) {
        const cfg = getFallbackConfig(order.paymentMethod);
        _injectPaymentDOM(cfg.receiver, cfg.addressLabel, cfg.address, null, order);
        return;
      }
      const pm = info.primaryMethod;
      const CASH_TYPES = ["Vodafone Cash", "Instapay", "Etisalat Cash"];
      const isCash = CASH_TYPES.includes(pm.type);
      const numberValue = isCash ? (pm.mobile || pm.number || "—") : (pm.iban || pm.number || "—");
      const labelText  = "Instant Payment Address";
      const receiverName = info.name || "—";
      const bankName   = (!isCash && pm.bankName) ? pm.bankName : null;
      _injectPaymentDOM(receiverName, labelText, numberValue, bankName, order);
    } catch (e) {
      console.warn("[order-details] fetchAndShowSellerPayment error", e);
      const cfg = getFallbackConfig(order.paymentMethod);
      _injectPaymentDOM(cfg.receiver, cfg.addressLabel, cfg.address, null, order);
    }
  }

  function _injectPaymentDOM(receiver, addressLabel, address, bankName, order) {
    if ($("id_valReceiver"))     $("id_valReceiver").textContent     = receiver;
    if ($("id_valAddressLabel")) $("id_valAddressLabel").textContent = addressLabel;
    const addrEl = $("id_valAddress");
    if (addrEl) addrEl.textContent = address;
    if (bankName) {
      let bankRow = $("id_valBankNameRow");
      if (!bankRow) {
        const receiverRow = $("id_valReceiver")?.closest(".data-row");
        if (receiverRow) {
          bankRow = document.createElement("div");
          bankRow.id = "id_valBankNameRow";
          bankRow.className = "data-row";
          bankRow.innerHTML = `<span class="label">البنك</span><span class="val" id="id_valBankName">${bankName}</span>`;
          receiverRow.parentNode.insertBefore(bankRow, receiverRow.nextSibling);
        }
      } else {
        const bankNameEl = $("id_valBankName");
        if (bankNameEl) bankNameEl.textContent = bankName;
      }
    }
    if ($("id_paymentMethodName")) $("id_paymentMethodName").textContent = order.paymentMethod || "—";
    if ($("p2_payment_method"))    $("p2_payment_method").textContent    = order.paymentMethod || "—";
    if ($("id_orderStatusTitle") && userRole === "buyer" && lastOrder && !lastOrder.paymentConfirmed) {
      $("id_orderStatusTitle").textContent = getPaymentTitle(order.paymentMethod);
    }
  }

  // ---------- State ----------
  let orderId            = null;
  let currentAddress     = null;
  let lastOrder          = null;
  let userRole           = "viewer";
  let unsubOrder         = null;
  let mainTimerInterval  = null;
  let reminderTimerInterval = null;
  let proofFile          = null;
  let confirmChoice      = null;
  let autoCancelGuard    = false;

  // ---------- Helpers ----------
  function $(id) { return document.getElementById(id); }
  function fmt2(n) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(2) : "0.00"; }
  function fmtTime(ms) {
    if (ms <= 0) return "00:00";
    const t = Math.floor(ms / 1000);
    const m = Math.floor(t / 60), s = t % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function showToast(msg) {
    const t = $("id_toast");
    if (!t) return;
    t.innerText = msg;
    t.style.display = "block";
    setTimeout(() => (t.style.display = "none"), 1800);
  }
  window.copyText = function (id) {
    const el = $(id);
    if (!el) return;
    navigator.clipboard.writeText(el.innerText).then(() => showToast("تم النسخ بنجاح"));
  };
  function tsToMillis(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (ts.seconds) return ts.seconds * 1000;
    return 0;
  }

  // ---------- Wallet Detection (BSC/EVM) ----------
  async function detectAddress() {
    try {
      if (window.ethereum) {
        const accounts = await window.ethereum.request({ method: "eth_accounts" });
        if (accounts && accounts[0]) {
          const addr = accounts[0].toLowerCase();
          try { localStorage.setItem("p2p_address", addr); } catch (_) {}
          return addr;
        }
      }
    } catch (e) {
      console.warn("[order-details] eth_accounts failed:", e);
    }
    try {
      const cached = localStorage.getItem("p2p_address");
      if (cached) return cached;
    } catch (_) {}
    return null;
  }

  function determineRole(order, addr) {
    if (!order || !addr) return "viewer";
    const a = String(addr).toLowerCase();
    if (String(order.buyerAddress || "").toLowerCase() === a) return "buyer";
    if (String(order.sellerAddress || "").toLowerCase() === a) return "seller";
    if (String(order.merchantAddress || "").toLowerCase() === a) return "seller";
    return "viewer";
  }

  // ---------- Step Indicator ----------
  function updateProgress(step) {
    for (let i = 1; i <= 3; i++) {
      const s = $("s" + i);
      if (!s) continue;
      if (i <= step) s.classList.add("active");
      else s.classList.remove("active");
    }
  }

  // ---------- Main Timer ----------
  function stopMainTimer() {
    if (mainTimerInterval) clearInterval(mainTimerInterval);
    mainTimerInterval = null;
  }
  function startMainTimer(expiresAtMs) {
    stopMainTimer();
    const tick = () => {
      const remaining = expiresAtMs - Date.now();
      const disp = $("id_countdownTimer");
      if (disp) disp.textContent = fmtTime(remaining);
      if (remaining <= 0) { stopMainTimer(); autoCancelIfExpired(); }
    };
    tick();
    mainTimerInterval = setInterval(tick, 1000);
  }

  // ---------- Reminder Timer ----------
  function stopReminderTimer() {
    if (reminderTimerInterval) clearInterval(reminderTimerInterval);
    reminderTimerInterval = null;
  }
  function startReminderTimer(reminderUntilMs) {
    stopReminderTimer();
    const waitingBtn  = $("id_waitingBtn");
    const expectTimer = $("id_expectTimer");
    const threeMinDisp = $("id_threeMinTimer");
    const tick = () => {
      const remaining = reminderUntilMs - Date.now();
      const txt = fmtTime(Math.max(0, remaining));
      if (threeMinDisp) threeMinDisp.textContent = txt;
      if (expectTimer)  expectTimer.textContent  = txt;
      if (remaining <= 0) {
        stopReminderTimer();
        if (waitingBtn) {
          waitingBtn.classList.remove("disabled-state");
          waitingBtn.style.pointerEvents = "auto";
          waitingBtn.style.opacity = "1";
          waitingBtn.innerHTML = '<span style="font-weight:700;">تذكير الطرف المقابل</span>';
          waitingBtn.onclick = () => showToast(userRole === "buyer" ? "تم تذكير البائع" : "تم تذكير المشتري");
        }
      } else if (waitingBtn) {
        waitingBtn.classList.add("disabled-state");
        waitingBtn.style.pointerEvents = "none";
      }
    };
    tick();
    reminderTimerInterval = setInterval(tick, 1000);
  }

  // ---------- Auto-cancel ----------
  async function autoCancelIfExpired() {
    if (autoCancelGuard || !lastOrder) return;
    if (lastOrder.status !== "active" || lastOrder.paymentConfirmed) return;
    autoCancelGuard = true;
    try {
      await restoreAdAvailableQty(lastOrder);
      await db.collection(ORDERS_COLLECTION).doc(orderId).update({
        status: "canceled",
        canceledAt: firebase.firestore.FieldValue.serverTimestamp(),
        cancelReason: "expired",
      });
    } catch (e) {
      console.warn("[order-details] auto-cancel failed", e);
    } finally {
      autoCancelGuard = false;
    }
  }

  // ---------- Dynamic UI Boxes ----------
  function ensureProcessingBox() {
    let box = $("id_processingBox");
    if (!box) {
      box = document.createElement("div");
      box.id = "id_processingBox";
      box.className = "processing-box";
      box.style.display = "none";
      box.innerHTML = `
        <div class="processing-spinner"></div>
        <div class="processing-text"><span class="processing-pulse"></span>الطلب قيد المعالجة...</div>
        <div class="processing-sub">جارٍ تحرير العملات من المحفظة الوسيطة. قد يستغرق ذلك بضع دقائق.</div>
      `;
      const phase2 = $("id_phase2");
      if (phase2 && phase2.parentNode) phase2.parentNode.insertBefore(box, phase2.nextSibling);
      else document.body.appendChild(box);
    }
    return box;
  }
  function ensureCompletedBox() {
    let box = $("id_completedBox");
    if (!box) {
      box = document.createElement("div");
      box.id = "id_completedBox";
      box.className = "completed-box";
      box.style.display = "none";
      box.innerHTML = `
        <div class="completed-check">
          <svg viewBox="0 0 24 24" fill="none" stroke="#02C076" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div class="completed-title">تم التحرير بنجاح</div>
        <div class="completed-sub">تم استلام العملات في محفظة المشتري. شكراً لاستخدامك المنصة.</div>
      `;
      const phase2 = $("id_phase2");
      if (phase2 && phase2.parentNode) phase2.parentNode.insertBefore(box, phase2.nextSibling);
      else document.body.appendChild(box);
    }
    return box;
  }
  function showProcessing(show) { ensureProcessingBox().style.display = show ? "flex" : "none"; }
  function showCompleted(show)  { ensureCompletedBox().style.display  = show ? "flex" : "none"; }
  function hideAllStateBoxes()  { showProcessing(false); showCompleted(false); }

  // ── updateProcessingBox: يُحدّث محتوى صندوق التحميل بناءً على حالة الطلب ──
  function updateProcessingBox(order) {
    const box    = ensureProcessingBox();
    const textEl = box.querySelector(".processing-text");
    const subEl  = box.querySelector(".processing-sub");

    // هل المعاملة مُبثّة على البلوكشين فعلاً؟
    const onChain = !!order.releaseTxPending && !!order.adminReleaseTxHash;

    if (onChain) {
      // ─ المرحلة 2: tx مُرسل — جارٍ التأكيد على BSC ──────────────────────────
      if (textEl) textEl.innerHTML =
        '<span class="processing-pulse"></span>المعاملة جارية على البلوكشين...';

      if (subEl) {
        const shortHash = order.adminReleaseTxHash.slice(0, 16) + "…";
        subEl.innerHTML =
          `جارٍ تأكيد تحويل USDT على شبكة BSC.<br>
           ستصل العملات إلى محفظتك فور اكتمال التأكيد.<br>
           <a class="processing-tx-link"
              href="${BSC_EXPLORER}/tx/${order.adminReleaseTxHash}"
              target="_blank">
             🔗 ${shortHash} — متابعة على BSCScan
           </a>`;
      }
    } else {
      // ─ المرحلة 1: في انتظار الأدمن ──────────────────────────────────────────
      if (textEl) textEl.innerHTML =
        '<span class="processing-pulse"></span>الطلب قيد المعالجة...';
      if (subEl) subEl.textContent =
        "جارٍ تحرير العملات من المحفظة الوسيطة. قد يستغرق ذلك بضع دقائق حتى تنتهي الإدارة من المراجعة.";

      // أزل رابط الـ Hash لو كان موجوداً من حالة سابقة
      const oldLink = box.querySelector(".processing-tx-link");
      if (oldLink) oldLink.remove();
    }
  }

  // ── updateCompletedBox: يُضيف رابط الـ Hash إلى صندوق النجاح ──────────────
  function updateCompletedBox(order) {
    const box = ensureCompletedBox();
    const existingLink = box.querySelector(".completed-tx-link");

    if (order.adminReleaseTxHash) {
      if (!existingLink) {
        const link = document.createElement("a");
        link.className  = "completed-tx-link";
        link.href       = `${BSC_EXPLORER}/tx/${order.adminReleaseTxHash}`;
        link.target     = "_blank";
        link.textContent = `🔗 ${order.adminReleaseTxHash.slice(0, 16)}… — عرض على BSCScan`;
        box.appendChild(link);
      } else {
        existingLink.href       = `${BSC_EXPLORER}/tx/${order.adminReleaseTxHash}`;
        existingLink.textContent = `🔗 ${order.adminReleaseTxHash.slice(0, 16)}… — عرض على BSCScan`;
      }
    }
  }

  // ---------- Render ----------
  function renderOrder(order) {
    lastOrder = order;
    userRole  = determineRole(order, currentAddress);

    const counterparty = userRole === "buyer"
      ? (order.sellerAddress || order.merchantAddress)
      : order.buyerAddress;
    const nameEl = $("id_sellerDisplayName");
    if (nameEl) nameEl.textContent = counterparty ? "Trader_" + String(counterparty).slice(-4) : "BSC Wallet";

    [$("id_valReference"), $("p2_display_ref")].forEach((el) => {
      if (el) el.textContent = order.id || orderId;
    });

    if ($("id_paymentMethodName")) $("id_paymentMethodName").textContent = order.paymentMethod || "—";
    if ($("p2_payment_method"))    $("p2_payment_method").textContent    = order.paymentMethod || "—";
    if ($("id_valAmount"))         $("id_valAmount").textContent         = "E£ " + fmt2(order.amount);

    if (userRole === "buyer" && order.status === "active" && !order.paymentConfirmed) {
      if ($("id_valReceiver"))     $("id_valReceiver").textContent     = "جاري التحميل...";
      if ($("id_valAddress"))      $("id_valAddress").textContent      = "—";
      if ($("id_valAddressLabel")) $("id_valAddressLabel").textContent = "رقم";
      fetchAndShowSellerPayment(order);
    }

    const p2Type = $("p2_type_text");
    if (p2Type) {
      if (userRole === "buyer")  { p2Type.textContent = "شراء"; p2Type.className = "type-buy"; }
      else if (userRole === "seller") { p2Type.textContent = "بيع"; p2Type.className = "type-sell"; }
    }
    if ($("p2_display_amount")) $("p2_display_amount").textContent = "E£ " + fmt2(order.amount);
    if ($("p2_display_price"))  $("p2_display_price").textContent  = "E£ " + fmt2(order.price);
    if ($("p2_display_qty"))    $("p2_display_qty").textContent    = fmt2(order.quantity) + " USDT";

    if (order.status === "canceled")              return renderCanceled(order);
    if (order.status === "completed")             return renderCompleted(order);
    if (order.status === "pending_admin_release") return renderPendingAdmin(order);
    if (!order.paymentConfirmed)                  return renderActiveBeforePayment(order);
    if (order.paymentConfirmed && !order.released) return renderActiveAfterPayment(order);
  }

  function setMainBtnText(text, opts = {}) {
    const btn = $("id_openUploadSheetBtn");
    if (!btn) return;
    btn.style.display = opts.hidden ? "none" : "block";
    btn.disabled      = !!opts.disabled;
    btn.textContent   = text;
    btn.style.background = opts.background || "";
    btn.style.color      = opts.color      || "";
    btn.style.border     = opts.border     || "";
  }
  function showWaitingBtn(show) { const b = $("id_waitingBtn"); if (b) b.style.display = show ? "flex" : "none"; }
  function showCancelLink(show) { const l = $("id_cancelOrderBtn"); if (l) l.style.display = show ? "block" : "none"; }
  function showSellerProofIfAny(order) {
    const block = $("id_sellerProofPreview");
    const img   = $("id_sellerProofImg");
    if (!block || !img) return;
    if (userRole === "seller" && order.proofImage) {
      img.src = order.proofImage;
      block.style.display = "block";
    } else {
      block.style.display = "none";
    }
  }

  function renderActiveBeforePayment(order) {
    updateProgress(1);
    hideAllStateBoxes();
    $("id_phase1").style.display   = "block";
    $("id_phase2").style.display   = "none";
    $("id_timerWrapper").style.display  = "block";
    $("id_expectWrapper").style.display = "none";
    const expiresAt = Number(order.expiresAt) || 0;
    if (expiresAt > 0) startMainTimer(expiresAt);
    showSellerProofIfAny(order);
    if (userRole === "buyer") {
      $("id_orderStatusTitle").textContent = getPaymentTitle(order.paymentMethod);
      $("id_step2Hint").textContent = "ارفع إثبات الدفع ليتمكن البائع من تحرير العملات.";
      setMainBtnText("رفع إثبات الدفع");
      showWaitingBtn(false); showCancelLink(true);
    } else if (userRole === "seller") {
      $("id_orderStatusTitle").textContent = "في انتظار تحويل المشتري";
      $("id_step2Hint").textContent = "بمجرد إرسال المشتري إثبات الدفع، ستظهر لك خيارات التحقق.";
      setMainBtnText("في انتظار المشتري...", { disabled: true, background: "transparent", color: "#848E9C", border: "1px solid rgba(132, 142, 156, 0.2)" });
      showWaitingBtn(false); showCancelLink(false);
    } else {
      $("id_orderStatusTitle").textContent = "طلب نشط";
      setMainBtnText("غير مصرح", { disabled: true });
      showWaitingBtn(false); showCancelLink(false);
    }
  }

  function renderActiveAfterPayment(order) {
    updateProgress(2);
    hideAllStateBoxes();
    $("id_phase1").style.display   = "none";
    $("id_phase2").style.display   = "block";
    $("id_timerWrapper").style.display  = "none";
    $("id_expectWrapper").style.display = (userRole === "buyer") ? "block" : "none";
    stopMainTimer();
    showSellerProofIfAny(order);
    const paidAtMs      = tsToMillis(order.paymentConfirmedAt) || Date.now();
    const reminderUntil = paidAtMs + REMINDER_WINDOW_MS;
    if (userRole === "buyer") {
      $("id_orderStatusTitle").textContent = "في انتظار تأكيد البائع";
      setMainBtnText("", { hidden: true });
      showWaitingBtn(true); showCancelLink(false);
      startReminderTimer(reminderUntil);
    } else if (userRole === "seller") {
      $("id_orderStatusTitle").textContent = "تم استلام إشعار الدفع من المشتري";
      setMainBtnText("تم استلام الدفعة");
      showWaitingBtn(false); showCancelLink(false);
      stopReminderTimer();
    } else {
      setMainBtnText("غير مصرح", { disabled: true });
      showWaitingBtn(false); showCancelLink(false);
    }
  }

  // ══ renderPendingAdmin — المرآة الحقيقية ═══════════════════════════════════
  // يُستدعى في كل مرة يتغير فيها Firestore — حتى لو تغيّر حقل واحد فقط.
  //
  //  releaseTxPending = false (أو غير موجود):
  //    → شاشة التحميل العادية "الطلب قيد المعالجة"
  //
  //  releaseTxPending = true:
  //    → "المعاملة جارية على البلوكشين" + رابط Hash
  //    → يظهر للمشتري والبائع في نفس اللحظة التي يُرسل فيها الأدمن الـ tx
  // ══════════════════════════════════════════════════════════════════════════
  function renderPendingAdmin(order) {
    updateProgress(2);

    const onChain = !!order.releaseTxPending && !!order.adminReleaseTxHash;
    $("id_orderStatusTitle").textContent = onChain
      ? "المعاملة جارية على البلوكشين ⛓"
      : "الطلب قيد المعالجة";

    $("id_phase1").style.display        = "none";
    $("id_phase2").style.display        = "none";
    $("id_timerWrapper").style.display  = "none";
    $("id_expectWrapper").style.display = "none";
    setMainBtnText("", { hidden: true });
    showWaitingBtn(false);
    showCancelLink(false);
    stopMainTimer();
    stopReminderTimer();
    showCompleted(false);

    // أظهر صندوق التحميل وحدّث محتواه
    showProcessing(true);
    updateProcessingBox(order);
  }

  // ══ renderCompleted — علامة ✅ + رابط Hash للطرفين ════════════════════════
  function renderCompleted(order) {
    updateProgress(3);
    $("id_orderStatusTitle").textContent = "تم التحرير بنجاح ✅";
    $("id_phase1").style.display        = "none";
    $("id_phase2").style.display        = "none";
    $("id_timerWrapper").style.display  = "none";
    $("id_expectWrapper").style.display = "none";
    setMainBtnText("", { hidden: true });
    showWaitingBtn(false);
    showCancelLink(false);
    stopMainTimer();
    stopReminderTimer();
    showProcessing(false);
    showCompleted(true);

    // أضف رابط الـ Hash إلى صندوق النجاح
    updateCompletedBox(order);
  }

  function renderCanceled(order) {
    updateProgress(0);
    hideAllStateBoxes();
    const isExpired = order.cancelReason === "expired";
    $("id_orderStatusTitle").textContent = isExpired
      ? "انتهى الوقت — تم إلغاء الطلب تلقائياً"
      : "تم إلغاء الطلب";
    $("id_timerWrapper").style.display  = "none";
    $("id_expectWrapper").style.display = "none";
    setMainBtnText(isExpired ? "تم إلغاء الطلب لانتهاء الوقت" : "الطلب ملغي", {
      disabled: true,
      background: "rgba(255, 77, 79, 0.1)",
      color: "#FF4D4F",
    });
    showWaitingBtn(false);
    showCancelLink(false);
    stopMainTimer();
    stopReminderTimer();
  }

  // ---------- Buyer: Image Compression to Base64 ----------
  function compressImageToBase64(file, opts = {}) {
    const maxDim   = opts.maxDim   || 1280;
    const quality  = opts.quality  || 0.75;
    const maxBytes = opts.maxBytes || 700 * 1024;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("file_read_failed"));
      reader.onload  = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error("image_decode_failed"));
        img.onload  = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const r = Math.min(maxDim / width, maxDim / height);
            width  = Math.round(width  * r);
            height = Math.round(height * r);
          }
          const canvas = document.createElement("canvas");
          canvas.width  = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          let q = quality;
          let dataUrl = canvas.toDataURL("image/jpeg", q);
          while (dataUrl.length * 0.75 > maxBytes && q > 0.3) {
            q -= 0.1;
            dataUrl = canvas.toDataURL("image/jpeg", q);
          }
          if (dataUrl.length * 0.75 > maxBytes) return reject(new Error("image_too_large"));
          resolve(dataUrl);
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- Buyer: Upload Sheet ----------
  function bindUploadSheet() {
    const fileInput  = $("id_hiddenFileInput");
    const checkInput = $("id_confirmCheckInput");
    const submitBtn  = $("id_submitPaymentBtn");
    const placeholder = $("id_uploadPlaceholder");
    const countLabel  = $("id_imageCountLabel");
    const box         = $("id_boxTriggerUpload");
    function validate() {
      const ok = !!proofFile && checkInput.checked;
      submitBtn.disabled = !ok;
      submitBtn.classList.toggle("active", ok);
    }
    fileInput.onchange = (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      proofFile = f;
      countLabel.textContent = "1/3";
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (placeholder) placeholder.style.display = "none";
        let preview = box.querySelector("img.proof-thumb");
        if (!preview) {
          preview = document.createElement("img");
          preview.className = "proof-thumb";
          box.prepend(preview);
        }
        preview.src = ev.target.result;
      };
      reader.readAsDataURL(f);
      validate();
    };
    checkInput.onchange = validate;
    submitBtn.onclick = async () => {
      if (!proofFile) return showToast("الرجاء اختيار صورة الإثبات");
      if (lastOrder && (lastOrder.status === "canceled" || (Number(lastOrder.expiresAt) || 0) <= Date.now())) {
        return showToast("لا يمكن رفع الإثبات بعد انتهاء الوقت");
      }
      submitBtn.disabled = true;
      const original = submitBtn.textContent;
      submitBtn.textContent = "جارٍ المعالجة...";
      try {
        const base64Url = await compressImageToBase64(proofFile, { maxDim: 1280, quality: 0.75, maxBytes: 700 * 1024 });
        submitBtn.textContent = "جارٍ الحفظ...";
        await db.collection(ORDERS_COLLECTION).doc(orderId).update({
          proofImage:          base64Url,
          proofImageType:      "base64",
          paymentConfirmed:    true,
          paymentConfirmedAt:  firebase.firestore.FieldValue.serverTimestamp(),
        });
        $("id_uploadBottomSheet").classList.remove("show");
        $("id_mainOverlay").style.display = "none";
        showToast("تم تأكيد الدفع، في انتظار البائع");
      } catch (e) {
        console.error("[order-details] proof save failed", e);
        const msg = String(e?.message || "");
        const map = {
          image_too_large:    "الصورة كبيرة جداً حتى بعد الضغط. اختر صورة أخرى.",
          file_read_failed:   "تعذر قراءة الصورة، حاول مرة أخرى",
          image_decode_failed:"صيغة الصورة غير مدعومة",
        };
        showToast(map[msg] || `فشل الحفظ: ${msg || "خطأ غير معروف"}`);
        submitBtn.disabled    = false;
        submitBtn.textContent = original;
      }
    };
  }

  // ---------- Seller: Confirm Sheet (Escrow Flow) ----------
  function bindConfirmSheet() {
    window.selectOption = function (type) {
      confirmChoice = type;
      $("opt_received").classList.toggle("selected-green", type === "received");
      $("opt_not_received").classList.toggle("selected-red", type === "not_received");
      const finalBtn = $("id_confirmSelectionBtn");
      finalBtn.classList.toggle("active", type === "received");
      finalBtn.disabled = type !== "received";
    };
    $("id_confirmSelectionBtn").onclick = async () => {
      if (confirmChoice !== "received") return;
      const finalBtn = $("id_confirmSelectionBtn");
      finalBtn.disabled = true;
      const oldText = finalBtn.textContent;
      finalBtn.textContent = "جارٍ الإرسال...";
      try {
        await db.collection(ORDERS_COLLECTION).doc(orderId).update({
          status:            "pending_admin_release",
          sellerConfirmedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        $("confirmSheet").classList.remove("show");
        $("confirmOverlay").style.display = "none";
        showToast("تم إرسال الطلب للإدارة للمراجعة والتحرير");
      } catch (e) {
        console.error("[order-details] seller-confirm failed", e);
        showToast("فشل إرسال التأكيد، حاول مرة أخرى");
        finalBtn.disabled    = false;
        finalBtn.textContent = oldText;
      }
    };
  }

  // ---------- Cancel ----------
  function bindCancel() {
    const link = $("id_cancelOrderBtn");
    if (!link) return;
    link.onclick = async () => {
      if (!lastOrder) return;
      if (userRole !== "buyer") return showToast("لا يمكنك إلغاء هذا الطلب");
      if (lastOrder.paymentConfirmed) return showToast("لا يمكن الإلغاء بعد تأكيد الدفع");
      if (!confirm("هل أنت متأكد من إلغاء الطلب؟")) return;
      try {
        await restoreAdAvailableQty(lastOrder);
        await db.collection(ORDERS_COLLECTION).doc(orderId).update({
          status:      "canceled",
          canceledAt:  firebase.firestore.FieldValue.serverTimestamp(),
          cancelReason:"buyer_canceled",
        });
        showToast("تم إلغاء الطلب");
      } catch (e) {
        console.error("[order-details] cancel failed", e);
        showToast("فشل إلغاء الطلب");
      }
    };
  }

  // ---------- Main Button Click Router ----------
  function bindMainButton() {
    const btn = $("id_openUploadSheetBtn");
    if (!btn) return;
    btn.onclick = () => {
      if (!lastOrder) return;
      if (lastOrder.status === "canceled") return showToast("الطلب ملغي");
      if (userRole === "buyer" && !lastOrder.paymentConfirmed && lastOrder.status === "active") {
        $("id_uploadBottomSheet").classList.add("show");
        $("id_mainOverlay").style.display = "block";
        return;
      }
      if (userRole === "seller" && lastOrder.paymentConfirmed && !lastOrder.released && lastOrder.status === "active") {
        confirmChoice = null;
        $("opt_received").classList.remove("selected-green");
        $("opt_not_received").classList.remove("selected-red");
        $("id_confirmSelectionBtn").classList.remove("active");
        $("id_confirmSelectionBtn").disabled    = true;
        $("id_confirmSelectionBtn").textContent = "تأكيد";
        $("confirmSheet").classList.add("show");
        $("confirmOverlay").style.display = "block";
      }
    };
  }

  // ---------- Chat Icon ----------
  function bindChatToggle() {
    const btn = $("id_chatWithSellerBtn");
    if (!btn) return;
    btn.onclick = () => {
      if (!orderId) return;
      try { window.P2P?.toast?.("جاري فتح المحادثة..."); } catch (_) {}
      window.location.href = `index.html?chat=${encodeURIComponent(orderId)}`;
    };
  }

  window.addEventListener("pageshow", (event) => {
    document.body.classList.remove("chat-fullscreen", "chat-loading-from-url");
    document.body.style.pointerEvents = "";
    if (event.persisted) {
      console.log("[order-details] restored from bfcache — re-init");
      try { if (typeof unsubOrder === "function") unsubOrder(); } catch (_) {}
      try { init(); } catch (e) { console.warn("[order-details] re-init failed", e); }
    }
  });

  // ---------- Init ----------
  async function init() {
    const params = new URLSearchParams(location.search);
    orderId = params.get("orderId");
    if (!orderId) return showNotFound();
    currentAddress = await detectAddress();
    unsubOrder = db.collection(ORDERS_COLLECTION).doc(orderId).onSnapshot(
      (snap) => {
        if (!snap.exists) return showNotFound();
        const order = { id: snap.id, ...snap.data() };
        $("id_loadingScreen").style.display = "none";
        renderOrder(order);
      },
      (err) => {
        console.error("[order-details] order snapshot error", err);
        showNotFound();
      }
    );
    bindMainButton();
    bindUploadSheet();
    bindConfirmSheet();
    bindCancel();
    bindChatToggle();
  }

  function showNotFound() {
    $("id_loadingScreen").style.display = "none";
    const nf = $("id_notFoundScreen");
    if (nf) nf.style.display = "flex";
  }

  document.addEventListener("DOMContentLoaded", init);
  window.addEventListener("beforeunload", () => {
    if (typeof unsubOrder === "function") unsubOrder();
    stopMainTimer();
    stopReminderTimer();
  });
})();
