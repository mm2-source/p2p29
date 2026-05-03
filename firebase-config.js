// Firebase config is isolated here to keep script.js clean.
// This file only initializes Firebase and exports handles used by the app.

// --- Firebase Configuration & Initialization ---
const firebaseConfig = {
  apiKey: "AIzaSyClJPT4UQsy9XmV4JB34rt0rYUB-FefyXY",
  authDomain: "mustafa-dbece.firebaseapp.com",
  databaseURL: "https://mustafa-dbece-default-rtdb.firebaseio.com",
  projectId: "mustafa-dbece",
  storageBucket: "mustafa-dbece.appspot.com",
  messagingSenderId: "692060842077",
  appId: "1:692060842077:web:04f0598199c58d403d05b4",
};

firebase.initializeApp(firebaseConfig);

// Firestore is used for Ads + Orders + Notifications.
window.db = firebase.firestore();

// Realtime Database is used for live chat.
// Requires firebase-database-compat.js to be loaded by index.html.
if (firebase.database) {
  window.rtdb = firebase.database();
}

// Storage is used for chat image uploads.
// Requires firebase-storage-compat.js to be loaded by index.html.
if (firebase.storage) {
  window.storage = firebase.storage();
}


window.P2P = window.P2P || {};

// ✅ Toast Glassmorphism بألوان ذكية:
//   - Error  (X)  → أحمر شفاف   → فشل/خطأ/تعذر/اتلغى
//   - Success (✓) → أخضر شفاف  → تم/بنجاح/اكتمل
//   - Info   (!)  → رمادي شفاف → تنبيه/رسالة جديدة/جاري
// الاستخدام:
//   window.P2P.toast("الرسالة")              ← يكتشف النوع تلقائياً
//   window.P2P.toast("الرسالة", "success")  ← override صريح
window.P2P.toast = function (msg, type) {
    const text = String(msg || "");

    // كشف ذكي للنوع لو ما اتبعتش explicit
    let kind = type;
    if (!kind) {
        if (/فشل|خطأ|عفواً|تعذر|اتلغى|ملغي|رفض/.test(text))      kind = 'error';
        else if (/تم|بنجاح|اكتمل|اتأكد/.test(text))                kind = 'success';
        else                                                         kind = 'info'; // تنبيه/رسالة/جاري
    }
    const icon = kind === 'error' ? 'error' : (kind === 'success' ? 'success' : 'info');
    const popupClass = `p2p-glass-toast p2p-glass-toast--${kind}`;

    if (typeof Swal === "undefined") {
        // Fallback: HTML toast بسيط بنفس ألوان الـ glass
        const colors = {
            error:   { bg: 'rgba(255,77,79,0.50)',  bd: 'rgba(255,77,79,0.35)' },
            success: { bg: 'rgba(46,160,87,0.50)',  bd: 'rgba(46,160,87,0.35)' },
            info:    { bg: 'rgba(40,44,54,0.55)',   bd: 'rgba(255,255,255,0.18)' },
        };
        const c = colors[kind] || colors.info;
        const symbols = { error: '\u2715', success: '\u2713', info: '!' };
        const t = document.createElement('div');
        t.className = `p2p-fallback-toast p2p-fallback-toast--${kind}`;
        t.innerHTML = `<span class="ico">${symbols[kind]}</span><span class="txt">${text}</span>`;
        Object.assign(t.style, {
            position: 'fixed', top: '70px', left: '50%',
            transform: 'translateX(-50%)', zIndex: 9999,
            display: 'flex', alignItems: 'center', gap: '8px',
            background: c.bg, color: '#fff',
            backdropFilter: 'blur(14px) saturate(160%)',
            webkitBackdropFilter: 'blur(14px) saturate(160%)',
            padding: '8px 14px', borderRadius: '14px',
            fontSize: '13px', fontWeight: 600,
            border: `1px solid ${c.bd}`,
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            fontFamily: '"IBM Plex Sans Arabic", "Segoe UI", Tahoma, sans-serif'
        });
        document.body.appendChild(t);
        setTimeout(() => { try { t.remove(); } catch (_) {} }, 2500);
        return;
    }

    const Toast = Swal.mixin({
        toast: true,
        position: 'top',
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
        customClass: { popup: popupClass },
    });

    Toast.fire({
        icon,
        title: `<span style="font-size:13px; font-weight:600; color:#fff;">${text}</span>`,
    });
};