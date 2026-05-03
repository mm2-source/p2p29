/* eslint-disable no-console */

// ╔══════════════════════════════════════════════════════════════════════╗
// ║  admin.js — Admin Panel (BSC Edition)                               ║
// ║  • approveWithdraw  → sends USDT on-chain to withdrawal address     ║
// ║  • approveRelease   → TWO-PHASE on-chain release to buyer:          ║
// ║    Phase 1: tx broadcast  → Firestore: releaseTxPending=true        ║
// ║    Phase 2: tx confirmed  → Firestore: status=completed             ║
// ║    Buyer sees real-time mirror of every phase change                ║
// ╚══════════════════════════════════════════════════════════════════════╝

// ─── Network + USDT ──────────────────────────────────────────────────────────
const ADMIN_BSC_NETWORKS = {
  mainnet: {
    chainId: 56, chainIdHex: "0x38",
    chainName: "BNB Smart Chain",
    usdtAddress: "0x55d398326f99059fF775485246999027B3197955",
    rpcUrls: ["https://bsc-dataseed.binance.org/"],
    explorerUrl: "https://bscscan.com",
    label: "BSC Mainnet"
  },
  testnet: {
    chainId: 97, chainIdHex: "0x61",
    chainName: "BNB Smart Chain Testnet",
    usdtAddress: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545/"],
    explorerUrl: "https://testnet.bscscan.com",
    label: "BSC Testnet"
  }
};

let _adminNetwork    = ADMIN_BSC_NETWORKS.mainnet;
let _releaseInProgress = false;   // منع النقر المزدوج أثناء التحرير

const USDT_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)"
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shortAddr(a) {
  const s = String(a || "");
  return s.length > 12 ? s.slice(0, 6) + "…" + s.slice(-4) : s || "—";
}
function escapeAttr(s) { return String(s || "").replace(/"/g, "&quot;"); }
function fmtDate(ts) {
  if (!ts) return "—";
  let d;
  if (typeof ts.toDate === "function") d = ts.toDate();
  else if (ts.seconds) d = new Date(ts.seconds * 1000);
  else if (typeof ts === "number") d = new Date(ts);
  else return "—";
  const p = (n) => (n < 10 ? "0" + n : n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function setBadge(id, count) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(count);
}
function setAdminStatus(msg, color) {
  const el = document.getElementById("adminStatus");
  if (el) { el.textContent = msg; el.style.color = color || "#888"; }
}

// ─── Release Overlay (يظهر للأدمن أثناء انتظار البلوكشين) ────────────────────
function showReleaseOverlay(phase, txHash) {
  const overlay = document.getElementById("adminReleaseOverlay");
  const msgEl   = document.getElementById("adminOverlayMsg");
  const subEl   = document.getElementById("adminOverlaySub");
  const linkEl  = document.getElementById("adminOverlayTxLink");
  if (!overlay) return;

  overlay.style.display = "flex";

  if (phase === "signing") {
    msgEl.textContent = "⏳ في انتظار توقيع المحفظة...";
    subEl.textContent  = "يرجى فتح MetaMask والموافقة على المعاملة.";
    if (linkEl) linkEl.style.display = "none";
  } else if (phase === "pending") {
    msgEl.textContent = "🔗 المعاملة مُرسلة على BSC";
    subEl.textContent  = "جارٍ انتظار تأكيد البلوكشين — لا تغلق الصفحة.";
    if (linkEl && txHash) {
      linkEl.href        = `${_adminNetwork.explorerUrl}/tx/${txHash}`;
      linkEl.textContent = `${txHash.slice(0, 14)}… ← عرض على BSCScan`;
      linkEl.style.display = "inline-block";
    }
  } else if (phase === "success") {
    msgEl.textContent = "✅ تم التحرير بنجاح!";
    subEl.textContent  = "تمت المعاملة على البلوكشين وتحديث الطلب.";
    if (linkEl && txHash) {
      linkEl.href        = `${_adminNetwork.explorerUrl}/tx/${txHash}`;
      linkEl.textContent = `${txHash.slice(0, 14)}… ← عرض على BSCScan`;
      linkEl.style.display = "inline-block";
    }
    setTimeout(() => hideReleaseOverlay(), 4000);
  }
}
function hideReleaseOverlay() {
  const overlay = document.getElementById("adminReleaseOverlay");
  if (overlay) overlay.style.display = "none";
}

// ─── Proof Modal ──────────────────────────────────────────────────────────────
window.openProofModal = function (src) {
  const modal = document.getElementById("proofModal");
  const img   = document.getElementById("proofModalImg");
  if (!modal || !img || !src) return;
  img.src = src;
  modal.classList.add("show");
};
window.closeProofModal = function () {
  const modal = document.getElementById("proofModal");
  if (modal) modal.classList.remove("show");
};

// ─── Ethers.js helpers ────────────────────────────────────────────────────────
function _adminProvider() {
  if (!window.ethereum || !window.ethers) return null;
  return new window.ethers.BrowserProvider(window.ethereum);
}
async function _adminSigner() {
  const p = _adminProvider();
  return p ? await p.getSigner() : null;
}
async function _adminUSDT(sp) {
  if (!sp || !window.ethers) return null;
  return new window.ethers.Contract(_adminNetwork.usdtAddress, USDT_ABI, sp);
}
async function _adminChainId() {
  if (!window.ethereum) return null;
  try { return parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16); }
  catch { return null; }
}

// ─── Switch network ───────────────────────────────────────────────────────────
async function _adminSwitchNetwork(net) {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: net.chainIdHex }] });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: net.chainIdHex, chainName: net.chainName,
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls: net.rpcUrls, blockExplorerUrls: [net.explorerUrl]
        }]
      });
    } else { throw e; }
  }
}

