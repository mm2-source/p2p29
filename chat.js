/* eslint-disable no-console */

// ------------------------------------------------------------
// chat.js — Modern Conversation View
// ------------------------------------------------------------
// - Real-time messages via Firebase RTDB
// - System messages injected from order document state
// - Action bar follows order status (buyer / seller flow)
// - Last-seen presence via users/{addr}.lastSeen
// - SPA FIX: fullscreen mode hides topbar/bottomNav when chat open
// - SPA FIX: handles ?chat=<orderId> URL param to auto-open chat
// - PUSH: in-app + browser notifications for new messages (silent + safe)
// - BADGE: unread messages counter on chat icon in bottom-nav
// ------------------------------------------------------------

(function () {
  window.P2P = window.P2P || {};
  window.P2P.chat = window.P2P.chat || {};
  window.P2P.state = window.P2P.state || {};

  // ⚠️ مهم: لا تخزن db/rtdb/storage في متغيرات محلية!
  //    خذها من window في وقت التشغيل عشان تتجنب race condition
  //    لو firebase-config.js اتحمّل بعد chat.js لأي سبب.
  const getDb = () => window.db;
  const getRtdb = () => window.rtdb;
  const getStorage = () => window.storage;

  let activeOrderId = null;
  let activeOrder = null;
  let activeMsgs = [];

  let unsubChatMsgs = null;
  let unsubOrderDoc = null;
  let unsubChatList = null;
  let unsubAllChatsForBadge = null;
  let unsubPeerSeen = null;     // ✅ READ-RECEIPTS: اشتراك live لقراءة الطرف التاني
  let unsubPeerTyping = null;   // ✅ TYPING: اشتراك live لمؤشر كتابة الطرف التاني
  let actionTimerInt = null;
  let lastSeenInt = null;
  let pendingFile = null;
  let peerSeenMs = 0;           // ✅ READ-RECEIPTS: آخر مرة الطرف التاني فتح الشات الحالي
  let peerTypingMs = 0;         // ✅ TYPING: آخر مرة الطرف التاني بعت "بيكتب"
  let peerLastSeenText = "";    // ✅ TYPING: نص آخر ظهور — نخزّنه عشان نرجّعه لما الكتابة تخلص
  let myTypingLastWriteMs = 0;  // ✅ TYPING: throttle لكتاباتي للـ RTDB
  let myTypingClearTimer = null;// ✅ TYPING: تايمر لمسح حالتي بعد توقفي عن الكتابة
  let typingDisplayTimer = null;// ✅ TYPING: تايمر لإخفاء المؤشر لما ينتهي وقته
  const TYPING_WRITE_THROTTLE_MS = 1500;  // أكتب للـ RTDB مرة كل 1.5 ث
  const TYPING_AUTO_CLEAR_MS    = 3000;   // امسح حالتي بعد 3 ث من آخر ضغطة زرار
  const TYPING_DISPLAY_WINDOW_MS = 4500;  // اعتبر الطرف التاني بيكتب لو الإشارة جت آخر 4.5 ث

  const userNamesCache = {};
  // PUSH: state per-order (آخر رسالة شفناها لكل شات + هل المستخدم هيرفض الإشعارات)
  const lastSeenMsgTime = {}; // { orderId: timestampMs }
  let notifPermissionAsked = false;
  let pushReady = false;

  // ---------------- Helpers ----------------
  const $ = (id) => document.getElementById(id);
  const fmt2 = (n) => { const v = Number(n); return Number.isFinite(v) ? v.toFixed(2) : "0.00"; };
  const shortId4 = (id) => (id ? "xx" + String(id).slice(-4) : "xxxxxx");
  const escapeHtml = (s) =>
    String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  function fmtMMSS(ms) {
    if (ms <= 0) return "00:00";
    const t = Math.floor(ms / 1000);
    const m = Math.floor(t / 60), s = t % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    if (ts.toMillis) return ts.toMillis();
    if (ts.seconds) return ts.seconds * 1000;
    return 0;
  }
  function fmtTime(ts) {
    let d;
    if (typeof ts === "number") d = new Date(ts);
    else if (ts?.toDate) d = ts.toDate();
    else if (ts?.seconds) d = new Date(ts.seconds * 1000);
    else d = new Date();
    const pad = (n) => (n < 10 ? "0" + n : n);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtRelativeArabic(ms) {
    if (!ms) return "آخر ظهور منذ فترة";
    const diff = Date.now() - ms;
    if (diff < 60 * 1000) return "متصل الآن";
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `آخر ظهور منذ ${mins} دقيقة مضت`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `آخر ظهور منذ ${hrs} ساعة مضت`;
    const days = Math.floor(hrs / 24);
    return `آخر ظهور منذ ${days} يوم مضت`;
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
      const f = "Trader_" + addr.slice(-4);
      userNamesCache[addr] = f;
      return f;
    }
  }

  function counterpartyAddr(o, myAddr) {
    const me = String(myAddr || "").toLowerCase();
    if (String(o.buyerAddress || "").toLowerCase() === me) return o.sellerAddress;
    if (String(o.sellerAddress || "").toLowerCase() === me) return o.buyerAddress;
    return o.merchantAddress;
  }
  function determineRole(o, myAddr) {
    const me = String(myAddr || "").toLowerCase();
    if (String(o.buyerAddress || "").toLowerCase() === me) return "buyer";
    if (String(o.sellerAddress || "").toLowerCase() === me) return "seller";
    return "viewer";
  }

  // ---------------- Read Receipts (Binance-style) ----------------
  // ✅ مسار جديد في RTDB: chat-seen/{orderId}/{addr} = timestampMs
  //    - أنا بحدّث قيمتي كل ما أفتح الشات أو ييجي رسالة جديدة وأنا فيه
  //    - بشترك live على قيمة الطرف التاني عشان أعرف هل شاف رسالتي ولا لأ
  //    - الرسالة "مقروءة" لو peerSeenMs >= msg.time
  //    - مش بنلمس مسار الرسائل chats/{orderId} نهائياً (المسار منفصل تماماً)
  function updateMyReadStatus(orderId) {
    const rtdb = getRtdb();
    const me = window.P2P.state.connectedAddress;
    if (!rtdb || !me || !orderId) return;
    try {
      rtdb.ref(`chat-seen/${orderId}/${String(me).toLowerCase()}`).set(Date.now());
    } catch (_) { /* silent */ }
  }

  function subscribePeerReadStatus(orderId) {
    const rtdb = getRtdb();
    if (!rtdb || !orderId || !activeOrder) return;
    const me = window.P2P.state.connectedAddress;
    const peer = counterpartyAddr(activeOrder, me);
    if (!peer) return;

    // امسح اشتراك قديم
    try { if (typeof unsubPeerSeen === "function") unsubPeerSeen(); } catch (_) {}
    unsubPeerSeen = null;

    const ref = rtdb.ref(`chat-seen/${orderId}/${String(peer).toLowerCase()}`);
    const handler = (snap) => {
      const v = Number(snap.val()) || 0;
      if (v !== peerSeenMs) {
        peerSeenMs = v;
        renderConversation(); // ري-ريندر عشان الدوايل تتحول لصح
      }
    };
    ref.on("value", handler);
    unsubPeerSeen = () => { try { ref.off("value", handler); } catch (_) {} };
  }

  // ---------------- Typing Indicator (يكتب الآن…) ----------------
  // ✅ مسار جديد في RTDB: chat-typing/{orderId}/{addr} = timestampMs (آخر ضغطة زرار)
  //    - بنكتب قيمتي مع throttle 1.5ث (مش بنرهق RTDB)
  //    - بنمسح قيمتي تلقائياً بعد 3ث من آخر كتابة، أو فوراً عند الإرسال/الـ blur/الإغلاق
  //    - بنشترك live على قيمة الطرف التاني
  //    - الطرف التاني يعتبر "بيكتب" لو الإشارة جت آخر 4.5ث (نافذة عرض)
  //    - مفيش مساس نهائي بمسار الرسائل chats/{orderId}
  function isPeerTypingNow() {
    return peerTypingMs > 0 && (Date.now() - peerTypingMs) < TYPING_DISPLAY_WINDOW_MS;
  }

  function setMyTypingState(isTyping) {
    const rtdb = getRtdb();
    const me = window.P2P.state.connectedAddress;
    if (!rtdb || !me || !activeOrderId) return;
    const ref = rtdb.ref(`chat-typing/${activeOrderId}/${String(me).toLowerCase()}`);
    if (isTyping) {
      const now = Date.now();
      // throttle: ميكتبش للـ RTDB كل ضغطة زرار، بس كل 1.5 ث
      if (now - myTypingLastWriteMs >= TYPING_WRITE_THROTTLE_MS) {
        try { ref.set(now); } catch (_) {}
        myTypingLastWriteMs = now;
      }
      // schedule: امسح حالتي تلقائياً لو وقفت كتابة 3 ث
      if (myTypingClearTimer) clearTimeout(myTypingClearTimer);
      myTypingClearTimer = setTimeout(() => setMyTypingState(false), TYPING_AUTO_CLEAR_MS);
    } else {
      try { ref.set(0); } catch (_) {}
      myTypingLastWriteMs = 0;
      if (myTypingClearTimer) { clearTimeout(myTypingClearTimer); myTypingClearTimer = null; }
    }
  }

  function subscribePeerTyping(orderId) {
    const rtdb = getRtdb();
    if (!rtdb || !orderId || !activeOrder) return;
    const me = window.P2P.state.connectedAddress;
    const peer = counterpartyAddr(activeOrder, me);
    if (!peer) return;

    try { if (typeof unsubPeerTyping === "function") unsubPeerTyping(); } catch (_) {}
    unsubPeerTyping = null;

    const ref = rtdb.ref(`chat-typing/${orderId}/${String(peer).toLowerCase()}`);
    const handler = (snap) => {
      peerTypingMs = Number(snap.val()) || 0;
      updateTypingDisplay();
    };
    ref.on("value", handler);
    unsubPeerTyping = () => { try { ref.off("value", handler); } catch (_) {} };
  }

  function updateTypingDisplay() {
    const lsEl = $("chatConvLastSeen");
    if (!lsEl) return;

    if (typingDisplayTimer) { clearTimeout(typingDisplayTimer); typingDisplayTimer = null; }

    if (isPeerTypingNow()) {
      // اعرض المؤشر بشكل سلس
      lsEl.innerHTML =
        '<span class="typingIndicator">' +
          'يكتب الآن' +
          '<span class="typingDots"><span></span><span></span><span></span></span>' +
        '</span>';
      // إخفاء تلقائي لما تخلص نافذة العرض (لو ما جت إشارة جديدة)
      const remain = TYPING_DISPLAY_WINDOW_MS - (Date.now() - peerTypingMs);
      typingDisplayTimer = setTimeout(updateTypingDisplay, Math.max(remain + 100, 200));
    } else {
      // ارجع لنص آخر ظهور المخزّن
      lsEl.textContent = peerLastSeenText || "آخر ظهور منذ فترة";
    }
  }

  // ---------------- Last-seen presence ----------------
  function startLastSeenHeartbeat() {
    if (lastSeenInt) clearInterval(lastSeenInt);
    const tick = async () => {
      const db = getDb();
      const me = window.P2P.state.connectedAddress;
      if (!me || !db) return;
      try {
        await db.collection("users").doc(me).set(
          { lastSeen: firebase.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
      } catch (e) { /* silent */ }
    };
    tick();
    lastSeenInt = setInterval(tick, 60 * 1000);
  }

  // ---------------- Open / Close Conversation ----------------
  // ✅ DEFENSIVE: لا يعتمد على navTo، يضبط الصفحة يدوياً + يتحمّل غياب db مؤقتاً
  // ✅ FIX #4: cleanup كامل لأي listeners قديمة قبل ما نفتح شات جديد،
  //     + التحقق من جاهزية الـ DOM (chatPage + chatConvWrap) قبل التفعيل،
  //     عشان ما يحصلش "صفحة بيضاء" لما المستخدم يدخل ويخرج بسرعة.
  let openChatBusy = false; // يمنع double-call متزامن

  function cleanupActiveChat() {
    // قفل أي listeners قديمة سواء على رسائل أو على وثيقة الطلب
    try { if (typeof unsubChatMsgs === "function") unsubChatMsgs(); } catch (_) {}
    try { if (typeof unsubOrderDoc === "function") unsubOrderDoc(); } catch (_) {}
    try { if (typeof unsubPeerSeen === "function") unsubPeerSeen(); } catch (_) {} // ✅ READ-RECEIPTS
    try { if (typeof unsubPeerTyping === "function") unsubPeerTyping(); } catch (_) {} // ✅ TYPING
    // ✅ TYPING: امسح حالة الكتابة بتاعتي عشان الطرف التاني ما يفضلش شايف "بيكتب" بعد ما خرجت
    try { setMyTypingState(false); } catch (_) {}
    if (actionTimerInt) { try { clearInterval(actionTimerInt); } catch (_) {} }
    if (typingDisplayTimer) { try { clearTimeout(typingDisplayTimer); } catch (_) {} }
    if (myTypingClearTimer) { try { clearTimeout(myTypingClearTimer); } catch (_) {} }
    unsubChatMsgs = null;
    unsubOrderDoc = null;
    unsubPeerSeen = null;
    unsubPeerTyping = null;
    actionTimerInt = null;
    typingDisplayTimer = null;
    myTypingClearTimer = null;
    activeOrder = null;
    activeMsgs = [];
    peerSeenMs = 0;       // ✅ READ-RECEIPTS: ريسيت
    peerTypingMs = 0;     // ✅ TYPING: ريسيت
    peerLastSeenText = ""; // ✅ TYPING: ريسيت الكاش
    myTypingLastWriteMs = 0;
    // ⭐ امسح reply state + long-press menu لو مفتوح
    try { _clearReplyTo(); } catch (_) {}
    try { _closeLpMenu(); } catch (_) {}
    if (_lpTimer) { try { clearTimeout(_lpTimer); } catch (_) {} _lpTimer = null; }
    _lpTargetMsg = null;
    _lpStartXY = null;
    // فضي محتوى الـ body عشان ما يبانش رسائل من شات قديم
    const body = $("chatConvBody");
    if (body) body.innerHTML = "";
  }

  async function openChat(orderId) {
    if (!orderId) {
      console.warn("[chat] openChat called without orderId");
      return;
    }
    if (openChatBusy) {
      console.warn("[chat] openChat already in progress, ignoring duplicate call");
      return;
    }
    openChatBusy = true;
    console.log("[chat] openChat:", orderId);

    // ✅ FIX #4: نظّف أي listeners + state من شات سابق قبل أي حاجة
    cleanupActiveChat();
    activeOrderId = orderId;

    // ✅ FIX (back to chat-list): احفظ مكان المستخدم قبل ما نفتح الشات
    //    عشان الـ close يرجّعه للحالة الأصلية بدل ما يفترض orders دائماً.
    //    لو chatPage كان فعلاً page--active يبقى المستخدم جاي من Chat List.
    try {
      const cpEl = document.getElementById("chatPage");
      const fromUrl = document.body.classList.contains("chat-loading-from-url");
      if (fromUrl) {
        window._p2pChatSource = "url";
      } else if (cpEl && cpEl.classList.contains("page--active")) {
        window._p2pChatSource = "chatList";
      } else {
        window._p2pChatSource = "other";
      }
    } catch (_) { window._p2pChatSource = "other"; }

    // 1. تفعيل وضع Fullscreen — يخفي الـ Topbar والـ BottomNav
    document.body.classList.add("chat-fullscreen");
    document.documentElement.classList.add("chat-fullscreen-html");
    // ✅ احفظ scroll position الحالي (عشان نرجعه عند الإغلاق)
    document.body.dataset.savedScroll = String(window.scrollY || 0);

    // ⭐ MANUAL FIX 1: قفل meta viewport (يمنع الزوم التلقائي اللي بيطير الهيدر)
    _lockMetaViewport();

    // ✅ KEYBOARD FIX (Visual Viewport API):
    //    لما الكيبورد يفتح، الـ visualViewport.height بينقص بحجم الكيبورد.
    //    نحدّث CSS variables عشان:
    //      --p2p-vh   = الارتفاع الفعلي للـ viewport (بدلاً من 100dvh المتذبذب)
    //      --p2p-kb-h = ارتفاع الكيبورد نفسه (الفوتر يرتفع بمقداره)
    //    كده الهيدر يفضل ثابت فوق + الفوتر يطلع مع الكيبورد + الرسائل بس اللي بتـ resize.
    setupVisualViewportFix();

    // 2. ✅ ضبط الصفحات يدوياً (لا نعتمد على navTo فقط)
    const pageIds = ["marketPage", "createAdPage", "ordersPage", "adsPage", "chatPage", "profilePage"];
    pageIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("page--active", id === "chatPage");
    });

    // 3. تحديث الـ bottom-nav active item (chat = idx 3)
    document.querySelectorAll(".bottomNav__item").forEach((el, i) => {
      el.classList.toggle("bottomNav__item--active", i === 3);
    });

    // 4. حدّث الـ header (لو navTo موجود استخدمه عشان consistency)
    if (typeof window.navTo === "function") {
      try { window.navTo("chat"); } catch (e) { console.warn("[chat] navTo failed (ignored):", e); }
    }

    // 5. ✅ FIX #4: استنى الـ DOM يبقى جاهز فعلاً قبل ما نوري الـ conv
    //    (ممكن chatPage اتعمله render لسه أو تأخر بسبب navTo)
    let chatPageEl = null, listWrap = null, convWrap = null;
    let domTries = 0;
    while (domTries < 30) {
      chatPageEl = document.getElementById("chatPage");
      listWrap   = $("chatListWrap");
      convWrap   = $("chatConvWrap");
      if (chatPageEl && convWrap && chatPageEl.classList.contains("page--active")) break;
      // لو الـ active class اتشال لأي سبب، رجّعه
      if (chatPageEl && !chatPageEl.classList.contains("page--active")) {
        chatPageEl.classList.add("page--active");
      }
      await new Promise((r) => setTimeout(r, 50));
      domTries++;
    }
    if (!convWrap) {
      console.error("[chat] #chatConvWrap not found in DOM after waiting!");
      openChatBusy = false;
      return;
    }
    if (listWrap) listWrap.style.display = "none";
    convWrap.style.display = "flex";

    // 6. اشترك في وثيقة الطلب (يستنى db لو لسه ما جاهزتش)
    let db = getDb();
    let waitTries = 0;
    while (!db && waitTries < 30) {
      await new Promise((r) => setTimeout(r, 100));
      db = getDb();
      waitTries++;
    }
    if (!db) {
      console.error("[chat] Firebase not initialized — cannot open chat");
      window.P2P.toast?.("تعذر فتح المحادثة (Firebase غير جاهز)");
      openChatBusy = false;
      return;
    }

    // ✅ FIX #4: لو المستخدم بدّل لشات تاني خلال الانتظار، ما تكملش بالقديم
    if (activeOrderId !== orderId) {
      console.warn("[chat] order switched during init, aborting old open");
      openChatBusy = false;
      return;
    }

    // double-cleanup للأمان (في حالة سباق)
    if (typeof unsubOrderDoc === "function") { try { unsubOrderDoc(); } catch (_) {} }
    unsubOrderDoc = db.collection("Orders").doc(orderId).onSnapshot(
      (snap) => {
        if (!snap.exists) {
          window.P2P.toast?.("الطلب غير موجود");
          closeChatConversation();
          return;
        }
        // متاسبتش رسائل لشات تاني
        if (activeOrderId !== orderId) return;
        activeOrder = { id: snap.id, ...snap.data() };
        renderHeaderAndAction();
        renderConversation();
        // ✅ READ-RECEIPTS: لو لسه ما اشتركناش (لأن activeOrder ماكنش جاهز)، اشترك دلوقتي
        if (!unsubPeerSeen) subscribePeerReadStatus(orderId);
        // ✅ TYPING: نفس الفكرة لاشتراك حالة الكتابة
        if (!unsubPeerTyping) subscribePeerTyping(orderId);
      },
      (err) => console.error("[chat] order snapshot error", err)
    );

    startLastSeenHeartbeat();
    subscribeMessages(orderId);

    // ✅ READ-RECEIPTS: علّم نفسي إن أنا فاتح الشات دلوقتي + اشترك live في قراءة الطرف التاني
    updateMyReadStatus(orderId);
    // اشتراك peer-seen محتاج activeOrder موجود — order doc onSnapshot هيستدعيه برضه
    // لكن نجرب فوراً لو الـ activeOrder اتسحب بسرعة من الـ cache
    subscribePeerReadStatus(orderId);
    // ✅ TYPING: اشترك live في حالة كتابة الطرف التاني (نفس المنطق)
    subscribePeerTyping(orderId);

    // PUSH: علّم آخر رسالة هنا كـ "مقروءة" (مش هنبعت إشعار للرسائل القديمة)
    lastSeenMsgTime[orderId] = Date.now();

    // ✅ FIX (hardware back): ضيف history entry للشات بحيث الـ back
    //    يفعّل popstate ويقفل الشات بدل ما يخرج المستخدم من الموقع.
    try {
      const cur = window.history.state;
      if (!cur || !cur.p2pChat) {
        window.history.pushState({ p2pChat: orderId }, "", window.location.href);
      }
    } catch (_) {}

    openChatBusy = false;
  }

  // ✅ FIX (no blank page): دالة واحدة موحدة للتنظيف + الـ navigation.
  //    بتتنده من 3 أماكن (close button، popstate، إغلاق آمن) بنفس السلوك،
  //    عشان ما يحصلش inconsistency بين السيناريوهات ولا "صفحة بيضاء" بعد الرجوع.
  function _doFullChatCleanup() {
    // 1) Unsubscribe كل listeners + clear timers + state
    try { if (typeof unsubChatMsgs === "function") unsubChatMsgs(); } catch (_) {}
    try { if (typeof unsubOrderDoc === "function") unsubOrderDoc(); } catch (_) {}
    try { if (typeof unsubPeerSeen === "function") unsubPeerSeen(); } catch (_) {} // ✅ READ-RECEIPTS
    try { if (typeof unsubPeerTyping === "function") unsubPeerTyping(); } catch (_) {} // ✅ TYPING
    // ✅ TYPING: امسح حالتي قبل ما الـ activeOrderId يـ null عشان الـ ref يبقى صحيح
    try { setMyTypingState(false); } catch (_) {}
    if (actionTimerInt) clearInterval(actionTimerInt);
    if (typingDisplayTimer) clearTimeout(typingDisplayTimer);
    if (myTypingClearTimer) clearTimeout(myTypingClearTimer);
    unsubChatMsgs = unsubOrderDoc = unsubPeerSeen = unsubPeerTyping = null;
    actionTimerInt = null;
    typingDisplayTimer = null;
    myTypingClearTimer = null;
    peerSeenMs = 0;
    peerTypingMs = 0;
    peerLastSeenText = "";
    myTypingLastWriteMs = 0;
    // ⭐ امسح reply state + long-press menu
    try { _clearReplyTo(); } catch (_) {}
    try { _closeLpMenu(); } catch (_) {}
    if (_lpTimer) { try { clearTimeout(_lpTimer); } catch (_) {} _lpTimer = null; }
    _lpTargetMsg = null;
    _lpStartXY = null;

    // PUSH: علّم رسائل الشات الحالي كمقروءة
    if (activeOrderId) lastSeenMsgTime[activeOrderId] = Date.now();
    activeOrderId = null;
    activeOrder = null;
    activeMsgs = [];

    // ✅ KEYBOARD FIX: شيل الـ Visual Viewport listener + امسح الـ CSS vars
    teardownVisualViewportFix();

    // 2) شيل كل الـ body classes اللي ممكن تحجب الـ pointer-events أو تخفي صفحات
    document.body.classList.remove("chat-fullscreen", "chat-loading-from-url", "chat-input-focused");
    document.documentElement.classList.remove("chat-fullscreen-html");
    // ⭐ MANUAL FIX: ارجع meta viewport الأصلي
    _restoreMetaViewport();
    // ✅ ارجع scroll position المحفوظة
    try {
      const saved = parseInt(document.body.dataset.savedScroll || "0", 10);
      if (saved > 0) window.scrollTo(0, saved);
      delete document.body.dataset.savedScroll;
    } catch (_) {}
    document.body.style.pointerEvents = "";
    document.body.style.overflow = ""; // لو حصل lock على overflow

    // 3) خبّي محادثة الشات + رجّع قائمة الدردشات عرض افتراضي
    const listWrap = $("chatListWrap");
    const convWrap = $("chatConvWrap");
    if (convWrap) convWrap.style.display = "none";
    if (listWrap) listWrap.style.display = "block";

    // 4) Navigation: ارجع للحالة الأصلية حسب السورس المسجّل في openChat
    const src = window._p2pChatSource;
    window._p2pChatSource = null;
    const cp = document.getElementById("chatPage");
    if (cp) cp.style.display = ""; // امسح أي inline display

    if (src === "chatList") {
      // المستخدم كان في قائمة الدردشات → خلي chatPage page--active مع listWrap
      if (cp) cp.classList.add("page--active");
      // خبّي باقي الـ pages
      ["marketPage", "createAdPage", "ordersPage", "adsPage", "profilePage"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.remove("page--active");
      });
      // bottom-nav: علّم Chat (idx 3) active
      document.querySelectorAll(".bottomNav__item").forEach((el, i) => {
        el.classList.toggle("bottomNav__item--active", i === 3);
      });
      return;
    }

    // أي سورس تاني (URL ?chat=، order-details، unknown) → روح لصفحة الطلبات
    if (cp) cp.classList.remove("page--active");
    if (typeof window.navTo === "function") {
      try { window.navTo("orders"); } catch (_) {}
    } else if (cp) {
      // fallback لو navTo مش موجود
      const op = document.getElementById("ordersPage");
      if (op) op.classList.add("page--active");
    }
  }

  function closeChatConversation() {
    // لو فيه history entry للشات (من openChat pushState)، اعمل history.back
    // — popstate handler هيـ trigger الـ cleanup. ده بيضمن إن الـ history
    // نظيف ولو ضغط forward بعدين مش هيرجع للشات.
    try {
      if (window.history.state && window.history.state.p2pChat) {
        // علّم flag إن الـ close جوّاني عشان popstate يعرف ينظف
        window._p2pChatClosing = true;
        window.history.back();
        return;
      }
    } catch (_) {}
    // مفيش history entry → cleanup مباشرة
    _doFullChatCleanup();
  }

  // ✅ FIX (hardware back): popstate يـ fire لما المتصفح يـ pop entry
  //    (سواء من زر back في الـ device، أو من history.back جوّا close button).
  //    لو الشات لسه fullscreen، نظف بالـ helper الموحّد.
  window.addEventListener("popstate", () => {
    try {
      const wasClosing = window._p2pChatClosing === true;
      window._p2pChatClosing = false;
      if (wasClosing || document.body.classList.contains("chat-fullscreen")) {
        _doFullChatCleanup();
      }
    } catch (err) { console.warn("[chat] popstate cleanup failed", err); }
  });

  // ✅ زرار الإرسال يفضل خافت لما الـ input فاضي + إشارة typing للطرف التاني
  //    ⭐ مفيش dependency على focus/blur خلاص — الـ rAF loop بيتولّى الفوتر
  //    والـ blur في Android غير موثوق (ميـ fire إلاش في حالات معينة).
  function wireSendBtnLiveness() {
    const inp = document.getElementById("chatInputText");
    const btn = document.getElementById("chatSendBtn");
    if (!inp || !btn || btn._p2pWired) return;
    btn._p2pWired = true;
    const upd = () => {
      const has = (inp.value || "").trim().length > 0;
      btn.classList.toggle("is-active", has);
      // ✅ TYPING: ابعت إشارة "بيكتب" للطرف التاني لو فيه نص — لو فاضي امسحها
      if (has) setMyTypingState(true);
      else setMyTypingState(false);
    };
    inp.addEventListener("input", upd);
    inp.addEventListener("change", upd);
    // ⭐ scroll للرسائل لتحت بمجرد ما الـ user يضغط على الـ input — مفيش
    //    scrollIntoView على الـ input نفسه (يـ break الـ layout في Android).
    //    الـ rAF loop بيخلّي الفوتر فوق الكيبورد دايماً.
    inp.addEventListener("focus", () => {
      const body = document.querySelector(".chatConv__body");
      if (body) {
        // 3 محاولات صغيرة عشان الكيبورد لما تخلص فتح، الرسالة الأخيرة تبان
        requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
        setTimeout(() => { body.scrollTop = body.scrollHeight; }, 200);
        setTimeout(() => { body.scrollTop = body.scrollHeight; }, 500);
      }
    }, { passive: true });
    upd();
  }

  // ⭐ MANUAL FIX 1: قفل meta viewport — يمنع الزوم التلقائي اللي بيطير الهيدر
  //                 ويغرّق الفوتر في بعض المتصفحات
  function _lockMetaViewport() {
    let m = document.querySelector('meta[name="viewport"]');
    if (!m) {
      m = document.createElement("meta");
      m.name = "viewport";
      document.head.appendChild(m);
    }
    if (!m.dataset.p2pSaved) m.dataset.p2pSaved = m.content || "";
    m.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
  }
  function _restoreMetaViewport() {
    const m = document.querySelector('meta[name="viewport"]');
    if (!m || !m.dataset.p2pSaved) return;
    m.content = m.dataset.p2pSaved;
    delete m.dataset.p2pSaved;
  }
  // اربط الـ liveness مرة واحدة بعد ما الـ DOM جاهز
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireSendBtnLiveness);
  } else {
    wireSendBtnLiveness();
  }
  // ولو الشات اتفتح ديناميكياً، اضمن إنه متّصل
  const _origOpenChat = openChat;
  openChat = async function(orderId) {
    const r = await _origOpenChat(orderId);
    setTimeout(wireSendBtnLiveness, 50);
    return r;
  };

  // ---------------- Header + Action Bar ----------------
  async function renderHeaderAndAction() {
    if (!activeOrder) return;
    const db = getDb();
    const me = window.P2P.state.connectedAddress;
    const role = determineRole(activeOrder, me);
    const peer = counterpartyAddr(activeOrder, me);

    // Name
    const nameEl = $("chatConvName");
    if (nameEl) nameEl.textContent = await getDisplayName(peer);

    // Last-seen — ✅ TYPING: نخزّن النص في cache، وما نكتبهوش لو الطرف التاني بيكتب الآن
    if (peer && db) {
      try {
        const peerDoc = await db.collection("users").doc(peer).get();
        const lastSeen = tsToMs(peerDoc.data()?.lastSeen);
        peerLastSeenText = fmtRelativeArabic(lastSeen);
      } catch {
        peerLastSeenText = "آخر ظهور منذ فترة";
      }
      const lsEl = $("chatConvLastSeen");
      if (lsEl && !isPeerTypingNow()) lsEl.textContent = peerLastSeenText;
    }

    // Action title
    const actionLabel = role === "buyer" ? "شراء USDT" : (role === "seller" ? "بيع USDT" : "USDT");
    const titleEl = $("chatActionTitle");
    if (titleEl) titleEl.textContent = `${actionLabel} مقابل ${fmt2(activeOrder.amount)} EGP`;

    // Action timer
    const expiresAt = Number(activeOrder.expiresAt) || 0;
    if (actionTimerInt) clearInterval(actionTimerInt);
    const timerRow = $("chatActionTimerRow");
    const timerVal = $("chatActionTimer");
    if (activeOrder.status === "active" && !activeOrder.paymentConfirmed && expiresAt > 0) {
      const tick = () => { if (timerVal) timerVal.textContent = fmtMMSS(expiresAt - Date.now()); };
      tick();
      actionTimerInt = setInterval(tick, 1000);
      if (timerRow) timerRow.style.display = "flex";
    } else {
      if (timerRow) timerRow.style.display = "none";
    }

    // Action button state machine
    const btn = $("chatActionBtn");
    if (!btn) return;
    const setDisabled = (disabled) => {
      btn.disabled = disabled;
      btn.style.opacity = disabled ? "0.55" : "1";
      btn.style.cursor = disabled ? "not-allowed" : "pointer";
    };

    if (activeOrder.status === "completed") {
      btn.textContent = "تم تحرير العملات";
      setDisabled(true);
    } else if (activeOrder.status === "pending_admin_release") {
      btn.textContent = "قيد المعالجة";
      setDisabled(true);
    } else if (activeOrder.status === "canceled") {
      btn.textContent = "ملغي";
      setDisabled(true);
    } else if (role === "buyer") {
      if (!activeOrder.paymentConfirmed) {
        btn.textContent = "قم بتحميل الدليل";
        setDisabled(false);
      } else {
        btn.textContent = "انتظر البائع";
        setDisabled(true);
      }
    } else if (role === "seller") {
      if (activeOrder.paymentConfirmed) {
        btn.textContent = "تأكيد الاستلام";
        setDisabled(false);
      } else {
        btn.textContent = "في انتظار الدفع";
        setDisabled(true);
      }
    } else {
      btn.textContent = "—";
      setDisabled(true);
    }
  }

  function onChatActionClick() {
    if (!activeOrderId || !activeOrder) return;
    if (["completed", "canceled", "pending_admin_release"].includes(activeOrder.status)) return;
    window.location.href = `order-details.html?orderId=${encodeURIComponent(activeOrderId)}`;
  }

  // ---------------- Messages ----------------
  function subscribeMessages(orderId) {
    const rtdb = getRtdb();
    if (typeof unsubChatMsgs === "function") unsubChatMsgs();
    if (!rtdb) {
      console.warn("[chat] RTDB not ready — cannot subscribe to messages");
      return;
    }
    const ref = rtdb.ref(`chats/${orderId}`);
    const handler = (snap) => {
      const raw = snap.val();
      activeMsgs = raw ? Object.values(raw) : [];
      renderConversation();
      // علّم آخر رسالة كـ "مقروءة" لأنا فاتحين الشات حالياً
      const last = activeMsgs[activeMsgs.length - 1];
      if (last) lastSeenMsgTime[orderId] = Math.max(lastSeenMsgTime[orderId] || 0, last.time || 0);
      // ✅ READ-RECEIPTS: حدّث قراءتي عشان الطرف التاني يشوف رسالته اتقرت
      updateMyReadStatus(orderId);
    };
    ref.on("value", handler);
    unsubChatMsgs = () => ref.off("value", handler);
  }

  function buildSystemMessages(o, role) {
    const sys = [];
    const sid = shortId4(o.id);
    const createdMs = tsToMs(o.createdAt || o.timestamp) || Date.now();

    if (role === "buyer") {
      sys.push({
        time: createdMs, type: "system",
        text: `تم إنشاء الطلب (${sid}). يُرجى إكمال الدفع.`,
        linkText: "عرض تفاصيل الدفع >", linkAction: "details",
      });
    } else if (role === "seller") {
      sys.push({
        time: createdMs, type: "system",
        text: `تم إنشاء الطلب (${sid}) وهو في انتظار دفع الطرف المقابل.`,
        linkText: "عرض الطلب >", linkAction: "details",
      });
    }

    if (o.status === "completed") {
      const releasedMs = tsToMs(o.releasedAt) || Date.now();
      if (role === "buyer") {
        sys.push({
          time: releasedMs, type: "system",
          text: `قام الطرف المقابل بتحرير العملات المشفرة، تم الآن إكمال الطلب (${sid}).`,
          linkText: "عرض الأصول >", linkAction: "assets",
        });
      } else if (role === "seller") {
        sys.push({
          time: releasedMs, type: "system",
          text: `لقد حررت العملة المشفرة، اكتمل الطلب (${sid}) الآن.`,
          linkText: "عرض التفاصيل >", linkAction: "details",
        });
      }
    }
    return sys;
  }

  function renderConversation() {
    if (!activeOrder) return;
    const body = $("chatConvBody");
    if (!body) return;
    const me = window.P2P.state.connectedAddress;
    const role = determineRole(activeOrder, me);

    const userMsgs = (activeMsgs || []).map((m) => ({
      time: m.time || 0, type: "user",
      sender: m.sender, text: m.text || "", imageUrl: m.imageUrl || null,
    }));

    const sysMsgs = buildSystemMessages(activeOrder, role);
    const all = [...sysMsgs, ...userMsgs].sort((a, b) => (a.time || 0) - (b.time || 0));

    // ✅ ضيف replyTo field للـ user messages
    const userMsgsFull = (activeMsgs || []).map((m) => ({
      time: m.time || 0, type: "user",
      sender: m.sender, text: m.text || "", imageUrl: m.imageUrl || null,
      replyTo: m.replyTo || null,
    }));
    const allFull = [...sysMsgs, ...userMsgsFull].sort((a, b) => (a.time || 0) - (b.time || 0));

    body.innerHTML = allFull.map((m) => {
      if (m.type === "system") {
        return `
          <div class="sysMsg">
            <div class="sysMsg__text">${escapeHtml(m.text)}</div>
            <a class="sysMsg__link" onclick="openChatLink('${m.linkAction}')">${escapeHtml(m.linkText)}</a>
            <div class="sysMsg__time">${fmtTime(m.time)}</div>
          </div>`;
      }
      const mine = m.sender === me;
      const img = m.imageUrl ? `<img class="chatMsg__img" src="${m.imageUrl}" alt="image" />` : "";
      // ✅ READ-RECEIPTS (Binance-style): تظهر فقط على الرسائل اللي أنا بعتها
      let readDot = "";
      if (mine) {
        const isRead = peerSeenMs >= (m.time || 0) && peerSeenMs > 0;
        readDot = `<span class="chatMsg__readMark ${isRead ? "is-read" : ""}" aria-label="${isRead ? "تمت القراءة" : "لم تُقرأ بعد"}">`
                + (isRead
                    ? '<i class="fa-solid fa-check"></i><i class="fa-solid fa-check"></i>'
                    : '<i class="fa-solid fa-check"></i>')
                + `</span>`;
      }
      // ⭐ Reply preview لو الرسالة دي رد على رسالة تانية
      const replyRef = m.replyTo
        ? `<div class="chatMsg__replyRef">${escapeHtml((m.replyTo.text || "").slice(0, 100))}</div>`
        : "";
      // ⭐ data-attrs عشان long-press menu يعرف الرسالة
      const safeText = escapeHtml(m.text || "");
      return `
        <div class="chatMsg ${mine ? "chatMsg--me" : "chatMsg--them"}"
             data-text="${safeText}"
             data-sender="${escapeHtml(m.sender || "")}"
             data-time="${m.time || 0}">
          ${replyRef}
          ${m.text ? `<div>${safeText}</div>` : ""}
          ${img}
          <div class="chatMsg__time">${fmtTime(m.time)}${readDot}</div>
        </div>`;
    }).join("");

    body.scrollTop = body.scrollHeight;
    // فعّل long-press menu (idempotent — يربط مرة واحدة بس)
    wireLongPressMenu();
  }

  window.openChatLink = function (action) {
    if (!activeOrderId) return;
    window.location.href = `order-details.html?orderId=${encodeURIComponent(activeOrderId)}`;
  };

  // ===============================================================
  // ⭐⭐⭐ LONG-PRESS MENU (Copy / Reply) + REPLY STATE ⭐⭐⭐
  // ===============================================================
  // - touchstart على .chatMsg → بعد 500ms يظهر menu (Copy / Reply)
  // - touchmove / touchend / touchcancel → يلغي
  // - Reply: نخزّن snippet من الرسالة في _replyTo + نعرض banner فوق الفوتر
  // ===============================================================
  let _replyTo = null;            // { sender, text, snippet }
  let _lpTimer = null;            // long-press timer
  let _lpStartXY = null;          // touch start coords (لإلغاء الـ press لو اتسحب)
  let _lpTargetMsg = null;        // الرسالة اللي عليها الـ press
  const LP_DURATION = 500;
  const LP_MOVE_TOLERANCE = 10;   // pixel

  function _closeLpMenu() {
    document.querySelectorAll(".lpMenu, .lpMenu__backdrop").forEach((el) => el.remove());
    document.querySelectorAll(".chatMsg.is-pressing").forEach((el) => el.classList.remove("is-pressing"));
  }

  function _showLpMenu(msgEl) {
    _closeLpMenu();
    if (!msgEl) return;
    const text = msgEl.dataset.text || "";
    const sender = msgEl.dataset.sender || "";
    const time = Number(msgEl.dataset.time || 0);

    // backdrop عشان أي touch برّه يقفل المنيو
    const bd = document.createElement("div");
    bd.className = "lpMenu__backdrop";
    bd.addEventListener("touchstart", _closeLpMenu, { passive: true });
    bd.addEventListener("click", _closeLpMenu);
    document.body.appendChild(bd);

    // المنيو
    const menu = document.createElement("div");
    menu.className = "lpMenu";
    menu.innerHTML = `
      <button class="lpMenu__btn" data-action="copy" type="button">
        <i class="fa-solid fa-copy"></i> نسخ
      </button>
      <span class="lpMenu__sep"></span>
      <button class="lpMenu__btn" data-action="reply" type="button">
        <i class="fa-solid fa-reply"></i> رد
      </button>
    `;
    document.body.appendChild(menu);

    // ضع المنيو فوق الرسالة (centered)
    const r = msgEl.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    let top = r.top - mr.height - 8;
    if (top < 70) top = r.bottom + 8; // لو مفيش مكان فوق، حطه تحت
    let left = r.left + (r.width - mr.width) / 2;
    left = Math.max(8, Math.min(window.innerWidth - mr.width - 8, left));
    menu.style.top = top + "px";
    menu.style.left = left + "px";

    // Action handlers
    menu.querySelector('[data-action="copy"]').addEventListener("click", () => {
      _copyToClipboard(text);
      _closeLpMenu();
      window.P2P.toast?.("تم نسخ الرسالة");
    });
    menu.querySelector('[data-action="reply"]').addEventListener("click", async () => {
      const senderName = await getDisplayName(sender);
      _setReplyTo({ sender, senderName, text, time });
      _closeLpMenu();
      const inp = document.getElementById("chatInputText");
      if (inp) inp.focus();
    });
  }

  function _copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return;
      }
    } catch (_) {}
    // fallback
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (_) {}
  }

  function _ensureReplyBanner() {
    let bn = document.getElementById("p2pReplyBanner");
    if (bn) return bn;
    bn = document.createElement("div");
    bn.id = "p2pReplyBanner";
    bn.className = "replyBanner";
    bn.innerHTML = `
      <span class="replyBanner__bar"></span>
      <div class="replyBanner__content">
        <span class="replyBanner__label" id="p2pReplyLabel">رد على</span>
        <span class="replyBanner__text" id="p2pReplyText"></span>
      </div>
      <button class="replyBanner__close" type="button" aria-label="إلغاء">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    document.body.appendChild(bn);
    bn.querySelector(".replyBanner__close").addEventListener("click", _clearReplyTo);
    return bn;
  }

  function _setReplyTo(obj) {
    _replyTo = obj;
    const bn = _ensureReplyBanner();
    document.getElementById("p2pReplyLabel").textContent = `رد على ${obj.senderName || "الرسالة"}`;
    document.getElementById("p2pReplyText").textContent = (obj.text || "").slice(0, 80);
    bn.classList.add("is-active");
    document.body.classList.add("has-reply");
  }

  function _clearReplyTo() {
    _replyTo = null;
    const bn = document.getElementById("p2pReplyBanner");
    if (bn) bn.classList.remove("is-active");
    document.body.classList.remove("has-reply");
  }

  // Event delegation على chatConvBody — مرة واحدة بس
  let _lpWired = false;
  function wireLongPressMenu() {
    if (_lpWired) return;
    const body = document.getElementById("chatConvBody");
    if (!body) return;
    _lpWired = true;

    const cancel = () => {
      if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
      if (_lpTargetMsg) { _lpTargetMsg.classList.remove("is-pressing"); _lpTargetMsg = null; }
      _lpStartXY = null;
    };

    body.addEventListener("touchstart", (e) => {
      const msg = e.target.closest(".chatMsg");
      if (!msg) return;
      _lpTargetMsg = msg;
      const t = e.touches[0];
      _lpStartXY = { x: t.clientX, y: t.clientY };
      msg.classList.add("is-pressing");
      _lpTimer = setTimeout(() => {
        if (_lpTargetMsg) {
          _showLpMenu(_lpTargetMsg);
          _lpTargetMsg.classList.remove("is-pressing");
        }
        _lpTimer = null;
      }, LP_DURATION);
    }, { passive: true });

    body.addEventListener("touchmove", (e) => {
      if (!_lpTimer || !_lpStartXY) return;
      const t = e.touches[0];
      const dx = Math.abs(t.clientX - _lpStartXY.x);
      const dy = Math.abs(t.clientY - _lpStartXY.y);
      if (dx > LP_MOVE_TOLERANCE || dy > LP_MOVE_TOLERANCE) cancel();
    }, { passive: true });

    body.addEventListener("touchend", cancel, { passive: true });
    body.addEventListener("touchcancel", cancel, { passive: true });

    // برضه desktop fallback (right-click → menu)
    body.addEventListener("contextmenu", (e) => {
      const msg = e.target.closest(".chatMsg");
      if (!msg) return;
      e.preventDefault();
      _showLpMenu(msg);
    });

    // أي scroll في الـ body يقفل المنيو
    body.addEventListener("scroll", _closeLpMenu, { passive: true });
  }

  // ---------------- Send / Attach ----------------
  async function sendChatMessage() {
    const rtdb = getRtdb();
    const storage = getStorage();
    if (!activeOrderId || !rtdb) return;
    const addr = window.P2P.state.connectedAddress;
    if (!addr) return window.P2P.toast?.("اربط المحفظة أولاً");

    const textEl = $("chatInputText");
    const text = (textEl?.value || "").trim();
    const file = pendingFile;
    if (!text && !file) return;

    let imageUrl = null;
    if (file && storage) {
      try {
        const path = `chat-images/${activeOrderId}/${Date.now()}_${file.name}`;
        const ref = storage.ref().child(path);
        await ref.put(file);
        imageUrl = await ref.getDownloadURL();
      } catch (e) {
        console.error("[chat] image upload failed", e);
        window.P2P.toast?.("تعذر رفع الصورة");
      }
    }

    try {
      // ⭐ ضيف replyTo snippet لو فيه reply نشط
      const payload = {
        sender: addr, text: text || "", imageUrl: imageUrl || null, time: Date.now(),
      };
      if (_replyTo) {
        payload.replyTo = {
          sender: _replyTo.sender || "",
          text: (_replyTo.text || "").slice(0, 200),
          time: _replyTo.time || 0,
        };
      }
      await rtdb.ref(`chats/${activeOrderId}`).push(payload);
      if (textEl) textEl.value = "";
      pendingFile = null;
      // ✅ امسح replyTo state بعد الإرسال
      _clearReplyTo();
      // ✅ TYPING: امسح حالة الكتابة بتاعتي فور الإرسال
      try { setMyTypingState(false); } catch (_) {}
      // وعشان زرار الإرسال يخفت بعد ما الـ input اتفضّى
      const sb = document.getElementById("chatSendBtn");
      if (sb) sb.classList.remove("is-active");
      // ⭐ scroll للرسائل لتحت بس (مفيش scrollIntoView على الـ input — بيكسر الـ layout
      //    في Android). الـ rAF loop بيتولّى الفوتر فوق الكيبورد تلقائياً.
      try {
        const body = document.querySelector(".chatConv__body");
        if (body) {
          requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
          setTimeout(() => { body.scrollTop = body.scrollHeight; }, 150);
        }
      } catch (_) {}
    } catch (e) {
      console.error("[chat] send failed", e);
      window.P2P.toast?.("تعذر إرسال الرسالة");
    }
  }

  function openChatAttach() { $("chatHiddenFile")?.click(); }
  function onChatFileSelected(e) {
    pendingFile = e.target.files?.[0] || null;
    if (pendingFile) window.P2P.toast?.(`تم اختيار: ${pendingFile.name}`);
  }
  function openChatMenu() { window.P2P.toast?.("القائمة قريباً"); }

  // ---------------- Chat List (bottom-nav entry) ----------------
  function subscribeChatList() {
    const db = getDb();
    if (!db) return;
    const addr = window.P2P.state.connectedAddress;
    if (!addr) return;
    if (typeof unsubChatList === "function") unsubChatList();

    const list = $("chatList");
    if (!list) return;

    unsubChatList = db.collection("Orders").onSnapshot((snap) => {
      const mine = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((o) => {
          if (o.status !== "active" && o.status !== "pending_admin_release") return false;
          return o.userAddress === addr || o.merchantAddress === addr
              || o.buyerAddress === addr || o.sellerAddress === addr;
        })
        .sort((a, b) => tsToMs(b.createdAt || b.timestamp) - tsToMs(a.createdAt || a.timestamp));

      if (!mine.length) {
        list.innerHTML = `<div class="ordersEmpty">لا توجد محادثات نشطة</div>`;
        return;
      }

      list.innerHTML = mine.map((o) => {
        const peer = counterpartyAddr(o, addr);
        const peerShort = peer ? "Trader_" + String(peer).slice(-4) : "Trader";
        return `
          <article class="orderCard" onclick="openChat('${o.id}')" style="cursor:pointer;">
            <div class="orderCard__head">
              <div class="orderCard__type">${peerShort}</div>
              <div class="orderCard__status"><span class="statusDot"></span>محادثة نشطة</div>
            </div>
            <div class="orderRow">
              <span class="orderLabel">رقم الطلب</span>
              <span class="orderVal">${shortId4(o.id)}</span>
            </div>
          </article>`;
      }).join("");

      mine.forEach((o) => {
        const peer = counterpartyAddr(o, addr);
        if (peer) getDisplayName(peer).then((name) => {
          document.querySelectorAll(`.orderCard[onclick*="${o.id}"] .orderCard__type`)
            .forEach((el) => { el.textContent = name; });
        });
      });
    });
  }

  // ---------------- SPA FIX: ?chat=<orderId> URL Param Handler ----------------
  // ✅ FINAL FIX: متزامن قدر الإمكان — لو الـ DOM فيه #chatPage بالفعل، نفتح
  //    الـ shell على طول من غير ما نستنى المحفظة أو الـ db. ده بيمنع الـ
  //    "white flash" نهائياً عند المجي من order-details.html.
  let chatUrlParamHandled = false;
  function handleChatUrlParam() {
    if (chatUrlParamHandled) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const chatId = params.get("chat");
      if (!chatId) return;
      chatUrlParamHandled = true;
      console.log("[chat] handling ?chat= URL param:", chatId);
      openChat(chatId);
      // نظّف الرابط عشان الـ refresh ما يفتحش الشات تاني
      const cleanUrl = window.location.pathname + window.location.hash;
      try { window.history.replaceState({}, "", cleanUrl); } catch (_) {}
    } catch (e) {
      console.warn("[chat] URL param handler failed", e);
    }
  }

  // ✅ EARLY-SHELL: لو الـ user جاي بـ ?chat= نوّر shell الشات فوراً
  //    (synchronously) من غير ما نستنى DOMContentLoaded أو المحفظة.
  //    دا بيمنع الـ blank/white screen في الفترة بين الـ navigation
  //    والـ wallet connect (3-4 ثواني).
  (function earlyChatShell() {
    try {
      if (!new URLSearchParams(location.search).get("chat")) return;
      const apply = () => {
        if (!document.body) return;
        document.body.classList.add("chat-fullscreen", "chat-loading-from-url");
        document.documentElement.classList.add("chat-fullscreen-html");
        const cp = document.getElementById("chatPage");
        if (cp) cp.classList.add("page--active");
        // نطفي أي page تانية فعّالة عشان ما نشوفش marketPage مثلاً
        document.querySelectorAll(".page.page--active").forEach((el) => {
          if (el.id !== "chatPage") el.classList.remove("page--active");
        });
      };
      if (document.body) {
        apply();
      } else {
        // الـ <script> ممكن يكون في الـ <head> — نطبق أول ما الـ body يجي
        const obs = new MutationObserver(() => {
          if (document.body) { apply(); obs.disconnect(); }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        // برضه نضمن لو فات الـ event
        document.addEventListener("DOMContentLoaded", apply, { once: true });
      }
    } catch (_) {}
  })();

  // ===============================================================
  // PUSH NOTIFICATIONS — In-app toast + Browser Notification API
  // ===============================================================
  // - يستخدم Firebase RTDB listener موجود أصلاً (مفيش overhead إضافي)
  // - In-app toast دائماً (مش محتاج صلاحية)
  // - Browser notification فقط لو المستخدم وافق + التاب مش active
  // - يطلب الصلاحية مرة واحدة فقط، يحفظ القرار في localStorage
  // - يشتغل على كل الشاتات النشطة للمستخدم بـ listener واحد لكل شات
  // ===============================================================

  // ===============================================================
  // ✅ NOTIFICATION SOUND — صوت "تينج" خفيف لطيف (Web Audio API)
  // ===============================================================
  // - مفيش ملف خارجي يتحمّل (zero overhead)
  // - sine wave نقي + envelope ناعم → صوت حديث مش مزعج زي iMessage/Telegram
  // - الـ AudioContext بيتـ unlock بعد أول تفاعل من المستخدم
  //   (autoplay policy للمتصفحات الحديثة)
  // - throttle: مش ينعزف أكتر من مرة كل ثانية عشان لو وصلت كذا رسالة سوا
  // ===============================================================
  let _audioCtx = null;
  let _audioUnlocked = false;
  let _lastSoundMs = 0;
  function _ensureAudioCtx() {
    if (_audioCtx) return _audioCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      _audioCtx = new Ctx();
    } catch (_) { _audioCtx = null; }
    return _audioCtx;
  }
  function _unlockAudioOnFirstGesture() {
    if (_audioUnlocked) return;
    const onGesture = () => {
      const ctx = _ensureAudioCtx();
      if (ctx && ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
      _audioUnlocked = true;
      ["click", "touchstart", "keydown"].forEach((ev) =>
        document.removeEventListener(ev, onGesture, true)
      );
    };
    ["click", "touchstart", "keydown"].forEach((ev) =>
      document.addEventListener(ev, onGesture, { capture: true, once: true })
    );
  }
  function playNotificationSound() {
    // throttle 1 ثانية
    const now = Date.now();
    if (now - _lastSoundMs < 1000) return;
    _lastSoundMs = now;

    const ctx = _ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }

    try {
      // نغمتين متتاليتين (دو ↗ صول) — قصيرة جداً + ناعمة
      const t0 = ctx.currentTime;
      const playTone = (freq, startOffset, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, t0 + startOffset);
        // envelope ناعم: fade in سريع جداً + fade out طبيعي
        gain.gain.setValueAtTime(0.0001, t0 + startOffset);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + startOffset + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + startOffset + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + startOffset);
        osc.stop(t0 + startOffset + duration + 0.02);
      };
      playTone(880, 0,    0.13); // A5
      playTone(1318, 0.09, 0.17); // E6 (نغمة فرحة خفيفة)
    } catch (_) { /* silent */ }
  }
  // ابدأ unlock الـ AudioContext من بدري
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _unlockAudioOnFirstGesture, { once: true });
  } else {
    _unlockAudioOnFirstGesture();
  }

  function maybeAskNotificationPermission() {
    if (!("Notification" in window)) return;
    if (notifPermissionAsked) return;
    if (Notification.permission !== "default") return;
    // لو المستخدم رفض قبل كده في الـ session ده
    if (localStorage.getItem("p2p_notif_declined") === "1") return;

    notifPermissionAsked = true;
    // اطلب الصلاحية بعد 5 ثواني من ربط المحفظة (مش فوراً عشان مش مزعج)
    setTimeout(() => {
      Notification.requestPermission().then((perm) => {
        if (perm === "denied") {
          localStorage.setItem("p2p_notif_declined", "1");
        }
      }).catch(() => {});
    }, 5000);
  }

  function showBrowserNotification(title, body, orderId) {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    // فقط لو التاب مش الـ active (المستخدم في تاب تاني)
    if (!document.hidden) return;
    try {
      const n = new Notification(title, {
        body: body || "",
        icon: "https://i.postimg.cc/k5KgcMrP/Screenshot-20260422-200530-Google.jpg",
        tag: `chat-${orderId}`, // يستبدل الإشعارات القديمة بدل ما يكوّمها
        silent: false,
      });
      n.onclick = () => {
        window.focus();
        if (orderId) openChat(orderId);
        n.close();
      };
      // اقفله تلقائياً بعد 6 ثواني
      setTimeout(() => { try { n.close(); } catch (_) {} }, 6000);
    } catch (e) { /* silent */ }
  }

  function updateChatBadge(totalUnread) {
    const navItems = document.querySelectorAll(".bottomNav__item");
    const chatBtn = navItems[3]; // chat = idx 3
    if (!chatBtn) return;

    let badge = chatBtn.querySelector(".navBadge");
    if (totalUnread > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "navBadge";
        chatBtn.style.position = "relative";
        chatBtn.appendChild(badge);
      }
      badge.textContent = totalUnread > 99 ? "99+" : String(totalUnread);
      badge.style.display = "flex";
    } else if (badge) {
      badge.style.display = "none";
    }
  }

  // listener على كل الشاتات الخاصة بالمستخدم لرصد الرسائل الجديدة
  function startGlobalChatListener() {
    const db = getDb();
    const rtdb = getRtdb();
    const addr = window.P2P.state.connectedAddress;
    if (!db || !rtdb || !addr) return;
    if (pushReady) return;
    pushReady = true;

    if (typeof unsubAllChatsForBadge === "function") unsubAllChatsForBadge();

    // اشترك في كل الـ Orders النشطة الخاصة بالمستخدم
    unsubAllChatsForBadge = db.collection("Orders").onSnapshot((snap) => {
      const myActiveOrders = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((o) => {
          if (o.status !== "active" && o.status !== "pending_admin_release") return false;
          return o.buyerAddress === addr || o.sellerAddress === addr
              || o.userAddress === addr || o.merchantAddress === addr;
        });

      // اشترك في رسائل كل شات نشط (واحد listener لكل شات، بس خفيف)
      myActiveOrders.forEach((o) => {
        const orderId = o.id;
        if (window.P2P.chat._chatListeners?.[orderId]) return; // مش نكرر
        window.P2P.chat._chatListeners = window.P2P.chat._chatListeners || {};

        const ref = rtdb.ref(`chats/${orderId}`);
        const handler = (snap) => {
          const raw = snap.val();
          if (!raw) return;
          const msgs = Object.values(raw);
          const last = msgs[msgs.length - 1];
          if (!last) return;
          // لو آخر رسالة من غيري + أحدث من آخر مرة شفت فيها هذا الشات
          const lastSeen = lastSeenMsgTime[orderId] || 0;
          if (last.sender !== addr && (last.time || 0) > lastSeen) {
            // إشعار + بادج
            // لو الشات هذا هو الفاتح حالياً، ما نظهرش إشعار
            if (activeOrderId === orderId) return;

            const peer = counterpartyAddr(o, addr);
            getDisplayName(peer).then((name) => {
              const body = last.text ? last.text.slice(0, 80) : (last.imageUrl ? "📷 صورة" : "رسالة جديدة");
              // ✅ صوت تنبيه خفيف (Web Audio — مفيش ملف خارجي)
              playNotificationSound();
              // In-app toast
              window.P2P.toast?.(`💬 ${name}: ${body}`);
              // Browser notification (لو tab مش active)
              showBrowserNotification(`رسالة من ${name}`, body, orderId);
              // عدّ الرسائل غير المقروءة
              const unreadCount = msgs.filter((m) =>
                m.sender !== addr && (m.time || 0) > lastSeen
              ).length;
              // احسب total unread عبر كل الشاتات
              recomputeTotalUnreadBadge(addr);
            });
          }
        };
        ref.on("value", handler);
        window.P2P.chat._chatListeners[orderId] = { ref, handler, order: o };
      });

      // امسح listeners للشاتات اللي ما عادتش active
      const activeIds = new Set(myActiveOrders.map((o) => o.id));
      Object.keys(window.P2P.chat._chatListeners || {}).forEach((id) => {
        if (!activeIds.has(id)) {
          const L = window.P2P.chat._chatListeners[id];
          if (L?.ref && L?.handler) L.ref.off("value", L.handler);
          delete window.P2P.chat._chatListeners[id];
        }
      });

      // أعد حساب البادج كل ما الـ Orders تتغير
      recomputeTotalUnreadBadge(addr);
    });
  }

  function recomputeTotalUnreadBadge(addr) {
    const rtdb = getRtdb();
    if (!rtdb) return;
    let total = 0;
    let pending = 0;
    const listeners = window.P2P.chat._chatListeners || {};
    const ids = Object.keys(listeners);
    if (!ids.length) { updateChatBadge(0); return; }

    ids.forEach((id) => {
      pending++;
      rtdb.ref(`chats/${id}`).once("value").then((snap) => {
        const raw = snap.val();
        if (raw) {
          const msgs = Object.values(raw);
          const lastSeen = lastSeenMsgTime[id] || 0;
          total += msgs.filter((m) => m.sender !== addr && (m.time || 0) > lastSeen).length;
        }
        pending--;
        if (pending === 0) updateChatBadge(total);
      }).catch(() => { pending--; if (pending === 0) updateChatBadge(total); });
    });
  }

  // ---------------- Globals ----------------
  window.openChat = openChat;
  window.closeChat = closeChatConversation;
  window.closeChatConversation = closeChatConversation;
  window.sendChatMessage = sendChatMessage;
  window.onChatActionClick = onChatActionClick;
  window.openChatAttach = openChatAttach;
  window.onChatFileSelected = onChatFileSelected;
  window.openChatMenu = openChatMenu;

  window.P2P.chat.openChat = openChat;
  window.P2P.chat.closeChat = closeChatConversation;
  window.P2P.chat.sendChatMessage = sendChatMessage;
  window.P2P.chat.subscribeChatList = subscribeChatList;
  window.P2P.chat.startGlobalChatListener = startGlobalChatListener;

  document.addEventListener("p2p:walletConnected", () => {
    subscribeChatList();
    startLastSeenHeartbeat();
    handleChatUrlParam();
    // PUSH: ابدأ مراقبة الشاتات + اطلب الصلاحية
    startGlobalChatListener();
    maybeAskNotificationPermission();
  });

  // ===============================================================
  // ✅ KEYBOARD / VIEWPORT FIX (Visual Viewport API)
  // ===============================================================
  // المشكلة: لما الكيبورد بيفتح في الموبايل، ارتفاع الـ viewport
  //          بينقص. لو معتمدين على 100dvh / 100vh، الهيدر بيتشال
  //          من مكانه أو فجوة بتظهر فوقه.
  //
  // الحل:    نراقب window.visualViewport ونحدّث متغيرين CSS:
  //          --p2p-vh   = الارتفاع الفعلي للـ viewport
  //          --p2p-kb-h = ارتفاع الكيبورد (الفوتر بيرتفع بمقداره)
  //
  //          الهيدر/Action Bar position: fixed على الـ viewport
  //          مباشرة، فمش بيتأثر بأي حاجة.
  // ===============================================================
  // ===============================================================
  // ✅ HEADER LOCK FIX (Telegram/WhatsApp-Web style)
  // ===============================================================
  // المشكلة المتقدمة: iOS Safari بيـ "scroll" الـ visual viewport
  //                  لتحت (offsetTop > 0) عشان يطلّع الـ input فوق
  //                  الكيبورد، فالهيدر اللي position:fixed بيختفي
  //                  لأنه fixed بالنسبة للـ LAYOUT viewport مش الـ
  //                  VISUAL viewport.
  //
  // الحل:           - نحدّث 3 متغيرات CSS:
  //                     --p2p-vh     = الارتفاع الفعلي
  //                     --p2p-kb-h   = ارتفاع الكيبورد
  //                     --p2p-vv-top = offsetTop للـ visual viewport
  //                  - الهيدر/Action Bar بيستخدموا
  //                     transform: translateY(--p2p-vv-top)
  //                    عشان يـ "يلحقوا" الـ visual viewport ويفضلوا
  //                    ملصوقين بأعلى الشاشة الحقيقية.
  //                  - نقفل أي window.scroll بـ window.scrollTo(0,0)
  //                  - نمنع iOS scroll-into-view على الـ input
  // ===============================================================
  // ===============================================================
  // ⭐⭐⭐ rAF-DRIVEN VISUAL VIEWPORT TRACKER ⭐⭐⭐
  // ===============================================================
  // الفكرة: بدل ما نعتمد على resize/scroll/focus events (غير موثوقة
  // في Android لما الكيبورد بيـ animate أو الـ predictive bar بيظهر/يختفي)،
  // بنشغّل requestAnimationFrame loop دائم لما الشات مفتوح. كل فريم
  // (60Hz) بيقرأ:
  //   - window.visualViewport.offsetTop
  //   - window.visualViewport.height
  //   - window.innerHeight
  // ويحسب keyboardOffset = innerHeight - vv.height - vv.offsetTop
  //
  // بعدين بيكتب القيمة في --p2p-kb-offset CSS variable (بس لو اتغيرت
  // عشان نمنع writes زيادة). الفوتر بـ transform: translate3d(0, -kbOffset, 0)
  // يطلع لفوق على الـ GPU بدون أي reflow ولا transition، فبيلتصق
  // فوق الكيبورد بسلاسة 60Hz كاملة، بدون "نطّ" أو jumping أبداً.
  //
  // مفيش dependency على focus/blur — اللوب شغال طول ما الشات مفتوح.
  // ===============================================================
  let _vvRafId = 0;
  let _vvLastKbOffset = -1;
  let _vvLastVvTop = -1;
  let _vvActive = false;

  function _vvTick() {
    if (!_vvActive) return;
    const vv = window.visualViewport;
    if (vv) {
      const offsetTop = Math.max(0, Math.round(vv.offsetTop || 0));
      // ارتفاع الكيبورد = المساحة المخفية تحت = innerHeight - vv.height - offsetTop
      const kbOffset = Math.max(0, Math.round(window.innerHeight - vv.height - offsetTop));

      // ⭐ Write فقط لو القيمة اتغيرت (تجنب writes غير ضرورية)
      if (kbOffset !== _vvLastKbOffset) {
        document.documentElement.style.setProperty("--p2p-kb-offset", kbOffset + "px");
        _vvLastKbOffset = kbOffset;
      }
      if (offsetTop !== _vvLastVvTop) {
        document.documentElement.style.setProperty("--p2p-vv-top", offsetTop + "px");
        document.documentElement.style.setProperty("--p2p-vh", vv.height + "px");
        _vvLastVvTop = offsetTop;
      }

      // ✅ iOS بيحاول يـ scroll الـ window — اقفله فوراً نفس الفريم
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }
    }
    _vvRafId = requestAnimationFrame(_vvTick);
  }

  // ⭐ متروكة للـ backward-compat: أي استدعاء قديم بيكتفي بفريم واحد إضافي
  //    (الـ rAF loop شغال أصلاً، فمش محتاجين منه حاجة)
  function forceViewportRefresh(scrollMessages = false) {
    if (scrollMessages) {
      const body = document.querySelector('.chatConv__body');
      if (body) body.scrollTop = body.scrollHeight;
    }
  }

  function setupVisualViewportFix() {
    if (_vvActive) return;
    _vvActive = true;
    _vvLastKbOffset = -1;
    _vvLastVvTop = -1;
    // ابدأ فوراً
    _vvRafId = requestAnimationFrame(_vvTick);
  }

  function teardownVisualViewportFix() {
    _vvActive = false;
    if (_vvRafId) {
      try { cancelAnimationFrame(_vvRafId); } catch (_) {}
      _vvRafId = 0;
    }
    _vvLastKbOffset = -1;
    _vvLastVvTop = -1;
    const root = document.documentElement;
    root.style.removeProperty("--p2p-vh");
    root.style.removeProperty("--p2p-kb-offset");
    root.style.removeProperty("--p2p-vv-top");
    // قديمة (للنظافة):
    root.style.removeProperty("--p2p-kb-h");
    root.style.removeProperty("--p2p-kb-safety");
  }

  // ✅ FIX (white-page from order-details):
  //   لما يجي الـ user من order-details بـ ?chat=<id>، لازم نفتح shell
  //   الشات فوراً (مش نستنى المحفظة لمدة 3-4 ثواني). openChat نفسها فيها
  //   انتظار للـ db لو لسه ما جاهزش، فدا آمن. الـ flag chatUrlParamHandled
  //   بيمنع الاستدعاء يتكرر لما المحفظة تتربط بعدين.
  document.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get("chat")) return;
    // افتح فوراً (آمن — openChat بتستنى DOM + db داخلياً)
    handleChatUrlParam();
    // Fallback إضافي: لو لأي سبب فشل الفتح الأول، جرب تاني بعد 3 ثواني
    setTimeout(() => {
      if (!chatUrlParamHandled) {
        console.warn("[chat] retrying URL chat handler after 3s");
        handleChatUrlParam();
      }
    }, 3000);
  });
})();
