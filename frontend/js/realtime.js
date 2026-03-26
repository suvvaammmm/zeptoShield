/**
 * ZeptoShield Real-Time Client
 * ─────────────────────────────
 * Handles:
 *  • Session token storage / retrieval
 *  • Authenticated fetch wrapper
 *  • WebSocket connection with auto-reconnect
 *  • Event bus for live updates
 */

const API_BASE = "http://localhost:5000";
const WS_URL   = "ws://localhost:5000";

// ── Session ──────────────────────────────────────────────────────────────────
const ZS_AUTH = {
  getToken()    { return localStorage.getItem("zs_token"); },
  getPhone()    { return localStorage.getItem("zs_phone"); },
  getIsAdmin()  { return localStorage.getItem("zs_admin") === "true"; },
  getWorker()   { try { return JSON.parse(localStorage.getItem("zs_worker")); } catch { return null; } },

  save({ token, phone, isAdmin, worker }) {
    if (token)  localStorage.setItem("zs_token",  token);
    if (phone)  localStorage.setItem("zs_phone",  phone);
    localStorage.setItem("zs_admin",  isAdmin ? "true" : "false");
    if (worker) localStorage.setItem("zs_worker", JSON.stringify(worker));
  },

  clear() {
    ["zs_token","zs_phone","zs_admin","zs_worker"].forEach(k => localStorage.removeItem(k));
  },

  isLoggedIn() { return !!this.getToken(); },
};

// ── Authenticated fetch ───────────────────────────────────────────────────────
async function apiFetch(method, path, body = null, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = ZS_AUTH.getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(API_BASE + path, opts);
    const data = await res.json();
    if (res.status === 401) {
      // Token expired — redirect to login
      ZS_AUTH.clear();
      window.location.href = "/pages/login.html";
      return null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`[API] ${method} ${path} failed:`, err.message);
    return { ok: false, status: 0, data: { error: "Network error — is the server running?" } };
  }
}

// ── Event bus ─────────────────────────────────────────────────────────────────
const ZS_EVENTS = {
  _listeners: {},
  on(event, cb)  {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(cb);
  },
  off(event, cb) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(f => f !== cb);
  },
  emit(event, data) {
    (this._listeners[event] || []).forEach(cb => cb(data));
    (this._listeners["*"] || []).forEach(cb => cb({ event, data }));
  },
};

// ── WebSocket real-time connection ────────────────────────────────────────────
const ZS_WS = {
  ws:             null,
  reconnectDelay: 2000,
  reconnectTimer: null,
  connected:      false,

  connect() {
    if (this.ws && this.ws.readyState < 2) return; // already open/connecting

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 2000;
        clearTimeout(this.reconnectTimer);
        ZS_EVENTS.emit("ws_connected");
        console.log("[WS] Connected");
      };

      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          // Emit the event type so listeners can react
          ZS_EVENTS.emit(msg.type, msg);
          ZS_EVENTS.emit("ws_message", msg);
        } catch {}
      };

      this.ws.onclose = () => {
        this.connected = false;
        ZS_EVENTS.emit("ws_disconnected");
        console.log("[WS] Disconnected — reconnecting in", this.reconnectDelay, "ms");
        this.reconnectTimer = setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
          this.connect();
        }, this.reconnectDelay);
      };

      this.ws.onerror = (err) => {
        console.warn("[WS] Error:", err.message || "connection failed");
      };
    } catch (err) {
      console.warn("[WS] Could not connect:", err.message);
    }
  },

  disconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  },
};

// ── Guard: redirect to login if not authenticated ─────────────────────────────
function requireLogin(redirectBack = true) {
  if (!ZS_AUTH.isLoggedIn()) {
    const back = redirectBack ? `?next=${encodeURIComponent(location.pathname + location.search)}` : "";
    location.href = `/pages/login.html${back}`;
    return false;
  }
  return true;
}

// ── Guard: redirect to login if not admin ─────────────────────────────────────
function requireAdmin() {
  if (!ZS_AUTH.isLoggedIn() || !ZS_AUTH.getIsAdmin()) {
    location.href = "/pages/login.html?mode=admin";
    return false;
  }
  return true;
}

// ── WS connection indicator (small dot in UI) ─────────────────────────────────
function attachConnectionIndicator(dotElId) {
  const dot = document.getElementById(dotElId);
  if (!dot) return;
  ZS_EVENTS.on("ws_connected",    () => { dot.style.background = "var(--success)"; dot.title = "Live"; });
  ZS_EVENTS.on("ws_disconnected", () => { dot.style.background = "var(--warn)";    dot.title = "Reconnecting…"; });
}

// ── Toast utility ─────────────────────────────────────────────────────────────
function showToast(msg, type = "", duration = 3500) {
  let toast = document.getElementById("zs-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "zs-toast";
    toast.style.cssText = `
      position:fixed; bottom:24px; right:24px; z-index:9999;
      background:var(--ink); color:var(--white);
      font-family:var(--sans); font-size:0.835rem; font-weight:500;
      padding:12px 20px; border-radius:10px;
      box-shadow:0 8px 32px rgba(0,0,0,0.2);
      max-width:340px; line-height:1.4;
      transform:translateY(80px); opacity:0;
      transition:transform 0.25s, opacity 0.25s;
    `;
    document.body.appendChild(toast);
  }
  if (type === "success") toast.style.background = "var(--success)";
  else if (type === "warn") toast.style.background = "#b45309";
  else if (type === "error") toast.style.background = "#b91c1c";
  else toast.style.background = "var(--ink)";

  toast.textContent = msg;
  toast.style.transform = "translateY(0)";
  toast.style.opacity   = "1";

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.transform = "translateY(80px)";
    toast.style.opacity   = "0";
  }, duration);
}

// Start WS connection immediately
ZS_WS.connect();

// Expose globally
window.ZS_AUTH   = ZS_AUTH;
window.ZS_WS     = ZS_WS;
window.ZS_EVENTS = ZS_EVENTS;
window.apiFetch  = apiFetch;
window.showToast = showToast;
window.requireLogin = requireLogin;
window.requireAdmin = requireAdmin;
window.attachConnectionIndicator = attachConnectionIndicator;
