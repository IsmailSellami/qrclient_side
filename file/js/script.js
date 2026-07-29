
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
const qrInput = document.getElementById("qrInput");
const qrVerifyBtn = document.getElementById("qrVerifyBtn");
const qrResult = document.getElementById("qrResult");
const qrManualToggle = document.getElementById("qrManualToggle");
const qrManualSection = document.getElementById("qrManualSection");
const qrCameraError = document.getElementById("qrCameraError");

let html5QrCode = null;
let qrScannerRunning = false;

const cashOverlay = document.getElementById("cashOverlay");
const cashModal = document.getElementById("cashModal");
const cashOk = document.getElementById("cashOk");

const discountBanner = document.getElementById("discountBanner");
const paymentTotalAmount = document.getElementById("paymentTotalAmount");

let lastOrderIdrecu = null;
let lastOrderTotal = 0;
let activePromotion = null;
let pendingOrderItems = null;
let pendingOrderTotal = 0;

const PROMOTION_CACHE_TTL = 60000;
let promotionCache = { data: null, ts: 0 };

const caractereOverlay = document.getElementById("caractereOverlay");
const caractereModal = document.getElementById("caractereModal");
const caractereClose = document.getElementById("caractereClose");
const caractereImg = document.getElementById("caractereImg");
const caractereOptions = document.getElementById("caractereOptions");
const promotionBanner = document.getElementById("promotionBanner");
const params = new URLSearchParams(window.location.search);
const numtable = Number(params.get("table")) || 12;

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

function renderProducts() {
    clearElement(productContainer);

    const q = String(searchQuery || "").trim().toLowerCase();
    const filteredProducts = q
        ? products.filter((p) => {
              const name = normalizeCategoryName(p.idname).toLowerCase();
              const cat = normalizeCategoryName(p.idcat).toLowerCase();
              return name.includes(q) || cat.includes(q);
          })
        : products;

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
  qrInput.value = "";
  qrManualSection.classList.remove("visible");
  setModal(qrModal, qrOverlay, true);
}

function hideQrModal() {
  stopQrScanner();
  qrManualSection.classList.remove("visible");
  setModal(qrModal, qrOverlay, false);
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
  if (qrScannerRunning) return;
  if (typeof Html5Qrcode === "undefined") {
    qrCameraError.textContent = "Erreur de chargement du scanner. Utilisez la saisie manuelle.";
    qrCameraError.style.display = "block";
    qrManualSection.classList.add("visible");
    return;
  }

  try {
    html5QrCode = new Html5Qrcode("qr-reader");
  } catch (e) {
    qrCameraError.textContent = "Impossible d'initialiser le scanner. Utilisez la saisie manuelle.";
    qrCameraError.style.display = "block";
    qrManualSection.classList.add("visible");
    return;
  }

  const config = {
    fps: 15,
    qrbox: { width: 220, height: 220 },
  };

  html5QrCode.start(
    { facingMode: "environment" },
    config,
    onQrScanned,
    (errorMessage) => { console.log("[QR] scan error:", errorMessage); }
  ).then(() => {
    qrScannerRunning = true;
    console.log("[QR] camera started");
  }).catch((err) => {
    console.error("[QR] camera start failed:", err);
    qrCameraError.textContent = "Impossible d'accéder à la caméra. Vérifiez les autorisations ou utilisez la saisie manuelle.";
    qrCameraError.style.display = "block";
    qrManualSection.classList.add("visible");
    html5QrCode = null;
  });
}