// ─── Admin wallet init ────────────────────────────────────────────────────────
async function initAdminWallet() {
  if (!window.ethereum) {
    setAdminStatus("❌ لا توجد محفظة — افتح من متصفح Binance Web3", "#dc2626");
    return false;
  }
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts[0]) {
      setAdminStatus("❌ لم يتم الحصول على عنوان المحفظة", "#dc2626");
      return false;
    }

    const chainId = await _adminChainId();
    let net = null;
    if (chainId === 56) net = ADMIN_BSC_NETWORKS.mainnet;
    if (chainId === 97) net = ADMIN_BSC_NETWORKS.testnet;

    if (!net) {
      setAdminStatus("⚠️ شبكة غير مدعومة — جاري التبديل للـ Mainnet...", "#f59e0b");
      await _adminSwitchNetwork(ADMIN_BSC_NETWORKS.mainnet);
      net = ADMIN_BSC_NETWORKS.mainnet;
    }

    _adminNetwork = net;
    const addr = accounts[0];
    setAdminStatus(
      `✅ متصل — ${shortAddr(addr)} | ${net.label}`,
      net.chainId === 97 ? "#f59e0b" : "#16a34a"
    );

    const netLabel = document.getElementById("adminNetLabel");
    if (netLabel) {
      netLabel.textContent = net.chainId === 97
        ? "🧪 Testnet — عمليات وهمية"
        : "🟡 Mainnet — عمليات حقيقية";
      netLabel.style.color = net.chainId === 97 ? "#f59e0b" : "#16a34a";
    }
    return true;
  } catch (e) {
    setAdminStatus("❌ فشل الاتصال: " + (e.message || e), "#dc2626");
    return false;
  }
}

// تشغيل الاتصال التلقائي عند فتح لوحة التحكم
window.addEventListener("load", () => {
  if (window.ethereum) {
    window.ethereum.request({ method: "eth_accounts" })
      .then((accs) => { if (accs && accs[0]) initAdminWallet(); })
      .catch(() => {});
  }
});

if (window.ethereum) {
  window.ethereum.on("chainChanged", () => initAdminWallet());
  window.ethereum.on("accountsChanged", () => initAdminWallet());
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) سحب الأرباح — Withdrawals (pending) → إرسال USDT on-chain
// ─────────────────────────────────────────────────────────────────────────────
db.collection("withdrawals")
  .where("status", "==", "pending")
  .onSnapshot((snap) => {
    const body = document.querySelector("#withdrawTable tbody");
    if (!body) return;
    setBadge("withdrawCount", snap.size);
    if (snap.empty) {
      body.innerHTML = `<tr class="empty-row"><td colspan="4">لا توجد طلبات سحب معلقة</td></tr>`;
      return;
    }
    body.innerHTML = "";
    snap.forEach((doc) => {
      const d = doc.data();
      body.innerHTML += `
        <tr>
          <td class="addr-cell">${d.userAddress}</td>
          <td>${d.amount} USDT</td>
          <td>${fmtDate(d.createdAt)}</td>
          <td>
            <button class="btn-withdraw"
              onclick="approveWithdraw('${doc.id}','${escapeAttr(d.userAddress)}',${d.amount})">
              إرسال (BSC)
            </button>
          </td>
        </tr>`;
    });
  });

