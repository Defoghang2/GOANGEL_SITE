import { auth, db } from "./firebase-config.js";
import { notify, ApiError, NETWORK_MSG, friendlyError } from "./notify.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc, deleteDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const API = "https://api.goangel.dpdns.org";
const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => /^https:\/\//i.test(u || "") ? u : "#";
const packsCol = collection(db, "packs");
const mediaCol = collection(db, "media");
const trackCol = collection(db, "track_record");
const revCol = collection(db, "testimonials");

// --- Système de confirmation personnalisé ---
function showConfirm(title, message) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    modal.classList.remove("hidden");
    const btnOk = $("confirm-ok"), btnCancel = $("confirm-cancel");
    const cleanup = () => { modal.classList.add("hidden"); btnOk.removeEventListener("click", onOk); btnCancel.removeEventListener("click", onCancel); };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    btnOk.addEventListener("click", onOk);
    btnCancel.addEventListener("click", onCancel);
  });
}

// --- API backend (jeton Firebase ; le serveur vérifie le claim admin) ---
async function adminApi(path, method = "GET", body) {
  const token = await auth.currentUser.getIdToken();
  let res;
  try {
    res = await fetch(API + path, { method, cache: "no-store", headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new ApiError(NETWORK_MSG, 0); }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new ApiError(data && typeof data.detail === "string" ? data.detail
    : res.status === 422 ? "Les informations envoyées sont invalides." : "Le serveur a rencontré un problème (code " + res.status + "). Réessayez dans un instant.", res.status);
  return data;
}
const fail = (e, title) => notify("error", friendlyError(e, { admin: true }), { title });

function showDenied() { $("admin-denied").classList.remove("hidden"); $("admin-content").classList.add("hidden"); }
function showContent() {
  $("admin-content").classList.remove("hidden"); $("admin-denied").classList.add("hidden");
  loadPacks(); loadMedia(); loadSocial(); loadStock();
}

// ---------- Téléchargement gratuit (admin) ----------
async function adminDownload(productId, file) {
  const st = $("sync-status");
  try {
    const r = await adminApi("/api/admin/download-token", "POST", { product_id: productId, ...(file ? { file } : {}) });
    const a = document.createElement("a"); a.href = API + r.url; a.rel = "noopener"; a.download = ""; a.style.display = "none";
    document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
    notify("success", "Le fichier " + (file || "du pack « " + productId + " »") + " est en cours de téléchargement (accès administrateur gratuit).", { title: "Téléchargement lancé" });
  } catch (e) { fail(e, "Téléchargement impossible"); }
}

// ---------- Catalogue & stock ----------
let lastView = null;
let promoFormFilled = false;
const STATE_LABEL = { available: "✅ Disponible", unavailable: "⛔ Indisponible (épuisé)", unknown: "⚠️ Non vérifiable" };
function renderStock(v) {
  lastView = v; renderPromoState(v);
  const list = $("stock-list"); list.innerHTML = "";
  (v.products || []).forEach(p => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="item-info"><strong>${esc(p.name)} — v${esc(p.version)} — ${esc(p.price_usdt)} USDT</strong>
      <small>${STATE_LABEL[p.state] || esc(p.state)}${p.recently_updated ? " · 🆕 récemment mis à jour" : ""}${p.file ? " · " + esc(p.file.name) + " (" + (p.file.size / 1048576).toFixed(1) + " Mo)" : ""}${p.archived && p.archived.length ? "<br>Anciennes versions conservées : " + esc(p.archived.join(", ")) : ""}</small></div>`;
    const acts = document.createElement("div"); acts.className = "item-actions";
    const names = [p.file ? { f: "", label: "⬇ " + p.file.name } : null, ...(p.archived || []).map(n => ({ f: n, label: "⬇ " + n }))].filter(Boolean);
    names.forEach(n => { const b = document.createElement("button"); b.className = "btn small ghost"; b.textContent = n.label; b.title = "Téléchargement gratuit (admin)"; b.addEventListener("click", () => adminDownload(p.id, n.f)); acts.appendChild(b); });
    li.appendChild(acts);
    list.appendChild(li);
  });
  if (!(v.products || []).length) list.innerHTML = '<li class="muted">Aucun produit.</li>';
  $("unlisted-box").textContent = v.unlisted && v.unlisted.length
    ? "Fichiers présents dans le stockage mais absents du catalogue (nom à rapprocher d'un produit) : " + v.unlisted.join(", ") : "";
  const st = $("sync-status");
  const age = v.checked_age_seconds;
  if (v.storage === "ok") {
    const fresh = age !== null && age < 30;
    st.textContent = fresh ? `✅ Synchronisation automatique active : stockage vérifié il y a ${Math.round(age)} s (toutes les ${v.poll_seconds} s)`
      : v.last_error ? `⚠️ Le stockage ne répond pas (${v.last_error}). Dernière vérification réussie il y a ${v.last_ok_age === null ? "—" : Math.round(v.last_ok_age)} s ; nouvelles tentatives automatiques.`
      : "⚠️ Aucune vérification récente du stockage : le serveur relance la surveillance automatiquement.";
    st.style.color = fresh ? "var(--pos)" : "var(--gold)";
  } else { st.textContent = "⚠️ Stockage : " + (v.error || v.storage) + " — nouvelle tentative automatique en cours"; st.style.color = "var(--err)"; }
}
async function loadStock() { try { renderStock(await adminApi("/api/admin/catalog")); } catch (e) { const st = $("sync-status"); st.textContent = "⚠️ " + friendlyError(e, { admin: true }); st.style.color = "var(--err)"; } }
async function syncNow(quiet) {
  const st = $("sync-status");
  if (!quiet) { st.textContent = "Synchronisation en cours…"; st.style.color = "var(--gold)"; }
  try { renderStock(await adminApi("/api/admin/sync", "POST")); if (!quiet) notify("success", "Le catalogue a été vérifié à l'instant.", { title: "Vérification terminée" }); } catch (e) { st.textContent = "⚠️ " + friendlyError(e, { admin: true }); st.style.color = "var(--err)"; if (!quiet) fail(e, "Vérification impossible"); }
}
$("sync-btn").addEventListener("click", () => syncNow(false));
setInterval(() => { if (!document.hidden && !$("admin-content").classList.contains("hidden")) loadStock(); }, 5000);   // état en direct


// ---------- Code promo & bandeau (Firestore settings/promo, lu par le backend) ----------
function fillPromoForm(v) {
  const c = v.promo_config || {};
  const sel = $("promo-pack");
  sel.innerHTML = '<option value="">Tous les packs</option>' + (v.products || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  $("promo-enabled").value = c.enabled === true ? "true" : "false";
  $("promo-code").value = c.code || "";
  $("promo-percent").value = c.percent || "";
  sel.value = c.pack || "";
  $("promo-message").value = c.message || "";
  $("promo-banner").value = c.banner === false ? "false" : "true";
  $("promo-expires").value = c.expires ? String(c.expires).slice(0, 10) : "";
  promoFormFilled = true;
}
function renderPromoState(v) {
  if (!promoFormFilled && v.promo_config) fillPromoForm(v);
  const el = $("promo-state"), src = v.promo_source === "admin" ? "définie ici" : "valeur par défaut de catalog.json";
  const cfg = v.promo_config || {};
  if (v.promo) {
    const pk = (v.products || []).find(p => p.id === v.promo.pack_id);
    el.textContent = `✅ Offre ACTIVE (${src}) : code ${v.promo.code}, -${v.promo.percent} % sur ${pk ? "le pack " + pk.name : "tous les packs"}, bandeau ${v.promo.banner ? "affiché" : "masqué"}.`;
    el.style.color = "var(--pos)";
  } else {
    el.textContent = cfg.enabled ? `⛔ Offre configurée mais inactive (${src}) : date dépassée ou réglages invalides.` : `⛔ Aucune offre active (${src}) : ni bandeau ni code ne fonctionnent.`;
    el.style.color = "var(--err)";
  }
  $("promo-toggle").textContent = v.promo ? "Désactiver l'offre" : "Activer l'offre";
}
async function savePromo(data, okMsg) {
  try {
    const v = await adminApi("/api/admin/promo", "POST", data);
    promoFormFilled = false; renderStock(v);
    notify("success", okMsg || (v.promo ? `L'offre « ${v.promo.code} » (-${v.promo.percent} %) est active.` : "L'offre est enregistrée et désactivée."), { title: "Offre enregistrée" });
  } catch (e) { fail(e, "Enregistrement impossible"); }
}
$("promo-form-admin").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("promo-code").value.trim().toUpperCase(), pct = Number($("promo-percent").value);
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) { notify("warning", "Le code doit contenir de 3 à 30 caractères (lettres, chiffres, tiret ou souligné), sans espace.", { title: "Code invalide" }); return; }
  if (!(pct >= 1 && pct <= 90)) { notify("warning", "La réduction doit être comprise entre 1 et 90 %.", { title: "Réduction invalide" }); return; }
  await savePromo({ enabled: $("promo-enabled").value === "true", code, percent: pct, pack: $("promo-pack").value,
    message: $("promo-message").value.trim(), banner: $("promo-banner").value === "true", expires: $("promo-expires").value || "" });
});
$("promo-toggle").addEventListener("click", async () => {
  if (!lastView) return;
  const cfg = { ...(lastView.promo_config || {}) }, turnOff = !!lastView.promo;
  await savePromo({ enabled: !turnOff, code: cfg.code || "", percent: cfg.percent || 0, pack: cfg.pack || "", message: cfg.message || "",
    banner: cfg.banner !== false, expires: cfg.expires || "" }, turnOff ? "L'offre est désactivée : le bandeau disparaît et le code n'est plus accepté." : "L'offre est de nouveau active.");
});

