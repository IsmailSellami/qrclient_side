
const categoryContainer = document.getElementById("categorie");
const productContainer = document.getElementById("product");
const titleEl = document.getElementById("name");
const searchInput = document.getElementById("search");
const openCartBtn = document.getElementById("openCart");                
const closeCartBtn = document.getElementById("closeCart");
const cartOverlay = document.getElementById("cartOverlay");
const cartDrawer = document.getElementById("cartDrawer");
const cartItemsEl = document.getElementById("cartItems");
const cartTotalEl = document.getElementById("cartTotal");
const cartCountEl = document.getElementById("cartCount");
const demanderBtn = document.getElementById("demanderBtn");
const toastEl = document.getElementById("toast");

// Payment & QR modals
const paymentOverlay = document.getElementById("paymentOverlay");
const paymentModal = document.getElementById("paymentModal");
const paymentClose = document.getElementById("paymentClose");
const payCardBtn = document.getElementById("payCard");
const payCashBtn = document.getElementById("payCash");

const qrOverlay = document.getElementById("qrOverlay");
const qrModal = document.getElementById("qrModal");
const qrClose = document.getElementById("qrClose");
const qrResult = document.getElementById("qrResult");
const qrCameraError = document.getElementById("qrCameraError");
const qrFlashBtn = document.getElementById("qrFlashBtn");
const qrRetryBtn = document.getElementById("qrRetryBtn");

let html5QrCode = null;
let qrScannerRunning = false;
let qrTorchOn = false;
let qrNativeStream = null;
let qrNativeDetector = null;
let qrNativeRafId = null;
let qrNativeVideo = null;
let qrNativeInFlight = false;
let qrStartPromise = null;
let html5QrcodeLibPromise = null;

const cashOverlay = document.getElementById("cashOverlay");
const cashModal = document.getElementById("cashModal");
const cashOk = document.getElementById("cashOk");

const discountBanner = document.getElementById("discountBanner");
const paymentTotalAmount = document.getElementById("paymentTotalAmount");
const paymentLoyaltyReward = document.getElementById("paymentLoyaltyReward");
const loyaltyInfoEl = document.getElementById("loyaltyInfo");
const rewardSelectionEl = document.getElementById("rewardSelection");
const confirmPaymentBtn = document.getElementById("confirmPaymentBtn");

let lastOrderIdrecu = null;
let lastOrderTotal = 0;
let activePromotion = null;
let pendingOrderItems = null;
let pendingOrderTotal = 0;

let loyaltyConfig = null;
let loyaltyCustomerInfo = null;
let selectedRewardId = null;
let selectedRewardDiscount = 0;
let selectedFreeOption = null;
let pendingQrId = null;

const PROMOTION_CACHE_TTL = 60000;
let promotionCache = { data: null, ts: 0 };

const caractereOverlay = document.getElementById("caractereOverlay");
const caractereModal = document.getElementById("caractereModal");
const caractereClose = document.getElementById("caractereClose");
const caractereImg = document.getElementById("caractereImg");
const caractereOptions = document.getElementById("caractereOptions");
const promotionBanner = document.getElementById("promotionBanner");
const params = new URLSearchParams(window.location.search);
const numtable = Number(params.get("table")) || 60;

console.log("TABLE =", numtable);
let selectedCategory = "Tous";
let categories = [];
let products = [];
let searchQuery = "";

let cart = [];

const STORAGE_CART_KEY = "sellamo_cart";
const STORAGE_COMMENTS_KEY = "sellamo_comments";
let toastTimerId = null;

function clearElement(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
}

function setCaractereOpen(isOpen) {
    if (!caractereModal || !caractereOverlay) return;
    caractereModal.classList.toggle("open", isOpen);
    caractereOverlay.classList.toggle("open", isOpen);
    caractereModal.setAttribute("aria-hidden", String(!isOpen));
    caractereOverlay.setAttribute("aria-hidden", String(!isOpen));
}

function renderCaractereOptions(caractere) {
    if (!caractereOptions) return;
    caractereOptions.innerHTML = "";
    const raw = String(caractere || "").trim();
    if (!raw) {
        caractereOptions.textContent = "Aucune option";
        return;
    }
    const options = raw.split(/[,;|]/).map((opt) => opt.trim()).filter(Boolean);
    options.forEach((opt, idx) => {
        const label = document.createElement("label");
        const span = document.createElement("span");
        span.textContent = opt;
        label.appendChild(span);
        caractereOptions.appendChild(label);
    });
}

function openCaractereModal(product) {
    if (!product || !caractereModal) return;
    if (caractereImg) {
        caractereImg.src = product.img ? `${product.img}` : "";
        caractereImg.alt = product.idname || "";
    }
    renderCaractereOptions(product.caractere);
    setCaractereOpen(true);
}

if (caractereClose) {
    caractereClose.addEventListener("click", () => setCaractereOpen(false));
}

if (caractereOverlay) {
    caractereOverlay.addEventListener("click", () => setCaractereOpen(false));
}

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setCaractereOpen(false);
});

function getProductKey(product) {
    const raw = product?.id ?? product?.idprod ?? product?.idproduct;
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") return String(raw);
    return `${normalizeCategoryName(product?.idcat)}:${normalizeCategoryName(product?.idname)}`;
}

