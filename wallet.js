/* eslint-disable no-console */

// ╔══════════════════════════════════════════════════════════════════════╗
// ║  wallet.js — BSC Edition (Mainnet Only)                             ║
// ║  Provider : window.ethereum (Binance Web3 / MetaMask / Trust)       ║
// ║  Token    : USDT BEP20                                              ║
// ║  Library  : Ethers.js v6 (CDN)                                      ║
// ║  Auto-connect: silent eager via eth_accounts (no popup ever)        ║
// ╚══════════════════════════════════════════════════════════════════════╝

window.P2P         = window.P2P         || {};
window.P2P.utils   = window.P2P.utils   || {};
window.P2P.state   = window.P2P.state   || {};
window.P2P.state.userProfileUnsubscribe = window.P2P.state.userProfileUnsubscribe || null;

// ─── Network Config (BSC Mainnet only) ───────────────────────────────────────
const BSC_MAINNET = {
  chainId:     56,
  chainIdHex:  "0x38",
  chainName:   "BNB Smart Chain",
  usdtAddress: "0x55d398326f99059fF775485246999027B3197955",
  rpcUrls:     ["https://bsc-dataseed.binance.org/"],
  explorerUrl: "https://bscscan.com",
  label:       "BSC Mainnet"
};

let _activeNetwork = BSC_MAINNET;

function _isBSC(chainIdDecimal) {
  return chainIdDecimal === 56;
}

// ─── Platform (Escrow) Wallet ─────────────────────────────────────────────────
const PLATFORM_WALLET = "0xAF0Bdb6B5234F53F53952C8e8991D96F03156Ae8";

// ─── USDT ABI ─────────────────────────────────────────────────────────────────
const USDT_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Utilities
// ─────────────────────────────────────────────────────────────────────────────
window.P2P.utils.format2 = window.P2P.utils.format2 || function (n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(2) : "0.00";
};