window.approveWithdraw = async function (id, address, amount) {
  const ready = await initAdminWallet();
  if (!ready) return;
  if (!confirm(`إرسال ${amount} USDT (${_adminNetwork.label}) فعلياً إلى ${address}؟`)) return;

  try {
    const signer   = await _adminSigner();
    const contract = await _adminUSDT(signer);
    const wei      = window.ethers.parseUnits(String(Number(amount).toFixed(18)), 18);

    const tx      = await contract.transfer(address, wei);
    alert("✅ أُرسلت المعاملة — بانتظار التأكيد...");
    const receipt = await tx.wait();
    const txHash  = receipt.hash || tx.hash;

    await db.collection("withdrawals").doc(id).update({
      status: "completed",
      txHash,
      approvedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    try {
      await db.collection("users").doc(address.toLowerCase())
        .update({ isWithdrawPending: false });
    } catch (e2) {
      console.warn("[admin] could not clear isWithdrawPending:", e2);
    }
    alert("✅ تم التحويل بنجاح!\nHash: " + txHash);
  } catch (err) {
    console.error("[admin] approveWithdraw:", err);
    if (err.code === 4001 || err.code === "ACTION_REJECTED") alert("رُفض من المحفظة");
    else alert("فشلت العملية: " + (err.reason || err.message || err));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2) تحرير طلبات البيع — TWO-PHASE On-Chain BSC Release
//
//  المرحلة 1 (فور بث الـ tx):
//    → Firestore: releaseTxPending=true + adminReleaseTxHash=tx.hash
//    → المشتري يرى فوراً: "المعاملة جارية على BSC" + رابط الـ Hash
//    → الأدمن يرى: Overlay "المعاملة مُرسلة"
//
//  المرحلة 2 (بعد تأكيد البلوكشين):
//    → Firestore: status="completed" + releaseTxPending=false
//    → المشتري يرى فوراً: علامة ✅ الخضراء
//    → الأدمن يرى: Overlay "تم التحرير بنجاح" (يختفي تلقائياً)
// ─────────────────────────────────────────────────────────────────────────────
db.collection("Orders")
  .where("status", "==", "pending_admin_release")
  .onSnapshot((snap) => {
    const body = document.querySelector("#releaseTable tbody");
    if (!body) return;
    setBadge("releaseCount", snap.size);
    if (snap.empty) {
      body.innerHTML = `<tr class="empty-row"><td colspan="5">لا توجد طلبات تحت المراجعة</td></tr>`;
      return;
    }
    body.innerHTML = "";
    snap.forEach((doc) => {
      const o      = doc.data();
      const qty    = Number(o.usdtAmount || o.cryptoAmount || o.quantity || 0).toFixed(2);
      const egp    = Number(o.amount || 0).toFixed(2);
      const buyer  = o.buyerAddress  || o.userAddress  || "—";
      const seller = o.sellerAddress || o.merchantAddress || "—";

      // إذا كانت معاملة هذا الطلب قيد البث، أظهر ذلك في الجدول
      const inFlight = o.releaseTxPending
        ? `<br><small style="color:#3b82f6;font-size:10px;">⏳ على السلسلة…</small>`
        : "";

      body.innerHTML += `
        <tr>
          <td title="${doc.id}"><code>${doc.id.slice(0, 10)}…</code></td>
          <td class="addr-cell" title="${escapeAttr(buyer)}">${shortAddr(buyer)}</td>
          <td class="addr-cell" title="${escapeAttr(seller)}">${shortAddr(seller)}</td>
          <td><strong>${qty}</strong> USDT<br><small style="color:#999">${egp} EGP</small>${inFlight}</td>
          <td>
            <button class="btn-release" ${o.releaseTxPending ? "disabled" : ""}
              onclick="approveRelease('${doc.id}','${escapeAttr(buyer)}','${escapeAttr(seller)}',${qty})">
              ${o.releaseTxPending ? "⏳ جارٍ التأكيد…" : "💸 تحرير العملات"}
            </button>
          </td>
        </tr>`;
    });
  });

window.approveRelease = async function (orderId, buyerAddress, sellerAddress, usdtAmount) {
  console.log(
    `%c[ADMIN] Release: order=${orderId} | buyer=${buyerAddress} | qty=${usdtAmount}`,
    "color:white;background:#1d4ed8;padding:4px 8px;border-radius:4px;"
  );

  // ── منع النقر المزدوج ──────────────────────────────────────────────────────
  if (_releaseInProgress) {
    alert("⏳ عملية تحرير جارية بالفعل، يرجى الانتظار حتى تكتمل.");
    return;
  }

  // ── التحقق من عنوان المشتري ────────────────────────────────────────────────
  if (!buyerAddress || buyerAddress === "—") {
    alert("❌ عنوان محفظة المشتري غير متوفر في الطلب.\nلا يمكن إجراء التحويل.");
    return;
  }

  // ── ربط المحفظة ───────────────────────────────────────────────────────────
  const ready = await initAdminWallet();
  if (!ready) return;

  // ── تأكيد نهائي ───────────────────────────────────────────────────────────
  if (!confirm(
    `تحرير ${usdtAmount} USDT على ${_adminNetwork.label}\n\n` +
    `📤 إلى المشتري: ${buyerAddress}\n\n` +
    `⚠️ سيتم إرسال معاملة حقيقية على سلسلة BSC.\n` +
    `تأكد من صحة البيانات قبل المتابعة.`
  )) return;

  _releaseInProgress = true;
  showReleaseOverlay("signing");
  setAdminStatus("⏳ في انتظار توقيع المحفظة...", "#f59e0b");

  const orderRef = db.collection("Orders").doc(orderId);

  try {
    // ── إرسال المعاملة على BSC ────────────────────────────────────────────────
    const signer   = await _adminSigner();
    const contract = await _adminUSDT(signer);
    const wei      = window.ethers.parseUnits(String(Number(usdtAmount).toFixed(18)), 18);

    const tx = await contract.transfer(buyerAddress, wei);

    // ══ المرحلة 1: فور بث الـ tx — حدّث Firestore فوراً ══════════════════════
    // المشتري سيرى "المعاملة جارية على BSC" في اللحظة ذاتها
    try {
      await orderRef.update({
        releaseTxPending:   true,
        adminReleaseTxHash: tx.hash,
        releaseStartedAt:   firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (fsErr) {
      console.warn("[admin] phase-1 firestore update failed:", fsErr);
    }

    showReleaseOverlay("pending", tx.hash);
    setAdminStatus(`🔗 المعاملة على الشبكة — جارٍ التأكيد... ${tx.hash.slice(0, 10)}…`, "#3b82f6");

    // ── انتظر تأكيد البلوكشين ────────────────────────────────────────────────
    const receipt = await tx.wait();
    const txHash  = receipt.hash || tx.hash;

    // ══ المرحلة 2: بعد التأكيد — حدّث Firestore لـ "completed" ═══════════════
    // المشتري سيرى علامة ✅ الخضراء فوراً
    const snap = await orderRef.get();
    if (!snap.exists) {
      showReleaseOverlay("success", txHash);
      setAdminStatus(`✅ تمت المعاملة! Hash: ${txHash.slice(0, 16)}…`, "#16a34a");
      console.warn("[admin] tx confirmed but order not found in Firestore. Hash:", txHash);
      _releaseInProgress = false;
      return;
    }

    const orderData = snap.data();

    // تحديد البائع الفعلي
    let actualSeller = sellerAddress;
    if (String(orderData.adType || "").toLowerCase() === "buy") {
      actualSeller = orderData.userAddress || orderData.sellerAddress || sellerAddress;
    } else {
      actualSeller = orderData.merchantAddress || orderData.sellerAddress || sellerAddress;
    }

    // تحديث الطلب إلى مكتمل
    await orderRef.update({
      status:             "completed",
      released:           true,
      releasedByAdmin:    true,
      adminReleaseMethod: "on_chain_bsc",
      adminReleaseTxHash: txHash,
      releasedAt:         firebase.firestore.FieldValue.serverTimestamp(),
      releaseTxPending:   false
    });

    // خصم رصيد البائع
    if (actualSeller && actualSeller !== "—") {
      try {
        await db.collection("users").doc(String(actualSeller).toLowerCase()).update({
          availableBalance: firebase.firestore.FieldValue.increment(-Number(usdtAmount)),
          usdtBalance:      firebase.firestore.FieldValue.increment(-Number(usdtAmount))
        });
      } catch (userErr) {
        console.warn("[admin] could not deduct seller balance:", userErr);
      }
    }

    showReleaseOverlay("success", txHash);
    setAdminStatus(`✅ تم التحرير بنجاح! Hash: ${txHash.slice(0, 16)}…`, "#16a34a");

  } catch (err) {
    console.error("[admin] approveRelease error:", err);
    hideReleaseOverlay();

    // في حالة الرفض من المحفظة — أزل releaseTxPending إن وُجد
    try {
      await orderRef.update({ releaseTxPending: false });
    } catch (_) {}

    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      setAdminStatus("❌ رُفضت المعاملة من المحفظة.", "#dc2626");
      alert("❌ رُفضت المعاملة من المحفظة.");
    } else {
      setAdminStatus("❌ فشلت العملية: " + (err.reason || err.message || ""), "#dc2626");
      alert("❌ فشلت العملية:\n" + (err.reason || err.message || err));
    }
  } finally {
    _releaseInProgress = false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3) الطلبات المكتملة — Audit Trail
// ─────────────────────────────────────────────────────────────────────────────
db.collection("Orders")
  .where("status", "==", "completed")
  .onSnapshot((snap) => {
    const body = document.querySelector("#completedTable tbody");
    if (!body) return;
    setBadge("completedCount", snap.size);
    if (snap.empty) {
      body.innerHTML = `<tr class="empty-row"><td colspan="10">لا توجد طلبات منفّذة حتى الآن</td></tr>`;
      return;
    }

    const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    orders.sort((a, b) => {
      const ta = (a.releasedAt?.seconds || a.paymentConfirmedAt?.seconds || a.timestamp?.seconds || 0);
      const tb = (b.releasedAt?.seconds || b.paymentConfirmedAt?.seconds || b.timestamp?.seconds || 0);
      return tb - ta;
    });

    body.innerHTML = orders.map((o) => {
      let releaseTag;
      if (o.releasedByAdmin) {
        releaseTag = o.adminReleaseMethod === "on_chain_bsc"
          ? `<span class="tag tag-chain">🔗 BSC (أدمن)</span>`
          : `<span class="tag tag-admin">يدوي (أدمن)</span>`;
      } else {
        releaseTag = `<span class="tag tag-auto">تلقائي (بائع)</span>`;
      }

      const txLink = o.adminReleaseTxHash
        ? `<a href="${_adminNetwork.explorerUrl}/tx/${o.adminReleaseTxHash}" target="_blank"
              style="font-size:10px;color:#3b82f6;text-decoration:none;font-family:monospace;">
              ${o.adminReleaseTxHash.slice(0, 8)}…
           </a>`
        : `<span style="color:#aaa">—</span>`;

      const proofBtn = o.proofImage
        ? `<button class="btn-view" onclick="openProofModal('${escapeAttr(o.proofImage)}')">عرض</button>`
        : `<span style="color:#aaa">—</span>`;
      const qty = Number(o.quantity || o.usdtAmount || o.cryptoAmount || 0).toFixed(2);
      const amt = Number(o.amount || 0).toFixed(2);

      return `
        <tr>
          <td title="${o.id}"><code style="font-size:11px">${o.id.slice(0, 10)}…</code></td>
          <td class="addr-cell" title="${escapeAttr(o.sellerAddress)}">${shortAddr(o.sellerAddress)}</td>
          <td class="addr-cell" title="${escapeAttr(o.buyerAddress)}">${shortAddr(o.buyerAddress)}</td>
          <td><strong>${qty}</strong> USDT</td>
          <td>${amt} ${o.currency || "EGP"}</td>
          <td>${o.paymentMethod || "—"}</td>
          <td style="font-size:12px">${fmtDate(o.releasedAt || o.paymentConfirmedAt || o.timestamp)}</td>
          <td>${releaseTag}</td>
          <td>${txLink}</td>
          <td>${proofBtn}</td>
        </tr>`;
    }).join("");
  });