function safeNumber(value) {
    const n = typeof value === "number" ? value : parseFloat(String(value ?? "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = String(message ?? "");
    toastEl.classList.add("show");
    toastEl.setAttribute("aria-hidden", "false");

    if (toastTimerId) {
        clearTimeout(toastTimerId);
        toastTimerId = null;
    }

    toastTimerId = setTimeout(() => {
        toastEl.classList.remove("show");
        toastEl.setAttribute("aria-hidden", "true");
        toastTimerId = null;
    }, 5000);
}

function makeCartItemId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadPersistedState() {
    try {
        const rawCart = JSON.parse(localStorage.getItem(STORAGE_CART_KEY) || "[]");
        cart = Array.isArray(rawCart) ? rawCart.filter((x) => x && (x.id || x.key || x.productKey)) : [];
    } catch {
        cart = [];
    }

    try {
        const rawComments = JSON.parse(localStorage.getItem(STORAGE_COMMENTS_KEY) || "{}");
        const legacyCommentsByKey = new Map(Object.entries(rawComments || {}));

        // Migrate legacy cart format:
        // - old: [{ key, qty }]
        // - new: [{ id, productKey, name, price, img, comment }]
        if (cart.some((x) => x && (x.qty || x.key))) {
            const migrated = [];
            cart.forEach((entry) => {
                const key = entry.productKey || entry.key;
                const qty = entry.qty || 1;
                const p = key ? getProductByKey(String(key)) : null;
                const comment = key ? legacyCommentsByKey.get(String(key)) || "" : "";
                for (let i = 0; i < qty; i++) {
                    migrated.push({
                        id: makeCartItemId(),
                        productKey: key ? String(key) : "",
                        name: p?.idname ?? "",
                        price: p?.price ?? 0,
                        img: p?.img ?? "",
                        comment,
                    });
                }
            });
            cart = migrated;
            persistCart();
        } else {
            // Normalize new format fields
            cart = cart
                .map((x) => {
                    const productKey = x.productKey || x.key;
                    const p = productKey ? getProductByKey(String(productKey)) : null;
                    return {
                        id: x.id || makeCartItemId(),
                        productKey: productKey ? String(productKey) : "",
                        name: x.name ?? p?.idname ?? "",
                        price: x.price ?? p?.price ?? 0,
                        img: x.img ?? p?.img ?? "",
                        comment: x.comment ?? "",
                    };
                })
                .filter((x) => x.productKey);
            persistCart();
        }
    } catch {
        // ignore legacy comment load failures
    }
}

function persistCart() {
    localStorage.setItem(STORAGE_CART_KEY, JSON.stringify(cart));
}

function addToCart(product, comment) {
    const productKey = getProductKey(product);
    cart.push({
        id: makeCartItemId(),
        productKey,
        name: product?.idname ?? "",
        price: product?.price ?? 0,
        img: product?.img ?? "",
        comment: String(comment ?? ""),
    });
    persistCart();
    renderCart();
}

function removeFromCart(cartItemId) {
    const idx = cart.findIndex((i) => i.id === cartItemId);
    if (idx === -1) return;
    cart.splice(idx, 1);
    persistCart();
    renderCart();
}

function getProductByKey(productKey) {
    return products.find((p) => getProductKey(p) === productKey);
}

function setCartOpen(isOpen) {
    if (!cartDrawer || !cartOverlay) return;
    cartDrawer.classList.toggle("open", isOpen);
    cartOverlay.classList.toggle("open", isOpen);
    cartDrawer.setAttribute("aria-hidden", String(!isOpen));
    cartOverlay.setAttribute("aria-hidden", String(!isOpen));
}

function updateCartBadgeAndTotal() {
    const totalQty = cart.length;
    if (cartCountEl) cartCountEl.textContent = String(totalQty);

    const total = cart.reduce((sum, item) => sum + safeNumber(item.price), 0);
    if (cartTotalEl) cartTotalEl.textContent = `${total.toFixed(2)} DT`;
}

function renderCart() {
    if (!cartItemsEl) return;
    clearElement(cartItemsEl);

    if (cart.length === 0) {
        const empty = document.createElement("div");
        empty.style.color = "#666";
        empty.style.padding = "10px 0";
        empty.textContent = "Panier vide";
        cartItemsEl.appendChild(empty);
        updateCartBadgeAndTotal();
        return;
    }

    cart.forEach((item) => {
        if (!item) return;
        console.log('Rendering cart item:', item);
        const wrap = document.createElement("div");
        wrap.className = "cart-item";

        const img = document.createElement("img");
        img.className = "cart-thumb";
        img.alt = "";
        img.src = item.img ? `${item.img}` : "";

        const right = document.createElement("div");

        const title = document.createElement("div");
        title.className = "cart-item-title";
        title.textContent = item.name;

        const price = document.createElement("div");
        price.className = "cart-item-price";
        const unit = safeNumber(item.price);
        price.textContent = `${unit.toFixed(2)} DT`;

        const row = document.createElement("div");
        row.className = "cart-item-row";

        const comment = document.createElement("input");
        comment.className = "cart-comment";
        comment.type = "text";
        comment.placeholder = "Votre commentaire...";
        comment.value = item.comment || "";
        comment.addEventListener("input", function () {
            item.comment = this.value;
            persistCart();
        });

        const removeBtn = document.createElement("button");
        removeBtn.className = "cart-remove";
        removeBtn.type = "button";
        removeBtn.textContent = "Supprimer";
        removeBtn.addEventListener("click", () => removeFromCart(item.id));

        row.appendChild(comment);
        row.appendChild(removeBtn);

        right.appendChild(title);
        right.appendChild(price);
        right.appendChild(row);

        wrap.appendChild(img);
        wrap.appendChild(right);
        cartItemsEl.appendChild(wrap);
    });

    updateCartBadgeAndTotal();
}

function normalizeCategoryName(value) {
    if (!value) return "";
    return String(value).trim();
}

function isAllCategory(value) {
    const v = normalizeCategoryName(value).toLowerCase();
    return v === "tous" || v === "all";
}

function createCard(product) {
    const article = document.createElement("article");
    article.className = "card";
    const productKey = getProductKey(product);

    const img = document.createElement("img");
    img.className = "card_img";
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = `${product.img}`;
    img.addEventListener("click", () => openCaractereModal(product));

    const meta = document.createElement("div");
    meta.className = "card__meta";

    const title = document.createElement("div");
    title.className = "card_title";
    title.textContent = product.idname;

    const price = document.createElement("div");
    price.className = "card_price";
    price.textContent = `${product.price} DT`;

    meta.appendChild(title);
    meta.appendChild(price);

    const food = document.createElement("div");
    food.className = "card_food";

    const textarea = document.createElement("textarea");
    textarea.placeholder = "Taper votre comentaire";
    textarea.dataset.productKey = productKey;

    const button = document.createElement("button");
    button.className = "btn btn--primary add-btn";
    const productId = product?.id ?? product?.idprod ?? product?.idproduct ?? product?.idname ?? "";
    if (productId) button.dataset.id = productId;
    button.dataset.productKey = productKey;
    button.textContent = "Ajouter au panier";
    button.addEventListener("click", () => {
        addToCart(product, textarea.value);
        textarea.value = "";
        showToast(`${product.idname} ajouté au panier ✅`);
    });

    food.appendChild(button);
    food.appendChild(textarea);
    

    article.appendChild(img);
    article.appendChild(meta);
    article.appendChild(food);

    return article;
}

function renderCategoryButtons() {
    clearElement(categoryContainer);


    categories.forEach((cat) => {
        const btn = document.createElement("button");
        btn.className = "cat";
        btn.dataset.name = cat.idcat;
        btn.textContent = cat.idcat;
        categoryContainer.appendChild(btn);
    });

    const btns = categoryContainer.querySelectorAll(".cat");
    btns.forEach((btn) => {
        btn.addEventListener("click", function () {
            selectedCategory = normalizeCategoryName(this.dataset.name);
            btns.forEach((b) => b.classList.remove("active"));
            this.classList.add("active");
            renderProducts();
        });
    });

    const initialBtn = Array.from(btns).find((b) => normalizeCategoryName(b.dataset.name) === selectedCategory);
    (initialBtn || btns[0])?.classList.add("active");
}

function isDisplayableProduct(p) {
    if (p == null) return false;
    const price = Number(p.price);
    if (isNaN(price) || price === 0) return false;
    const img = p && p.img;
    return !(img === null || img === undefined || String(img).trim() === "");
}

function renderProducts() {
    clearElement(productContainer);

    const q = String(searchQuery || "").trim().toLowerCase();
    const visibleProducts = products.filter(isDisplayableProduct);
    const filteredProducts = q
        ? visibleProducts.filter((p) => {
              const name = normalizeCategoryName(p.idname).toLowerCase();
              const cat = normalizeCategoryName(p.idcat).toLowerCase();
              return name.includes(q) || cat.includes(q);
          })
        : visibleProducts;

    if (isAllCategory(selectedCategory)) {
        titleEl.textContent = "";
        productContainer.classList.add("grouped");

        const order = categories.map((c) => c.idcat);
        const grouped = new Map();

        filteredProducts.forEach((p) => {
            const key = normalizeCategoryName(p.idcat);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(p);
        });

        const keys = [];
        order.forEach((k) => {
            if (grouped.has(k)) keys.push(k);
        });
        grouped.forEach((_v, k) => {
            if (!keys.includes(k)) keys.push(k);
        });

        keys.forEach((catName) => {
            const section = document.createElement("section");
            section.className = "cat-section";

            const h = document.createElement("h2");
            h.className = "cat-title";
            h.textContent = catName;

            const grid = document.createElement("div");
            grid.className = "cat-grid";

            grouped.get(catName).forEach((p) => {
                grid.appendChild(createCard(p));
            });

            section.appendChild(h);
            section.appendChild(grid);
            productContainer.appendChild(section);
        });

        return;
    }

    productContainer.classList.remove("grouped");
    titleEl.textContent = selectedCategory;

    filteredProducts
        .filter((p) => normalizeCategoryName(p.idcat) === selectedCategory)
        .forEach((p) => {
            productContainer.appendChild(createCard(p));
        });
}

async function sendOrder() {
    console.log('Attempting to send order:', { cart, numtable });
    if (!demanderBtn) return;
    if (cart.length === 0) {
        showToast("Votre panier est vide");
        return;
    }

    const totale = cart.reduce((sum, item) => sum + safeNumber(item.price), 0);
    const items = cart.map((item) => ({
        idname: item.name,
        optionn: item.comment && String(item.comment).trim() !== "" ? String(item.comment) : null,
    }));

    const prevText = demanderBtn.textContent;
    demanderBtn.disabled = true;
    demanderBtn.textContent = "Vérification...";

    try {
        const isLocationValid = await verifierLocalisation();

        if (isLocationValid) {
            pendingOrderItems = items;
            pendingOrderTotal = totale;

            setCartOpen(false);
            showPaymentModal();
        }
    } catch (_err) {
        console.error("Error in sendOrder:", _err);
        showToast("Erreur de vérification. Veuillez réessayer.");
    } finally {
        demanderBtn.disabled = false;
        demanderBtn.textContent = prevText;
    }
}

async function submitOrderToBackend() {
    if (!pendingOrderItems || pendingOrderItems.length === 0) {
        throw new Error("No pending order");
    }

    const res = await fetch("/demander", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            totale: pendingOrderTotal,
            items: pendingOrderItems,
            numtable
        }),
    });

    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Request failed (${res.status})`);
    }

    const data = await res.json();
    if (!data || data.success !== true) {
        throw new Error("Server returned error");
    }

    lastOrderIdrecu = data.idrecu;
    lastOrderTotal = pendingOrderTotal;

    return data.idrecu;
}
/* ===== Payment Modal Functions ===== */

function setModal(modal, overlay, isOpen) {
  if (!modal || !overlay) return;
  modal.classList.toggle("open", isOpen);
  overlay.classList.toggle("open", isOpen);
  modal.setAttribute("aria-hidden", String(!isOpen));
  overlay.setAttribute("aria-hidden", String(!isOpen));
}

async function fetchActivePromotion() {
  const now = Date.now();
  if (promotionCache.data && (now - promotionCache.ts) < PROMOTION_CACHE_TTL) {
    return promotionCache.data;
  }
  try {
    const res = await fetch('/api/promotions/active');
    const data = await res.json();
    promotionCache = { data, ts: now };
    return data;
  } catch {
    promotionCache = { data: null, ts: now };
    return null;
  }
}

function getDiscountedTotal(originalTotal, discountPercent) {
  if (!discountPercent || discountPercent <= 0) return originalTotal;
  return Math.round(originalTotal * (100 - discountPercent) / 100 * 1000) / 1000;
}

// Format a loyalty point value to a maximum of 2 decimal places (e.g. 12.00008
// -> "12", 15.4177777773 -> "15.42"). Trailing zeros are dropped.
function formatPoints(n) {
  const num = Number(n);
  if (!isFinite(num)) return '0';
  return String(Math.round((num + Number.EPSILON) * 100) / 100);
}

function getCartItemPrice(idname) {
  const found = cart.find(i => String(i.name) === String(idname));
  return found ? safeNumber(found.price) : 0;
}

function getSelectedReward() {
  if (!selectedRewardId) return null;
  return (loyaltyCustomerInfo?.rewards || []).find(r => !r.isRedeemed && String(r.id) === String(selectedRewardId)) || null;
}

function getFreeItemIdname() {
  const r = getSelectedReward();
  return (r && r.rewardType === 'free_item' && r.productId) ? String(r.productId) : null;
}

// Full list of lines sent to the backend: the paid cart lines PLUS the
// free product (auto-added as a real order line so the serveur receives it).
// The free item carries its chosen option and is written at 0.00 DT.
function getOrderItems() {
  const base = Array.isArray(pendingOrderItems) ? pendingOrderItems : [];
  const freeName = getFreeItemIdname();
  if (!freeName) return base;

  const exists = base.some(it => String(it.idname) === freeName);
  if (exists) {
    return base.map(it => String(it.idname) === freeName
      ? { ...it, optionn: selectedFreeOption || it.optionn || null }
      : it);
  }
  return [...base, { idname: freeName, optionn: selectedFreeOption || null, free: true }];
}

// Base (undiscounted) total of the items that will actually be charged,
// excluding any free product granted by the selected reward.
function getOrderBaseTotal() {
  const freeName = getFreeItemIdname();
  if (!freeName) return pendingOrderTotal;
  return (pendingOrderItems || [])
    .filter(it => String(it.idname) !== freeName)
    .reduce((sum, it) => sum + (getCartItemPrice(it.idname) || 0), 0);
}

// Single source of truth for the final payable amount.
// A discount reward REPLACES any active promotion (they are never combined).
function computeFinalTotal(baseTotal) {
  if (selectedRewardId && selectedRewardDiscount > 0) {
    return getDiscountedTotal(baseTotal, selectedRewardDiscount);
  }
  if (activePromotion && activePromotion.active) {
    return getDiscountedTotal(baseTotal, activePromotion.discountPercent);
  }
  return baseTotal;
}

function getEffectivePaymentTotal() {
  return computeFinalTotal(getOrderBaseTotal());
}

async function loadPromotionBanner() {
  if (!promotionBanner) return;
  try {
    const res = await fetch('/api/promotions/banner');
    const data = await res.json();
    if (data.status === 'active') {
      let text = `Promotion en cours ! -${data.discountPercent}% sur tous les achats avec la carte fidélité`;
      if (data.minimumPurchaseAmount > 0) {
        text += ` — minimum ${data.minimumPurchaseAmount} DT`;
      }
      promotionBanner.textContent = text;
      promotionBanner.className = 'promotion-banner promotion-banner--active';
      promotionBanner.style.display = 'block';
    } else if (data.status === 'soon') {
      const startDate = new Date(data.startDate).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      let text = `Bientôt disponible : -${data.discountPercent}% à partir du ${startDate}`;
      if (data.minimumPurchaseAmount > 0) {
        text += ` — minimum ${data.minimumPurchaseAmount} DT`;
      }
      promotionBanner.textContent = text;
      promotionBanner.className = 'promotion-banner promotion-banner--soon';
      promotionBanner.style.display = 'block';
    } else {
      promotionBanner.style.display = 'none';
    }
  } catch {
    promotionBanner.style.display = 'none';
  }
}

function updatePaymentTotalDisplay(originalTotal, discountPercent) {
  if (!paymentTotalAmount) return;
  if (discountPercent && discountPercent > 0) {
    const discounted = getDiscountedTotal(originalTotal, discountPercent);
    paymentTotalAmount.innerHTML = `${discounted.toFixed(3)} DT <span class="original-price">${originalTotal.toFixed(3)} DT</span>`;
  } else {
    paymentTotalAmount.textContent = `${originalTotal.toFixed(3)} DT`;
  }
}

async function loadLoyaltyConfig() {
  try {
    const res = await fetch('/api/loyalty/public/config');
    if (!res.ok) return null;
    const data = await res.json();
    loyaltyConfig = data;
    return data;
  } catch (e) {
    console.error('Failed to load loyalty config:', e);
    return null;
  }
}

function renderLoyaltyInfo(info) {
  if (!loyaltyInfoEl || !info) return;
  loyaltyInfoEl.innerHTML = '';
  loyaltyInfoEl.style.display = 'block';

  const card = info.card || {};
  const tier = info.tier;
  const nextTier = info.nextTier;
  const lifetime = Number(card.lifetimePoints || card.points || 0);
  const currentPoints = Number(card.points || 0);

  let progressHtml = '';
  if (nextTier) {
    const prevMin = tier ? Number(tier.minPoints) : 0;
    const nextMin = Number(nextTier.minPoints);
    const range = nextMin - prevMin;
    const progress = range > 0 ? Math.min(100, Math.round((lifetime - prevMin) / range * 100)) : 0;
    progressHtml = `
      <div class="loyalty-progress">
        <div class="loyalty-progress__label">
          <span>${tier ? tier.name : 'Débutant'}</span>
          <span>${nextTier.name} (${nextMin} pts)</span>
        </div>
        <div class="loyalty-progress__bar">
          <div class="loyalty-progress__fill" style="width:${progress}%;background:${tier ? (tier.color || '#c49b63') : '#c49b63'}"></div>
        </div>
        <div class="loyalty-progress__detail">${formatPoints(lifetime)} / ${nextMin} points</div>
      </div>`;
  } else {
    progressHtml = `
      <div class="loyalty-progress">
        <div class="loyalty-progress__label"><span>${tier ? tier.name : 'Niveau maximal'}</span></div>
        <div class="loyalty-progress__detail">${formatPoints(lifetime)} points cumulés — Niveau maximal atteint !</div>
      </div>`;
  }

  const tierBadgeHtml = tier
    ? `<span class="loyalty-tier-badge" style="background:${tier.color || '#c49b63'}">${tier.icon || '⭐'} ${tier.name}</span>`
    : `<span class="loyalty-tier-badge loyalty-tier-badge--default">⭐ Débutant</span>`;

  loyaltyInfoEl.innerHTML = `
    <div class="loyalty-info__header">
      ${tierBadgeHtml}
      <div class="loyalty-info__name">${card.name || 'Client'}</div>
    </div>
    <div class="loyalty-info__points">
      <span class="loyalty-info__points-value">${formatPoints(currentPoints)}</span>
      <span class="loyalty-info__points-label">points disponibles</span>
    </div>
    ${progressHtml}
  `;
}

function renderRewardSelection(configRewards, earnedRewards) {
  if (!rewardSelectionEl) return;
  rewardSelectionEl.innerHTML = '';
  rewardSelectionEl.style.display = 'none';
  selectedRewardId = null;
  selectedRewardDiscount = 0;
  selectedFreeOption = null;

  if (!earnedRewards || earnedRewards.length === 0) return;

  const available = earnedRewards.filter(r => !r.isRedeemed);
  if (available.length === 0) return;

  rewardSelectionEl.style.display = 'block';

  const hasPromotion = !!(activePromotion && activePromotion.active);

  const cardsHtml = available.map(r => {
    let typeLabel = 'Récompense';
    if (r.rewardType === 'discount') typeLabel = `-${r.discountPercent}% de réduction`;
    else if (r.rewardType === 'free_item') typeLabel = r.productId ? `Article gratuit : ${r.productId} (0.00 DT)` : 'Article gratuit';
    const note = (r.rewardType === 'discount' && hasPromotion && Number(r.discountPercent || 0) > 0)
      ? `<div class="reward-note">Vous avez choisi une réduction de ${r.discountPercent}%. La promotion sera remplacée.</div>`
      : '';
    return `
      <div class="reward-card" data-reward-id="${r.id}">
        <div class="reward-card__name">${r.rewardName || r.name || 'Récompense'}</div>
        <div class="reward-card__type">${typeLabel}</div>
        ${r.mysteryResult ? `<div class="reward-card__mystery">${r.mysteryResult}</div>` : ''}
      </div>
      ${note}`;
  }).join('');

  rewardSelectionEl.innerHTML = `
    <div class="reward-selection__title">🎁 Récompenses disponibles</div>
    <div class="reward-selection__hint">Sélectionnez une récompense à appliquer (optionnel)</div>
    <div class="reward-selection__list">${cardsHtml}</div>
    <div id="rewardFreeOptions" class="reward-free-options" style="display:none;"></div>
  `;

  const freeOptionsEl = rewardSelectionEl.querySelector('#rewardFreeOptions');

  function renderFreeOptionPicker(info) {
    if (!freeOptionsEl) return;
    selectedFreeOption = null;
    const freeName = info?.productId ? String(info.productId) : null;
    if (!freeName) { freeOptionsEl.style.display = 'none'; freeOptionsEl.innerHTML = ''; return; }

    // The client types their own choice for a free reward — we do NOT show the
    // categories/articles as selectable products. The typed text is stored directly
    // in orderr.option on confirmation.
    freeOptionsEl.style.display = 'block';
    freeOptionsEl.innerHTML = `
      <div class="reward-free-options__hint">Article gratuit : <strong>${freeName}</strong> (0.00 DT)</div>
      <label class="reward-free-options__label" for="rewardFreeChoice">Votre choix :</label>
      <textarea id="rewardFreeChoice" class="reward-free-options__textarea" rows="2" placeholder="Cappuccino, Express, etc."></textarea>
    `;
    const textarea = freeOptionsEl.querySelector('#rewardFreeChoice');
    textarea.addEventListener('input', () => {
      selectedFreeOption = textarea.value && String(textarea.value).trim() !== '' ? String(textarea.value).trim() : null;
      refreshConfirmButton();
    });
    refreshConfirmButton();
  }

  rewardSelectionEl.querySelectorAll('.reward-card').forEach(card => {
    card.addEventListener('click', () => {
      const wasSelected = card.classList.contains('selected');
      rewardSelectionEl.querySelectorAll('.reward-card').forEach(c => c.classList.remove('selected'));
      if (wasSelected) {
        selectedRewardId = null;
        selectedRewardDiscount = 0;
        selectedFreeOption = null;
        if (freeOptionsEl) { freeOptionsEl.style.display = 'none'; freeOptionsEl.innerHTML = ''; }
      } else {
        card.classList.add('selected');
        selectedRewardId = card.dataset.rewardId;
        const info = available.find(r => String(r.id) === String(card.dataset.rewardId));
        selectedRewardDiscount = info && info.rewardType === 'discount' ? Number(info.discountPercent || 0) : 0;
        selectedFreeOption = null;
        if (info && info.rewardType === 'free_item') {
          renderFreeOptionPicker(info);
        } else if (freeOptionsEl) {
          freeOptionsEl.style.display = 'none';
          freeOptionsEl.innerHTML = '';
        }
      }
      refreshConfirmButton();
    });
  });
}

function refreshConfirmButton() {
  if (!confirmPaymentBtn) return;
  const eff = getEffectivePaymentTotal();
  confirmPaymentBtn.textContent = `Confirmer le paiement — ${eff.toFixed(3)} DT`;
}

function resetLoyaltyUI() {
  if (loyaltyInfoEl) { loyaltyInfoEl.style.display = 'none'; loyaltyInfoEl.innerHTML = ''; }
  if (rewardSelectionEl) { rewardSelectionEl.style.display = 'none'; rewardSelectionEl.innerHTML = ''; }
  if (confirmPaymentBtn) confirmPaymentBtn.style.display = 'none';
  selectedRewardId = null;
  selectedRewardDiscount = 0;
  selectedFreeOption = null;
  pendingQrId = null;
  loyaltyCustomerInfo = null;
}

async function showPaymentModal() {
  setModal(paymentModal, paymentOverlay, true);
  const promo = await fetchActivePromotion();
  if (promo && promo.active) {
    activePromotion = promo;
    const meetsMinimum = !promo.minimumPurchaseAmount || pendingOrderTotal >= promo.minimumPurchaseAmount;
    if (meetsMinimum) {
      if (discountBanner) {
        let bannerText = `🎉 Promotion ! -${promo.discountPercent}% sur tous les achats avec la carte fidélité`;
        if (promo.minimumPurchaseAmount) {
          bannerText += ` (min. ${promo.minimumPurchaseAmount} DT)`;
        }
        discountBanner.textContent = bannerText;
        discountBanner.className = 'discount-banner';
        discountBanner.style.display = 'block';
      }
      updatePaymentTotalDisplay(pendingOrderTotal, promo.discountPercent);
    } else {
      activePromotion = null;
      if (discountBanner) {
        discountBanner.textContent = `⚠️ Promotion de -${promo.discountPercent}% disponible — montant minimum : ${promo.minimumPurchaseAmount} DT (votre panier : ${pendingOrderTotal.toFixed(2)} DT)`;
        discountBanner.className = 'discount-banner discount-banner--warning';
        discountBanner.style.display = 'block';
      }
      updatePaymentTotalDisplay(pendingOrderTotal, 0);
    }
  } else {
    activePromotion = null;
    if (discountBanner) discountBanner.style.display = 'none';
    updatePaymentTotalDisplay(pendingOrderTotal, 0);
  }
}

function hidePaymentModal(keepPending) {
  setModal(paymentModal, paymentOverlay, false);
  if (!keepPending) {
    pendingOrderItems = null;
    pendingOrderTotal = 0;
  }
}

function showQrModal() {
  setModal(paymentModal, paymentOverlay, false);
  qrResult.className = "qr-result";
  qrResult.textContent = "";
  qrResult.style.display = "none";
  qrCameraError.style.display = "none";
  qrCameraError.textContent = "";
  qrTorchOn = false;
  setTorchButton(false);
  if (qrFlashBtn) qrFlashBtn.style.display = "none";
  if (qrRetryBtn) qrRetryBtn.style.display = "none";
  resetLoyaltyUI();
  setModal(qrModal, qrOverlay, true);
}

function hideQrModal() {
  stopQrScanner();
  setModal(qrModal, qrOverlay, false);
  resetLoyaltyUI();
  pendingOrderItems = null;
  pendingOrderTotal = 0;
}

function showCashModal() {
  setModal(paymentModal, paymentOverlay, false);
  setModal(cashModal, cashOverlay, true);
}

function hideCashModal() {
  setModal(cashModal, cashOverlay, false);
}

/* ===== QR Code Camera Scanner ===== */

function startQrScanner() {
  if (qrScannerRunning || qrStartPromise) return;

  qrStartPromise = (async () => {
    try {
      if (await isNativeQrSupported()) {
        try {
          await startNativeQrScanner();
        } catch (nativeErr) {
          console.warn("[QR] native path failed, falling back to html5:", nativeErr);
          await loadHtml5QrcodeLib();
          await startHtml5QrScanner();
        }
      } else {
        await loadHtml5QrcodeLib();
        await startHtml5QrScanner();
      }
      qrScannerRunning = true;
      qrCameraError.style.display = "none";
      refreshFlashButton();
    } catch (err) {
      console.error("[QR] camera start failed:", err);
      const detail = (err && err.message) ? " (" + err.message + ")" : "";
      qrCameraError.textContent = "Impossible d'accéder à la caméra. Vérifiez les autorisations." + detail;
      qrCameraError.style.display = "block";
      if (qrRetryBtn) qrRetryBtn.style.display = "block";
      stopQrScanner();
    } finally {
      qrStartPromise = null;
    }
  })();

  return qrStartPromise;
}

function loadHtml5QrcodeLib() {
  if (window.Html5Qrcode) return Promise.resolve();
  if (html5QrcodeLibPromise) return html5QrcodeLibPromise;

  html5QrcodeLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js";
    s.async = true;
    s.onload = () => (window.Html5Qrcode ? resolve() : reject(new Error("Html5Qrcode missing")));
    s.onerror = () => reject(new Error("Scanner library failed to load"));
    document.head.appendChild(s);
  });

  return html5QrcodeLibPromise;
}

async function requestCameraStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Caméra non disponible (connexion non sécurisée ou navigateur non supporté)");
  }
  const attempts = [
    { video: { facingMode: "environment" }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      console.warn("[QR] getUserMedia attempt failed:", JSON.stringify(constraints), err && err.name, err && err.message);
    }
  }
  throw lastErr || new Error("Camera access denied");
}

async function isNativeQrSupported() {
  if (typeof window === "undefined" || !("BarcodeDetector" in window)) return false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    return Array.isArray(formats) && formats.includes("qr_code");
  } catch {
    return false;
  }
}

async function startNativeQrScanner() {
  if (qrScannerRunning) return;

  const container = document.getElementById("qr-reader");
  if (!container) throw new Error("qr-reader missing");
  clearElement(container);

  const video = document.createElement("video");
  video.id = "qr-native-video";
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.setAttribute("autoplay", "");
  container.appendChild(video);
  qrNativeVideo = video;

  qrNativeDetector = new BarcodeDetector({ formats: ["qr_code"] });

  const stream = await requestCameraStream();
  qrNativeStream = stream;
  video.srcObject = stream;
  await video.play();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const drawAndDetect = () => {
    if (!qrNativeStream || !qrNativeVideo || qrNativeInFlight) { scheduleNext(); return; }
    if (qrNativeVideo.readyState < 2) { scheduleNext(); return; }
    const vw = qrNativeVideo.videoWidth;
    const vh = qrNativeVideo.videoHeight;
    if (!vw || !vh) { scheduleNext(); return; }
    canvas.width = Math.min(640, vw);
    canvas.height = Math.max(1, Math.round(canvas.width * vh / vw));
    ctx.drawImage(qrNativeVideo, 0, 0, canvas.width, canvas.height);
    qrNativeInFlight = true;
    qrNativeDetector.detect(canvas)
      .then((codes) => {
        if (codes && codes.length > 0 && qrNativeStream) {
          onQrScanned(codes[0].rawValue);
        }
      })
      .catch(() => {})
      .finally(() => {
        qrNativeInFlight = false;
        scheduleNext();
      });
  };

  const scheduleNext = () => {
    if (!qrNativeStream) return;
    if (qrNativeVideo && typeof qrNativeVideo.requestVideoFrameCallback === "function") {
      qrNativeRafId = qrNativeVideo.requestVideoFrameCallback(drawAndDetect);
    } else {
      qrNativeRafId = requestAnimationFrame(drawAndDetect);
    }
  };

  scheduleNext();
}

async function startHtml5QrScanner() {
  if (qrScannerRunning) return;
  if (typeof Html5Qrcode === "undefined") throw new Error("Html5Qrcode not loaded");

  const container = document.getElementById("qr-reader");
  if (container) clearElement(container);

  html5QrCode = new Html5Qrcode("qr-reader");

  const config = {
    fps: 30,
    qrbox: (viewfinderWidth, viewfinderHeight) => {
      const minDim = Math.min(viewfinderWidth, viewfinderHeight);
      const size = Math.floor(minDim * 0.72);
      return { width: size, height: size };
    },
    formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
    disableFlip: true,
  };

  await html5QrCode.start(
    { facingMode: "environment" },
    config,
    onQrScanned,
    (errorMessage) => { console.log("[QR] scan error:", errorMessage); }
  );
}

function stopQrScanner() {
  if (html5QrCode && qrScannerRunning) {
    try {
      html5QrCode.stop().then(() => {
        try { html5QrCode.clear(); } catch {}
        qrScannerRunning = false;
      }).catch(() => { qrScannerRunning = false; });
    } catch (e) {
      qrScannerRunning = false;
    }
  }

  if (qrNativeVideo && qrNativeRafId) {
    try {
      if (typeof qrNativeVideo.cancelVideoFrameCallback === "function") {
        qrNativeVideo.cancelVideoFrameCallback(qrNativeRafId);
      } else {
        cancelAnimationFrame(qrNativeRafId);
      }
    } catch {}
  }
  qrNativeRafId = null;

  if (qrNativeStream) {
    try {
      qrNativeStream.getTracks().forEach((t) => t.stop());
    } catch {}
    qrNativeStream = null;
  }

  if (qrNativeVideo) {
    try { qrNativeVideo.srcObject = null; } catch {}
    qrNativeVideo = null;
  }

  qrNativeDetector = null;
  qrNativeInFlight = false;
  setTorchOff();
  if (qrFlashBtn) qrFlashBtn.style.display = "none";
  qrScannerRunning = false;
}

function setTorchButton(on) {
  if (!qrFlashBtn) return;
  qrFlashBtn.classList.toggle("on", on);
  qrFlashBtn.textContent = on ? "💡 Flash : ON" : "💡 Flash";
}

function setTorchOff() {
  if (!qrTorchOn) return;
  qrTorchOn = false;
  setTorchButton(false);
  if (qrNativeStream) {
    const track = qrNativeStream.getVideoTracks()[0];
    if (track && track.getCapabilities && track.getCapabilities().torch) {
      track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
    }
  } else if (html5QrCode && qrScannerRunning) {
    html5QrCode.applyVideoConstraints({ advanced: [{ torch: false }] }).catch(() => {});
  }
}

async function toggleTorch() {
  try {
    const next = !qrTorchOn;
    if (qrNativeStream) {
      const track = qrNativeStream.getVideoTracks()[0];
      if (!track || !track.getCapabilities || !track.getCapabilities().torch) {
        showToast("Flashlight non supporté sur cet appareil");
        return;
      }
      await track.applyConstraints({ advanced: [{ torch: next }] });
    } else if (html5QrCode && qrScannerRunning) {
      const caps = html5QrCode.getRunningTrackCapabilities ? html5QrCode.getRunningTrackCapabilities() : null;
      if (!caps || !caps.torch) {
        showToast("Flashlight non supporté sur cet appareil");
        return;
      }
      await html5QrCode.applyVideoConstraints({ advanced: [{ torch: next }] });
    } else {
      showToast("Caméra non active");
      return;
    }
    qrTorchOn = next;
    setTorchButton(next);
  } catch (err) {
    console.warn("[torch] toggle failed:", err);
    showToast("Flashlight non supporté sur cet appareil");
    qrTorchOn = false;
    setTorchButton(false);
  }
}

function refreshFlashButton() {
  if (!qrFlashBtn) return;
  let supported = false;
  if (qrNativeStream) {
    const track = qrNativeStream.getVideoTracks()[0];
    supported = !!(track && track.getCapabilities && track.getCapabilities().torch);
  } else if (html5QrCode) {
    try {
      const caps = html5QrCode.getRunningTrackCapabilities ? html5QrCode.getRunningTrackCapabilities() : null;
      supported = !!(caps && caps.torch);
    } catch {
      supported = false;
    }
  }
  qrFlashBtn.style.display = qrScannerRunning && supported ? "block" : "none";
  if (!supported) {
    qrTorchOn = false;
    setTorchButton(false);
  }
}

function onQrScanned(decodedText) {
  if (!decodedText || !decodedText.trim()) return;
  console.log("[QR] scanned:", decodedText);
  stopQrScanner();
  const qrValue = decodedText.trim();
  verifyQrCode(qrValue);
}

async function handleCardPayment() {
  hidePaymentModal(true);
  showQrModal();
  setTimeout(() => startQrScanner(), 300);
}

async function handleCashPayment() {
  hidePaymentModal(true);
  try {
    await submitOrderToBackend();
    showCashModal();
  } catch (err) {
    console.error("Error creating order:", err);
    showToast("Erreur lors de la création de la commande. Veuillez réessayer.");
    pendingOrderItems = null;
    pendingOrderTotal = 0;
  }
}

function extractToken(input) {
  if (!input) return null;
  const str = input.trim();
  const urlMatch = str.match(/\/loyalty\/([a-f0-9]{24})/i);
  if (urlMatch) return urlMatch[1];
  if (/^[a-f0-9]{24}$/i.test(str)) return str;
  return null;
}

async function verifyQrCode(qrId) {
  qrId = extractToken(qrId);
  if (!qrId) {
    qrResult.className = "qr-result error";
    qrResult.textContent = "Aucun QR code détecté. Veuillez scanner la carte.";
    qrResult.style.display = "block";
    qrCameraError.style.display = "none";
    return;
  }

  qrResult.className = "qr-result loading";
  qrResult.textContent = "Vérification en cours...";
  qrResult.style.display = "block";
  resetLoyaltyUI();

  try {
    const tokenRes = await fetch(`/api/loyalty/token/${qrId}`);
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.points && tokenData.points !== 0) {
      qrResult.className = "qr-result error";
      qrResult.textContent = tokenData.error === "NOT_FOUND"
        ? "Client introuvable. Veuillez réessayer ou contacter le gérant."
        : "Erreur de vérification. Veuillez réessayer.";
      qrResult.style.display = "block";
      qrCameraError.style.display = "none";
      return;
    }

    // Load customer loyalty info + earned rewards BEFORE the points check so we
    // can factor an available discount reward into the affordable total.
    try {
      const loyaltyRes = await fetch(`/api/loyalty/public/customer/${qrId}`);
      if (loyaltyRes.ok) {
        loyaltyCustomerInfo = await loyaltyRes.json();
      }
    } catch (e) {
      console.warn("Could not load loyalty info:", e);
    }

    // Best-case total the customer could reach with their best available discount
    // reward. A discount reward REPLACES any active promotion (never combined).
    const availDiscount = (loyaltyCustomerInfo?.rewards || [])
      .filter(r => !r.isRedeemed && r.rewardType === 'discount' && Number(r.discountPercent || 0) > 0)
      .reduce((best, r) => Math.max(best, Number(r.discountPercent)), 0);
    const rewardAwareTotal = availDiscount > 0
      ? getDiscountedTotal(pendingOrderTotal, availDiscount)
      : (activePromotion && activePromotion.active
          ? getDiscountedTotal(pendingOrderTotal, activePromotion.discountPercent)
          : pendingOrderTotal);

    if (tokenData.points < rewardAwareTotal) {
      qrResult.className = "qr-result error";
      qrResult.textContent = `Points insuffisants. Solde: ${formatPoints(tokenData.points)} DT, Total: ${rewardAwareTotal.toFixed(3)} DT. Veuillez recharger votre carte.`;
      qrResult.style.display = "block";
      qrCameraError.style.display = "none";
      return;
    }

    pendingQrId = qrId;
    qrResult.className = "qr-result success";
    qrResult.textContent = "Carte vérifiée !";
    qrResult.style.display = "block";
    qrCameraError.style.display = "none";

    if (loyaltyCustomerInfo) {
      renderLoyaltyInfo(loyaltyCustomerInfo);
      renderRewardSelection(loyaltyConfig?.rewards || [], loyaltyCustomerInfo?.rewards || []);
    }

    if (confirmPaymentBtn) {
      confirmPaymentBtn.textContent = `Confirmer le paiement — ${getEffectivePaymentTotal().toFixed(3)} DT`;
      confirmPaymentBtn.style.display = "block";
    }

  } catch (err) {
    console.error(err);
    qrResult.className = "qr-result error";
    qrResult.textContent = "Erreur de connexion. Veuillez réessayer.";
    qrResult.style.display = "block";
  }
}

async function processCardPaymentWithReward() {
  if (!pendingQrId) return;

  const orderItems = getOrderItems();
  const orderBaseTotal = getOrderBaseTotal();
  const displayTotal = computeFinalTotal(orderBaseTotal);

  if (confirmPaymentBtn) confirmPaymentBtn.disabled = true;
  qrResult.textContent = "Traitement du paiement en cours...";
  qrResult.style.display = "block";

  try {
    const body = {
      qrId: pendingQrId,
      numtable,
      items: orderItems,
      total: orderBaseTotal
    };
    if (selectedRewardId) {
      body.rewardId = selectedRewardId;
    }

    const payRes = await fetch("/process-card-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const payData = await payRes.json();

    if (!payData.success) {
      qrResult.className = "qr-result error";
      if (payData.error === "INSUFFICIENT_POINTS") {
        qrResult.textContent = "Points insuffisants. Veuillez recharger votre carte.";
      } else {
        qrResult.textContent = "Erreur de paiement. Veuillez réessayer.";
      }
      qrResult.style.display = "block";
      return;
    }

    let earnedPoints = 0;
    if (loyaltyCustomerInfo && loyaltyCustomerInfo.card) {
      const oldPoints = Number(loyaltyCustomerInfo.card.points || 0);
      const newPoints = Math.max(0, oldPoints - displayTotal);
      earnedPoints = displayTotal;
    }

    qrResult.className = "qr-result success";
    qrResult.innerHTML = `Paiement réussi ! Merci de votre visite.`;
    qrResult.style.display = "block";

    if (loyaltyCustomerInfo && loyaltyCustomerInfo.card) {
      const newBalance = Math.max(0, Number(loyaltyCustomerInfo.card.points || 0) - displayTotal);
      const loyaltySummary = document.createElement('div');
      loyaltySummary.className = 'loyalty-summary';
      loyaltySummary.innerHTML = `
        <div class="loyalty-summary__row">
          <span>Débit:</span><span>-${formatPoints(displayTotal)} DT</span>
        </div>
        <div class="loyalty-summary__row">
          <span>Nouveau solde:</span><span>${formatPoints(newBalance)} DT</span>
        </div>
        ${selectedRewardId ? '<div class="loyalty-summary__reward">🎁 Récompense appliquée</div>' : ''}
      `;
      qrResult.appendChild(loyaltySummary);
    }

    cart = [];
    pendingOrderItems = null;
    pendingOrderTotal = 0;
    persistCart();
    renderCart();

    setTimeout(() => {
      hideQrModal();
    }, 3000);
  } catch (err) {
    console.error(err);
    qrResult.className = "qr-result error";
    qrResult.textContent = "Erreur de connexion. Veuillez réessayer.";
    qrResult.style.display = "block";
  } finally {
    if (confirmPaymentBtn) confirmPaymentBtn.disabled = false;
  }
}

/* ===== End Payment Modal Functions ===== */

function verifierLocalisation() {
    return new Promise((resolve) => {
        console.log("Attempting to get user location...");

        if (!navigator.geolocation) {
            console.log("GPS non disponible");
            showToast("Geolocation is not supported by your browser");
            resolve(false);
            return;
        }

        const MAX_RETRIES = 60;
        let attempt = 0;
        let waitingToastShown = false;

        const tryGetPosition = () => {
            attempt++;
            console.log("Requesting user location... (attempt " + attempt + ")");

            navigator.geolocation.getCurrentPosition(
                async (position) => {
                    const latitude = position.coords.latitude;
                    const longitude = position.coords.longitude;

                    console.log("Latitude:", latitude);
                    console.log("Longitude:", longitude);

                    try {
                        const response = await fetch("/verify-location", {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                latitude,
                                longitude
                            })
                        });

                        const data = await response.json();

                        if (data.authorized) {
                            resolve(true);
                        } else {
                            console.log("Position refusée par le serveur");
                            showToast("Please entre to the coffe");
                            resolve(false);
                        }
                    } catch (error) {
                        console.log("Erreur serveur:", error);
                        showToast("Server error during location verification");
                        resolve(false);
                    }
                },
                (error) => {
                    console.log("GPS refusé ou erreur:", error);

                    if (error.code === 1) {
                        showToast("Location is blocked. To confirm your order you must allow GPS access in your browser settings.");
                        resolve(false);
                        return;
                    }

                    if (!waitingToastShown) {
                        waitingToastShown = true;
                        showToast("En attente du GPS... Veuillez activer votre localisation.");
                    }

                    if (attempt < MAX_RETRIES) {
                        setTimeout(tryGetPosition, 1500);
                    } else {
                        showToast("Unable to verify your location. Veuillez réessayer.");
                        resolve(false);
                    }
                },
                {
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 0
                }
            );
        };

        tryGetPosition();
    });
}

Promise.all([fetch("/getdata").then((r) => r.json()), fetch("/product").then((r) => r.json())])
    .then(([cats, prods]) => {
        console.log("Fetched categories 1:", cats);
        categories = Array.isArray(cats) ? cats : [];
        products = Array.isArray(prods) ? prods : [];
        // If categories endpoint returned nothing, derive categories from products
        if ((!categories || categories.length === 0) && Array.isArray(products) && products.length > 0) {
            const unique = Array.from(new Set(products.map((p) => normalizeCategoryName(p.idcat)))).filter(Boolean);
            categories = unique.map((idcat) => ({ idcat }));
        }

        // Ensure a 'Tous' (All) category is present so the UI can show grouped view
        if (!categories.find((c) => normalizeCategoryName(c.idcat).toLowerCase() === 'tous')) {
            categories.unshift({ idcat: 'Tous' });
        }

        loadPersistedState();

        if (searchInput) {
            searchInput.addEventListener("input", function () {
                searchQuery = this.value;
                renderProducts();
            });
        }

        if (openCartBtn) openCartBtn.addEventListener("click", () => setCartOpen(true));
        if (closeCartBtn) closeCartBtn.addEventListener("click", () => setCartOpen(false));
        if (cartOverlay) cartOverlay.addEventListener("click", () => setCartOpen(false));
        if (demanderBtn) demanderBtn.addEventListener("click", sendOrder);

        // Payment modal events
        if (paymentClose) paymentClose.addEventListener("click", hidePaymentModal);
        if (paymentOverlay) paymentOverlay.addEventListener("click", hidePaymentModal);
        if (payCardBtn) payCardBtn.addEventListener("click", handleCardPayment);
        if (payCashBtn) payCashBtn.addEventListener("click", handleCashPayment);

        // QR modal events
        if (qrClose) qrClose.addEventListener("click", hideQrModal);
        if (qrOverlay) qrOverlay.addEventListener("click", hideQrModal);
        if (confirmPaymentBtn) confirmPaymentBtn.addEventListener("click", processCardPaymentWithReward);
        if (qrFlashBtn) qrFlashBtn.addEventListener("click", toggleTorch);
        if (qrRetryBtn) {
          qrRetryBtn.addEventListener("click", function () {
            if (qrRetryBtn) qrRetryBtn.style.display = "none";
            qrCameraError.style.display = "none";
            startQrScanner();
          });
        }

        // Cash modal events
        const handleCashConfirm = async () => {
          const cashTotal = activePromotion && activePromotion.active
            ? getDiscountedTotal(lastOrderTotal, activePromotion.discountPercent)
            : lastOrderTotal;
          try {
            await fetch("/process-cash-payment", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ idrecu: lastOrderIdrecu, total: cashTotal })
            });
          } catch {}
          hideCashModal();
          cart = [];
          pendingOrderItems = null;
          pendingOrderTotal = 0;
          persistCart();
          renderCart();
        };
        if (cashOk) cashOk.addEventListener("click", handleCashConfirm);
        if (cashOverlay) cashOverlay.addEventListener("click", handleCashConfirm);
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") setCartOpen(false);
        });

        renderCategoryButtons();
        renderProducts();
        renderCart();
        loadPromotionBanner();
        loadLoyaltyConfig();
    })
    .catch(() => {
        // on fetch failure keep persisted data and attempt to derive categories from persisted products
        categories = [];
        products = [];
        loadPersistedState();
        if (Array.isArray(products) && products.length > 0) {
            const unique = Array.from(new Set(products.map((p) => normalizeCategoryName(p.idcat)))).filter(Boolean);
            categories = unique.map((idcat) => ({ idcat }));
            if (!categories.find((c) => normalizeCategoryName(c.idcat).toLowerCase() === 'tous')) {
                categories.unshift({ idcat: 'Tous' });
            }
        }
        renderCategoryButtons();
        renderProducts();
        renderCart();
    })