window.P2P.toast = window.P2P.toast || function (message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.style.display = "block";
  window.clearTimeout(window.P2P.toast._t);
  window.P2P.toast._t = window.setTimeout(() => { el.style.display = "none"; }, 2800);
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Ethers.js helpers
// ─────────────────────────────────────────────────────────────────────────────
function _getProvider() {
  if (!window.ethereum || !window.ethers) return null;
  return new window.ethers.BrowserProvider(window.ethereum);
}
async function _getSigner() {
  const p = _getProvider();
  return p ? await p.getSigner() : null;
}
async function _getUSDTContract(signerOrProvider) {
  const sp = signerOrProvider || _getProvider();
  if (!sp || !window.ethers) return null;
  return new window.ethers.Contract(_activeNetwork.usdtAddress, USDT_ABI, sp);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Chain Detection & Switch
// ─────────────────────────────────────────────────────────────────────────────
async function _getCurrentChainId() {
  if (!window.ethereum) return null;
  try {
    const cid = await window.ethereum.request({ method: "eth_chainId" });
    return parseInt(cid, 16);
  } catch { return null; }
}

async function _switchToBSC() {
  if (!window.ethereum) throw new Error("No ethereum provider");
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BSC_MAINNET.chainIdHex }]
    });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId:           BSC_MAINNET.chainIdHex,
          chainName:         BSC_MAINNET.chainName,
          nativeCurrency:    { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls:           BSC_MAINNET.rpcUrls,
          blockExplorerUrls: [BSC_MAINNET.explorerUrl]
        }]
      });
    } else { throw e; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Withdraw Button State
// ─────────────────────────────────────────────────────────────────────────────
function _setWithdrawBtnState(isPending) {
  const btn = document.getElementById("withdrawBtn");
  if (!btn) return;
  btn.disabled = isPending;
  btn.innerHTML = isPending
    ? `<i class="fa-solid fa-spinner fa-spin"></i> قيد المراجعة...`
    : `<i class="fa-solid fa-arrow-up-from-bracket"></i> سحب`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Firebase User Profile Listener
// ─────────────────────────────────────────────────────────────────────────────
window.P2P.subscribeUserProfile = function (address) {
  const db = window.db;
  if (!db || !address) return;
  if (window.P2P.state.userProfileUnsubscribe) window.P2P.state.userProfileUnsubscribe();

  const userRef = db.collection("users").doc(address.toLowerCase());
  window.P2P.state.userProfileUnsubscribe = userRef.onSnapshot(async (doc) => {
    if (doc.exists) {
      const data = doc.data();
      window.P2P.state.availableBalance = data.availableBalance || 0;
      window.P2P.state.instantBalance   = data.instantBalance   || 0;
      _setWithdrawBtnState(data.isWithdrawPending === true);
    } else {
      window.P2P.state.availableBalance = 0;
      window.P2P.state.instantBalance   = 0;
      await userRef.set({
        availableBalance: 0, instantBalance: 0,
        lockedBalance: 0, isWithdrawPending: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    window.P2P.refreshHeaderBalanceUI();
    window.P2P.refreshWalletBalanceUI();
  }, (err) => console.error("[wallet] snapshot error:", err));
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. Balance UI
// ─────────────────────────────────────────────────────────────────────────────
function _paintBalanceBox(box, value) {
  if (!box) return;
  box.classList.remove("balanceChip--ok", "balanceChip--zero");
  box.classList.add(Number(value) > 0 ? "balanceChip--ok" : "balanceChip--zero");
}

window.P2P.refreshHeaderBalanceUI = function () {
  const wrap          = document.getElementById("headerBalance");
  const fundingBox    = document.getElementById("headerBalanceFunding");
  const fundingTextEl = document.getElementById("headerBalanceText");
  if (!wrap || !fundingTextEl) return;
  const bal = window.P2P.state.availableBalance || 0;
  fundingTextEl.textContent = `التمويل: ${window.P2P.utils.format2(bal)}`;
  wrap.style.display = (window.P2P.state.currentPageKey || "p2p") !== "ads" ? "inline-flex" : "none";
  _paintBalanceBox(fundingBox, bal);
};

window.P2P.refreshWalletBalanceUI = function () {
  const el = document.getElementById("walletBalance");
  if (el) el.textContent = window.P2P.utils.format2(window.P2P.state.availableBalance || 0);
};

window.P2P.setMaxAmount = function () {
  const input = document.getElementById("adAmount");
  if (input) { input.value = window.P2P.state.availableBalance || 0; input.dispatchEvent(new Event("input")); }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. On-chain Instant Balance (USDT BEP20)
// ─────────────────────────────────────────────────────────────────────────────
window.P2P.refreshOnchainInstantUI = async function () {
  const el  = document.getElementById("headerInstantOnchainText");
  const box = document.getElementById("headerInstantOnchain");
  if (!el) return;

  const addr = window.P2P.state.connectedAddress;
  if (!addr || !window.ethereum || !window.ethers) {
    el.textContent = "الفوري: 0.00";
    if (box) box.classList.remove("balanceChip--ok", "balanceChip--zero");
    return;
  }
  try {
    const provider = _getProvider();
    const contract = await _getUSDTContract(provider);
    const raw      = await contract.balanceOf(addr);
    const balance  = Number(window.ethers.formatUnits(raw, 18));
    el.textContent = `الفوري: ${window.P2P.utils.format2(balance)}`;
    if (box) {
      box.classList.remove("balanceChip--ok", "balanceChip--zero");
      box.classList.add(balance > 0 ? "balanceChip--ok" : "balanceChip--zero");
    }
  } catch (err) {
    console.warn("[onchain] balanceOf failed:", err);
    el.textContent = "الفوري: 0.00";
    if (box) { box.classList.remove("balanceChip--ok"); box.classList.add("balanceChip--zero"); }
  }
};

setInterval(() => { try { window.P2P.refreshOnchainInstantUI(); } catch (_) {} }, 12000);
document.addEventListener("p2p:walletConnected", () => window.P2P.refreshOnchainInstantUI());

// ─────────────────────────────────────────────────────────────────────────────
// 8. Deposit USDT
// ─────────────────────────────────────────────────────────────────────────────
window.P2P.depositUSDT = async function () {
  const addr = window.P2P.state.connectedAddress;
  if (!addr) { window.P2P.toast("يرجى ربط المحفظة أولاً"); return; }
  if (!window.ethers) { window.P2P.toast("مكتبة Ethers.js غير محمّلة"); return; }

  const amount = prompt("أدخل كمية USDT التي تريد إيداعها:");
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) return;

  try {
    const chainId = await _getCurrentChainId();
    if (!_isBSC(chainId)) {
      window.P2P.toast("جاري التبديل لشبكة BSC...");
      await _switchToBSC();
    }

    const provider  = _getProvider();
    const contract  = await _getUSDTContract(provider);
    const rawBal    = await contract.balanceOf(addr);
    const usdtBal   = Number(window.ethers.formatUnits(rawBal, 18));
    if (parseFloat(amount) > usdtBal) {
      window.P2P.toast(`رصيدك الفوري (${window.P2P.utils.format2(usdtBal)} USDT) لا يكفي`);
      return;
    }

    window.P2P.toast("انتظر موافقة المحفظة...");
    const signer       = await _getSigner();
    const signContract = await _getUSDTContract(signer);
    const amountWei    = window.ethers.parseUnits(String(parseFloat(amount).toFixed(18)), 18);

    const tx = await signContract.transfer(PLATFORM_WALLET, amountWei);
    window.P2P.toast("جاري تأكيد المعاملة على BSC...");
    await tx.wait();

    const userRef = window.db.collection("users").doc(addr.toLowerCase());
    await window.db.runTransaction(async (t) => {
      const doc    = await t.get(userRef);
      const oldBal = doc.exists ? (doc.data().availableBalance || 0) : 0;
      t.set(userRef, { availableBalance: oldBal + parseFloat(amount) }, { merge: true });
    });

    window.P2P.toast("✅ تم الإيداع بنجاح!");
  } catch (err) {
    console.error("[wallet] depositUSDT error:", err);
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      window.P2P.toast("تم رفض العملية من المحفظة");
    } else {
      window.P2P.toast("فشلت عملية الإيداع — " + (err.reason || err.message || "خطأ"));
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. Withdraw Request
// ─────────────────────────────────────────────────────────────────────────────
window.P2P.withdrawUSDT = async function () {
  const bal = window.P2P.state.availableBalance || 0;
  const amount = prompt(`أدخل الكمية المراد سحبها (المتاح ${bal} USDT):`);
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) return;
  if (parseFloat(amount) > bal) { window.P2P.toast("الكمية أكبر من رصيدك المتاح"); return; }

  _setWithdrawBtnState(true);
  try {
    const addr = window.P2P.state.connectedAddress;
    if (!addr) { window.P2P.toast("يرجى ربط المحفظة أولاً"); _setWithdrawBtnState(false); return; }

    const userRef = window.db.collection("users").doc(addr.toLowerCase());
    await window.db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw "المستخدم غير موجود";
      const cur = doc.data().availableBalance || 0;
      if (cur < parseFloat(amount)) throw "رصيد غير كافٍ";
      t.update(userRef, { availableBalance: cur - parseFloat(amount), isWithdrawPending: true });
      const withdrawRef = window.db.collection("withdrawals").doc();
      t.set(withdrawRef, {
        userAddress: addr.toLowerCase(),
        amount: parseFloat(amount),
        status: "pending",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });

    window.P2P.toast("✅ تم تقديم طلب السحب — جاري المراجعة!");
  } catch (err) {
    console.error("[wallet] withdrawUSDT error:", err);
    window.P2P.toast(typeof err === "string" ? err : "فشلت العملية");
    _setWithdrawBtnState(false);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. Update UI after successful connect
// ─────────────────────────────────────────────────────────────────────────────
function _applyConnectedUI(addr, network) {
  const btn = document.getElementById("connectBtn");
  if (btn) {
    btn.className = "chip chip--ok";
    btn.innerHTML = `<i class="fa-solid fa-circle-check"></i><span>${addr.slice(0, 6)}...${addr.slice(-4)}</span>`;
  }
  const depositBtn  = document.getElementById("depositBtn");
  const withdrawBtn = document.getElementById("withdrawBtn");
  const maxBtn      = document.getElementById("maxBtn");
  if (depositBtn)  depositBtn.onclick  = () => window.P2P.depositUSDT();
  if (withdrawBtn) withdrawBtn.onclick = () => window.P2P.withdrawUSDT();
  if (maxBtn)      maxBtn.onclick      = () => window.P2P.setMaxAmount();

  window.P2P.subscribeUserProfile(addr);
  document.dispatchEvent(new CustomEvent("p2p:walletConnected", { detail: { address: addr.toLowerCase(), network } }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Connect Wallet (manual — triggered by user tap on connectBtn)
// ─────────────────────────────────────────────────────────────────────────────
window.P2P.connectWallet = async function () {
  const provider = window.ethereum;
  if (!provider) {
    window.P2P.toast("افتح الموقع من داخل Binance App أو MetaMask");
    return;
  }

  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const addr = accounts && accounts[0];
    if (!addr) { window.P2P.toast("لم يتم الحصول على عنوان"); return; }

    const chainId = await _getCurrentChainId();

    if (!_isBSC(chainId)) {
      window.P2P.toast("🔄 جاري التبديل لشبكة BSC...");
      await _switchToBSC();
    }

    _activeNetwork = BSC_MAINNET;
    window.P2P.state.connectedAddress = addr.toLowerCase();
    try { localStorage.setItem("p2p_address", addr.toLowerCase()); } catch (_) {}

    _applyConnectedUI(addr.toLowerCase(), BSC_MAINNET);
    console.log(`[wallet] ✓ connected | address: ${addr}`);
  } catch (err) {
    console.error("[wallet] connectWallet error:", err);
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      window.P2P.toast("رُفض الإذن من المحفظة");
    } else {
      window.P2P.toast("فشل الاتصال — " + (err.message || "خطأ"));
    }
  }
};

window.connectWallet = () => window.P2P.connectWallet();

// ─────────────────────────────────────────────────────────────────────────────
// 12. Eager Auto-Connect — صامت تماماً، بدون popup أو overlay
//     يشتغل عند فتح الصفحة، مناسب لـ Binance Browser اللي بيوفّر الحساب فوراً
// ─────────────────────────────────────────────────────────────────────────────
window.P2P.autoReconnectWallet = async function () {
  if (!window.ethereum) return; // مش داخل من محفظة — لا شيء
  try {
    // eth_accounts: بدون popup — ترجع الحسابات المسموح بيها فقط
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    const addr = accounts && accounts[0];
    if (!addr) return; // لا يوجد حساب مسموح — ننتظر المستخدم يضغط connectBtn

    const chainId = await _getCurrentChainId();

    if (!_isBSC(chainId)) {
      // شبكة غير صحيحة — نجرب نحوّل صامتاً (Binance browser يقبل ده)
      try {
        await _switchToBSC();
      } catch (_) {
        // لو رفض التحويل الصامت، نسيبه ونستنى يضغط يدوياً
        return;
      }
    }

    _activeNetwork = BSC_MAINNET;
    window.P2P.state.connectedAddress = addr.toLowerCase();
    try { localStorage.setItem("p2p_address", addr.toLowerCase()); } catch (_) {}

    _applyConnectedUI(addr.toLowerCase(), BSC_MAINNET);
    console.log(`[wallet] ✓ eager connect | ${addr}`);
  } catch (e) {
    console.warn("[wallet] eager connect failed:", e);
    // فشل صامت — المستخدم يقدر يتصل يدوياً من زرار connectBtn
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 13. Account / Chain change listeners
// ─────────────────────────────────────────────────────────────────────────────
if (window.ethereum) {
  window.ethereum.on("accountsChanged", (accounts) => {
    if (!accounts || !accounts[0]) {
      window.P2P.state.connectedAddress = null;
      try { localStorage.removeItem("p2p_address"); } catch (_) {}
      const btn = document.getElementById("connectBtn");
      if (btn) {
        btn.className = "chip chip--mini chip--danger";
        btn.innerHTML = `<i class="fa-solid fa-link-slash"></i><span>BSC</span>`;
      }
      return;
    }
    window.P2P.autoReconnectWallet();
  });

  window.ethereum.on("chainChanged", () => {
    // عند تغيير الشبكة، نعيد الاتصال الصامت
    window.P2P.autoReconnectWallet();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. Page Load — Eager Silent Connection
// ─────────────────────────────────────────────────────────────────────────────
function _initWallet() {
  window.P2P.autoReconnectWallet();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _initWallet);
} else {
  _initWallet();
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. Visual Viewport Fix (Keyboard aware)
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  function setVh() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty("--vh", (h * 0.01) + "px");
  }
  setVh();
  (window.visualViewport || window).addEventListener("resize", setVh);
  if (window.visualViewport) window.visualViewport.addEventListener("scroll", setVh);
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (!el || !el.tagName) return;
    const tag  = el.tagName.toLowerCase();
    const skip = ["button","submit","reset","checkbox","radio","file","range","color","hidden"];
    if (tag !== "textarea" && !(tag === "input" && !skip.includes((el.type||"").toLowerCase()))) return;
    setTimeout(() => { try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {} }, 280);
  });
})();