// ---------- Packs / produits ----------
function resetPackForm() {
  $("pack-form").reset(); $("pack-id").value = "";
  $("pack-submit").textContent = "Ajouter le pack"; $("pack-cancel").style.display = "none";
}

async function loadPacks() {
  try {
    const snapshot = await getDocs(query(packsCol, orderBy("name")));
    const list = $("pack-list");
    list.innerHTML = "";
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="item-info">
          <strong>${esc(data.name)} - ${esc(data.price)} USDT${data.featured ? " ⭐" : ""}${data.hidden ? " (masqué)" : ""}</strong>
          <small>${esc((data.features || []).join(", "))}</small>
        </div>
        <div class="item-actions">
          <button class="btn small ghost edit-pack" data-id="${esc(docSnap.id)}">Modifier</button>
          <button class="btn small btn-danger delete-pack" data-id="${esc(docSnap.id)}">Supprimer</button>
        </div>`;
      list.appendChild(li);
    });
    list.querySelectorAll(".edit-pack").forEach(b => b.addEventListener("click", () => editPack(b.dataset.id)));
    list.querySelectorAll(".delete-pack").forEach(b => b.addEventListener("click", () => deletePack(b.dataset.id)));
  } catch (e) { console.error(e); }
}

async function editPack(id) {
  const docSnap = await getDoc(doc(packsCol, id));
  if (!docSnap.exists()) return;
  const data = docSnap.data();
  $("pack-id").value = id;
  $("pack-name").value = data.name || "";
  $("pack-price").value = data.price || "";
  $("pack-features").value = (data.features || []).join("\n");
  $("pack-featured").value = data.featured ? "true" : "false";
  $("pack-tagline").value = data.tagline || "";
  $("pack-version").value = data.version || "";
  $("pack-requirements").value = (data.requirements || []).join("\n");
  $("pack-long").value = data.long_description || "";
  $("pack-visible").value = data.hidden ? "false" : "true";
  $("pack-submit").textContent = "Mettre à jour";
  $("pack-cancel").style.display = "inline-block";
  $("pack-form").scrollIntoView({ behavior: "smooth" });
}

async function deletePack(id) {
  if (await showConfirm("Supprimer le pack", "Voulez-vous vraiment supprimer cette fiche ? Un produit de catalog.json reviendra à sa version d'origine.")) {
    await deleteDoc(doc(packsCol, id)); loadPacks(); syncNow(true);
  }
}

$("pack-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("pack-id").value;
  const lines = v => v.split("\n").map(s => s.trim()).filter(Boolean);
  const name = $("pack-name").value.trim();
  const price = Number($("pack-price").value);
  const features = lines($("pack-features").value);
  if (!name || !(price > 0) || price > 5000 || features.length === 0) return;
  const payload = {
    name, price, features,
    featured: $("pack-featured").value === "true",
    tagline: $("pack-tagline").value.trim(),
    version: $("pack-version").value.trim(),
    requirements: lines($("pack-requirements").value),
    long_description: $("pack-long").value.trim(),
    hidden: $("pack-visible").value === "false"
  };
  try {
    if (id) await updateDoc(doc(packsCol, id), payload); else await addDoc(packsCol, payload);
    resetPackForm(); loadPacks(); syncNow(true);
  } catch (err) { fail(err, "Enregistrement impossible"); return; }
  notify("success", "La fiche du pack est enregistrée.", { title: "Pack enregistré" });
});
$("pack-cancel").addEventListener("click", resetPackForm);

// ---------- Médias ----------
async function loadMedia() {
  try {
    const snapshot = await getDocs(mediaCol);
    const list = $("media-list");
    list.innerHTML = "";
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const li = document.createElement("li");
      const info = data.type === "text" ? "texte" : `${esc(data.type)} - ${((data.size || 0) / 1024).toFixed(1)} KB`;
      li.innerHTML = `
        <div class="item-info">
          <strong>${esc(data.description || data.type)}</strong>
          <small>${info}</small>
        </div>
        <div class="item-actions">
          ${data.url ? `<a href="${esc(safeUrl(data.url))}" target="_blank" rel="noopener" class="btn small ghost">Voir</a>` : ""}
          <button class="btn small btn-danger delete-media" data-id="${esc(docSnap.id)}">Supprimer</button>
        </div>`;
      list.appendChild(li);
    });
    list.querySelectorAll(".delete-media").forEach(b => b.addEventListener("click", () => deleteMedia(b.dataset.id)));
  } catch (e) { console.error(e); }
}
async function deleteMedia(id) {
  if (await showConfirm("Supprimer le média", "Voulez-vous vraiment retirer ce contenu du site ? (Un fichier envoyé reste stocké sur Cloudinary)")) {
    await deleteDoc(doc(mediaCol, id)); loadMedia();
  }
}

function syncMediaType() {
  const isText = $("media-type").value === "text";
  $("file-group").classList.toggle("hidden", isText);
  $("text-group").classList.toggle("hidden", !isText);
}
$("media-type").addEventListener("change", syncMediaType);
syncMediaType();

$("media-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const type = $("media-type").value;
  const desc = $("media-desc").value.trim();
  const statusEl = $("media-status");
  const inl = (m) => { statusEl.textContent = m; statusEl.style.color = "var(--err)"; };
  try {
    if (type === "text") {
      const text = $("media-text").value.trim();
      if (!text) return inl("⚠️ Saisissez un texte.");
      await addDoc(mediaCol, { type, description: desc, text, createdAt: new Date().toISOString() });
    } else {
      const file = $("media-file").files[0];
      if (!file) return inl("⚠️ Choisissez un fichier.");
      if (file.size > 20 * 1024 * 1024) return inl("⚠️ Fichier trop lourd (> 20 Mo). Utilisez un lien externe.");
      statusEl.textContent = "Téléversement en cours..."; statusEl.style.color = "var(--gold)";
      const formData = new FormData();
      formData.append("file", file);
      formData.append("upload_preset", "goangel_unsigned");
      const response = await fetch("https://api.cloudinary.com/v1_1/gkiui3xc/auto/upload", { method: "POST", body: formData });
      if (!response.ok) throw new Error("Erreur Cloudinary");
      const data = await response.json();
      await addDoc(mediaCol, { type, description: desc, url: data.secure_url, size: file.size, createdAt: new Date().toISOString() });
    }
    $("media-form").reset(); syncMediaType();
    statusEl.textContent = ""; notify("success", "Le contenu est publié et visible par tous les utilisateurs.", { title: "Contenu publié" });
    loadMedia();
  } catch (error) { statusEl.textContent = ""; fail(error, "Publication impossible"); }
});

// ---------- Track record et témoignages (lus et écrits par le serveur) ----------
const TR = { win: "Gagné", loss: "Perdu", pending: "En attente" };
async function loadSocial() {
  try {
    const s = await adminApi("/api/admin/social");
    const tl = $("track-list"); tl.innerHTML = "";
    s.track.forEach(r => {
      const li = document.createElement("li");
      li.innerHTML = `<div class="item-info"><strong>${esc(r.match)}</strong><small>${esc(r.date)} · ${esc(r.pick)} · ${esc(r.confidence)} %</small></div>
        <div class="item-actions"><select data-id="${esc(r.id)}" class="tr-status" aria-label="Statut">${Object.keys(TR).map(k => `<option value="${k}"${r.status === k ? " selected" : ""}>${TR[k]}</option>`).join("")}</select>
        <button class="btn small btn-danger" data-del="${esc(r.id)}">Supprimer</button></div>`;
      tl.appendChild(li);
    });
    tl.querySelectorAll(".tr-status").forEach(sel => sel.addEventListener("change", async () => {
      try { await adminApi("/api/admin/track/" + encodeURIComponent(sel.dataset.id) + "/status", "POST", { status: sel.value }); notify("success", "Le statut de l'analyse est mis à jour.", { title: "Statut modifié" }); }
      catch (e) { fail(e, "Modification impossible"); loadSocial(); }
    }));
    tl.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!(await showConfirm("Supprimer l'analyse", "Retirer cette ligne du track record ?"))) return;
      try { await adminApi("/api/admin/track/" + encodeURIComponent(b.dataset.del) + "/delete", "POST"); notify("success", "L'analyse a été retirée du track record.", { title: "Analyse supprimée" }); }
      catch (e) { fail(e, "Suppression impossible"); }
      loadSocial();
    }));
    const rl = $("rev-list"); rl.innerHTML = "";
    s.testimonials.forEach(r => {
      const li = document.createElement("li");
      li.innerHTML = `<div class="item-info"><strong>${esc(r.name)} — ${"★".repeat(Number(r.rating) || 0)}${r.verified === true ? " ✔ vérifié" : ""}</strong><small>${esc(r.text)}</small></div>
        <div class="item-actions"><button class="btn small btn-danger" data-del="${esc(r.id)}">Supprimer</button></div>`;
      rl.appendChild(li);
    });
    rl.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!(await showConfirm("Supprimer le témoignage", "Retirer ce témoignage du site ?"))) return;
      try { await adminApi("/api/admin/testimonial/" + encodeURIComponent(b.dataset.del) + "/delete", "POST"); notify("success", "Le témoignage a été retiré du site.", { title: "Témoignage supprimé" }); }
      catch (e) { fail(e, "Suppression impossible"); }
      loadSocial();
    }));
  } catch (e) { fail(e, "Chargement impossible"); }
}
$("track-form").addEventListener("submit", async e => {
  e.preventDefault();
  const conf = Number($("track-conf").value);
  if (!(conf >= 0 && conf <= 100)) { notify("warning", "La confiance doit être comprise entre 0 et 100 %.", { title: "Confiance invalide" }); return; }
  try {
    await adminApi("/api/admin/track", "POST", { date: $("track-date").value, match: $("track-match").value.trim(), pick: $("track-pick").value.trim(), confidence: conf, status: $("track-status").value });
    $("track-form").reset(); notify("success", "L'analyse est ajoutée au track record.", { title: "Analyse ajoutée" }); loadSocial();
  } catch (err) { fail(err, "Enregistrement impossible"); }
});
$("rev-form").addEventListener("submit", async e => {
  e.preventDefault();
  const avatar = $("rev-avatar").value.trim();
  if (avatar && !/^https:\/\//i.test(avatar)) { notify("warning", "La photo doit être un lien commençant par https://.", { title: "Photo invalide" }); return; }
  try {
    await adminApi("/api/admin/testimonial", "POST", { name: $("rev-name").value.trim(), rating: Math.max(1, Math.min(5, Number($("rev-rating").value) || 5)), text: $("rev-text").value.trim(), avatar_url: avatar, verified: $("rev-verified").value === "true" });
    $("rev-form").reset(); notify("success", "Le témoignage est publié sur le site.", { title: "Témoignage publié" }); loadSocial();
  } catch (err) { fail(err, "Enregistrement impossible"); }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("login.html"); return; }
  try {
    const r = await user.getIdTokenResult(true);
    if (r.claims.admin === true) showContent(); else showDenied();
  } catch (error) { showDenied(); }
});