function stopQrScanner() {
  if (html5QrCode && qrScannerRunning) {
    try {
      html5QrCode.stop().then(() => {
        html5QrCode.clear();
        qrScannerRunning = false;
        console.log("[QR] camera stopped");
      }).catch(() => {});
    } catch (e) {
      console.warn("[QR] stop error:", e);
    }
  }
  qrScannerRunning = false;
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
    console.log(qrId);
    console.log('Verifying QR code:', !qrId);
  if (!qrId) {
    qrId = extractToken(qrInput.value);
  } else {
    qrId = extractToken(qrId);
  }
  if (!qrId) {
    qrResult.className = "qr-result error";
    qrResult.textContent = "Veuillez saisir un identifiant valide.";
    qrResult.style.display = "block";
    qrCameraError.style.display = "none";
    qrVerifyBtn.disabled = false;
    return;
  }

  qrResult.className = "qr-result loading";
  qrResult.textContent = "Vérification en cours...";
  qrResult.style.display = "block";
  qrVerifyBtn.disabled = true;

  const paymentTotal = activePromotion && activePromotion.active
    ? getDiscountedTotal(pendingOrderTotal, activePromotion.discountPercent)
    : pendingOrderTotal;

  try {
    const res = await fetch("/verify-qr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qrId, total: paymentTotal })
    });

    const data = await res.json();

    if (!data.success) {
      if (data.error === "CUSTOMER_NOT_FOUND") {
        qrResult.className = "qr-result error";
        qrResult.textContent = "Client introuvable. Veuillez réessayer ou contacter le gérant.";
      } else if (data.error === "INSUFFICIENT_POINTS") {
        qrResult.className = "qr-result error";
        qrResult.textContent = "Points insuffisants. Veuillez recharger votre carte.";
      } else {
        qrResult.className = "qr-result error";
        qrResult.textContent = "Erreur de vérification. Veuillez réessayer.";
      }
      qrResult.style.display = "block";
      qrCameraError.style.display = "none";
      return;
    }

    let displayMessage = "";
    if (data.discount) {
      displayMessage = `Réduction de ${data.discount.percent}% appliquée ! (${data.discount.originalTotal.toFixed(3)} DT → ${data.discount.discountedTotal.toFixed(3)} DT)\n`;
    }

    qrResult.className = "qr-result loading";
    qrResult.textContent = "Création de la commande...";
    qrResult.style.display = "block";

    await submitOrderToBackend();

    const payRes = await fetch("/process-card-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qrId, idrecu: lastOrderIdrecu, total: paymentTotal })
    });

    const payData = await payRes.json();
    console.log(payData);
    if (!payData.success) {
      qrResult.className = "qr-result error";
      if (payData.error === "INSUFFICIENT_POINTS") {
        qrResult.textContent = "Points insuffisants. Veuillez recharger votre carte.";
      } else {
        qrResult.textContent = "Erreur de paiement. Veuillez réessayer.";
      }
      qrResult.style.display = "block";
      qrCameraError.style.display = "none";
      return;
    }

    qrResult.className = "qr-result success";
    qrResult.textContent = displayMessage + "Paiement réussi ! Merci de votre visite.";
    qrResult.style.display = "block";
    qrCameraError.style.display = "none";

    cart = [];
    pendingOrderItems = null;
    pendingOrderTotal = 0;
    persistCart();
    renderCart();

    setTimeout(() => {
      hideQrModal();
    }, 2500);
  } catch (err) {
    console.error(err);
    qrResult.className = "qr-result error";
    qrResult.textContent = "Erreur de connexion. Veuillez réessayer.";
    qrResult.style.display = "block";
  } finally {
    qrVerifyBtn.disabled = false;
  }
}

/* ===== End Payment Modal Functions ===== */

async function verifierLocalisation() {
    return new Promise((resolve) => {
        console.log("Attempting to get user location...");
        
        if (!navigator.geolocation) {
            console.log("GPS non disponible");
            showToast("Geolocation is not supported by your browser");
            resolve(false);
            return;
        }
        
        console.log("Requesting user location...");

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
                let errorMessage = "Unable to verify location. ";
                if (error.code === 1) {
                    errorMessage += "To confirme your order you must allow GPS.";
                } 
                 else if (error.code === 3) {
                    errorMessage += "Location request timeout.";
                }
                showToast(errorMessage);
                resolve(false);
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 0
            }
        );
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
        if (qrVerifyBtn) qrVerifyBtn.addEventListener("click", () => verifyQrCode());
        if (qrInput) {
          qrInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") verifyQrCode();
          });
        }
        if (qrManualToggle) {
          qrManualToggle.addEventListener("click", function () {
            const isVisible = qrManualSection.classList.toggle("visible");
            this.textContent = isVisible ? "Scanner avec la caméra" : "Saisir manuellement";
            if (isVisible) {
              stopQrScanner();
              setTimeout(() => qrInput.focus(), 100);
            } else {
              startQrScanner();
            }
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
