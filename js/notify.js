// Notifications GOANGEL : cartes élégantes (succès, erreur, avertissement, information), accessibles, sans fenêtre native du navigateur.
export const NETWORK_MSG = "Impossible de joindre le serveur GOANGEL. Vérifiez votre connexion internet puis réessayez dans un instant.";

export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = "ApiError"; this.status = status; }
}

const ICON = { success: "✓", error: "✕", warning: "!", info: "i" };
const TITLE = { success: "Opération réussie", error: "Une erreur est survenue", warning: "Attention", info: "Information" };
const DURATION = { success: 5500, info: 6500, warning: 9000, error: 11000 };
let lastKey = "", lastAt = 0;

function root() {
  let r = document.getElementById("notify-root");
  if (!r) {
    r = document.createElement("div"); r.id = "notify-root"; r.className = "notify-root";
    r.setAttribute("aria-live", "polite"); r.setAttribute("aria-atomic", "false");
    document.body.appendChild(r);
  }
  return r;
}

/** Affiche une notification. type : "success" | "error" | "warning" | "info". */
export function notify(type, message, opts = {}) {
  type = ICON[type] ? type : "info";
  const key = type + "|" + message;
  if (key === lastKey && Date.now() - lastAt < 3000) return null;      // évite les doublons en rafale
  lastKey = key; lastAt = Date.now();
  const r = root();
  while (r.children.length >= 4) r.firstChild.remove();
  const ms = opts.duration || DURATION[type];
  const el = document.createElement("div");
  el.className = "ntf ntf-" + type;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  const ico = document.createElement("span"); ico.className = "ntf-ico"; ico.setAttribute("aria-hidden", "true"); ico.textContent = ICON[type];
  const body = document.createElement("div"); body.className = "ntf-body";
  const t = document.createElement("div"); t.className = "ntf-title"; t.textContent = opts.title || TITLE[type];
  const m = document.createElement("div"); m.className = "ntf-msg"; m.textContent = message;
  body.append(t, m);
  const x = document.createElement("button"); x.className = "ntf-x"; x.type = "button"; x.setAttribute("aria-label", "Fermer la notification"); x.textContent = "×";
  const bar = document.createElement("i"); bar.className = "ntf-bar"; bar.style.animationDuration = ms + "ms";
  el.append(ico, body, x, bar);
  const close = () => { el.classList.add("ntf-out"); setTimeout(() => el.remove(), 220); };
  let timer = setTimeout(close, ms);
  x.onclick = close;
  el.addEventListener("mouseenter", () => { clearTimeout(timer); bar.style.animationPlayState = "paused"; });
  el.addEventListener("mouseleave", () => { bar.style.animationPlayState = "running"; timer = setTimeout(close, 2500); });
  r.appendChild(el);
  return el;
}

/** Transforme n'importe quelle erreur technique en message français clair. */
export function friendlyError(e, opts = {}) {
  const fallback = "Une erreur est survenue. Réessayez dans un instant.";
  if (!e) return fallback;
  if (e instanceof ApiError) return e.message;
  const code = String(e.code || ""), msg = String(e.message || "");
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg) || /network-request-failed|unavailable|deadline-exceeded/.test(code)) return NETWORK_MSG;
  if (/permission-denied/.test(code) || /missing or insufficient permissions/i.test(msg))
    return opts.admin ? "Écriture refusée par les règles de sécurité Firestore. Publiez le fichier firestore.rules (console Firebase → Firestore → Règles), puis réessayez."
                      : "Action non autorisée pour ce compte. Reconnectez-vous ou contactez le support.";
  if (/unauthenticated/.test(code)) return "Votre session a expiré : reconnectez-vous.";
  if (code && /^[a-z-]+$/.test(code)) return fallback;                    // autre code technique Firebase : jamais affiché tel quel
  return msg || fallback;
}
