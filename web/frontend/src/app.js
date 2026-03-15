const config = window.__SCALASTREAM_CONFIG__ || {
  apiBaseUrl: "http://localhost:8080",
  streamBaseUrl: "http://localhost:8090/stream",
  streamHealthUrl: "http://localhost:8090/health",
};

const recModes = {
  recommended: { requiresUser: true, endpoint: (uid) => `/feed/recommended?userId=${encodeURIComponent(uid)}&limit=16`, label: "For You" },
  trending: { requiresUser: false, endpoint: () => "/feed/trending?limit=16", label: "Trending" },
  fresh: { requiresUser: false, endpoint: () => "/feed/fresh?limit=16", label: "Fresh" },
  continue: { requiresUser: true, endpoint: (uid) => `/feed/continue?userId=${encodeURIComponent(uid)}&limit=1`, label: "Continue Watching" },
};

const state = {
  token: localStorage.getItem("scalastream_token") || "",
  user: JSON.parse(localStorage.getItem("scalastream_user") || "null"),
  route: { view: "home", videoId: null, q: "" },
  q: "",
  videos: [],
  loadingVideos: false,
  filter: "all",
  sort: "recent",
  recMode: "recommended",
  recItems: [],
  recIds: new Set(),
  popularIds: new Set(),
  watchVideo: null,
  watchComments: [],
  watchHls: null,
  watchSession: null,
  telemetry: { t: 0, s: -1 },
  watchHistory: [],
  searchHistory: [],
  activityOpen: false,
  historyExpanded: false,
  mobileRailOpen: false,
  theme: localStorage.getItem("scalastream_theme") || "light",
  uploadQueue: [],
  autoplay: localStorage.getItem("scalastream_autoplay") === "true",
  resumePrompt: { videoId: "", seconds: 0 },
  searchBusy: false,
};

const $ = (id) => document.getElementById(id);
const refs = {
  healthBanner: $("healthBanner"),
  brandLink: $("brandLink"),
  searchForm: $("searchForm"),
  searchBtn: $("searchBtn"),
  searchInput: $("searchInput"),
  searchClearBtn: $("searchClearBtn"),
  searchSuggestPanel: $("searchSuggestPanel"),
  searchSuggestList: $("searchSuggestList"),
  mobileMenuBtn: $("mobileMenuBtn"),
  mobileMenuCloseBtn: $("mobileMenuCloseBtn"),
  mobileBackdrop: $("mobileBackdrop"),
  themeToggleBtn: $("themeToggleBtn"),
  signedOutActions: $("signedOutActions"),
  signedInActions: $("signedInActions"),
  sessionState: $("sessionState"),
  openLoginBtn: $("openLoginBtn"),
  openRegisterBtn: $("openRegisterBtn"),
  logoutBtn: $("logoutBtn"),
  railLinks: Array.from(document.querySelectorAll(".rail-link")),
  recMeta: $("recMeta"),
  retrainBtn: $("retrainBtn"),
  uploadLockHint: $("uploadLockHint"),
  uploadForm: $("uploadForm"),
  uploadTitleInput: document.querySelector('#uploadForm input[name="title"]'),
  uploadDescInput: document.querySelector('#uploadForm textarea[name="description"]'),
  videoFileInput: $("videoFileInput"),
  uploadMessage: $("uploadMessage"),
  uploadQueue: $("uploadQueue"),
  uploadProgressBar: $("uploadProgressBar"),
  uploadProgressValue: $("uploadProgressValue"),
  watchHistoryList: $("watchHistoryList"),
  searchHistoryList: $("searchHistoryList"),
  toggleActivityBtn: $("toggleActivityBtn"),
  activityBody: $("activityBody"),
  homeView: $("homeView"),
  watchView: $("watchView"),
  manageView: $("manageView"),
  homeSubhead: $("homeSubhead"),
  manageSubhead: $("manageSubhead"),
  sortSelect: $("sortSelect"),
  filterButtons: Array.from(document.querySelectorAll(".chip-filter")),
  videoGrid: $("videoGrid"),
  manageGrid: $("manageGrid"),
  metricVideos: $("metricVideos"),
  metricViews: $("metricViews"),
  metricQueue: $("metricQueue"),
  metricRecs: $("metricRecs"),
  backHomeBtn: $("backHomeBtn"),
  watchVideo: $("watchVideo"),
  playerDiag: $("playerDiag"),
  watchQualitySelect: $("watchQualitySelect"),
  watchSpeedSelect: $("watchSpeedSelect"),
  autoplayToggle: $("autoplayToggle"),
  retryPlaybackBtn: $("retryPlaybackBtn"),
  openRawBtn: $("openRawBtn"),
  watchTitle: $("watchTitle"),
  watchMetaLine: $("watchMetaLine"),
  watchDescription: $("watchDescription"),
  watchTagRow: $("watchTagRow"),
  watchLikeBtn: $("watchLikeBtn"),
  watchUnlikeBtn: $("watchUnlikeBtn"),
  watchDeleteBtn: $("watchDeleteBtn"),
  watchCommentCount: $("watchCommentCount"),
  watchCommentInput: $("watchCommentInput"),
  watchCommentBtn: $("watchCommentBtn"),
  watchComments: $("watchComments"),
  watchRecommendationList: $("watchRecommendationList"),
  resumePrompt: $("resumePrompt"),
  resumePromptText: $("resumePromptText"),
  resumeNowBtn: $("resumeNowBtn"),
  resumeStartBtn: $("resumeStartBtn"),
  authModal: $("authModal"),
  closeAuthBtn: $("closeAuthBtn"),
  loginTabBtn: $("loginTabBtn"),
  registerTabBtn: $("registerTabBtn"),
  loginForm: $("loginForm"),
  registerForm: $("registerForm"),
  authMessage: $("authMessage"),
  toast: $("toast"),
  mobileNavLinks: Array.from(document.querySelectorAll(".mobile-nav-link")),
};

let toastTimer = null;
let suggestTimer = null;
const uploadStatusPollMs = 2500;
const uploadStatusMaxPollIterations = 1200;

const esc = (v = "") =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");

const norm = (v = "") => String(v).replace(/\s+/g, " ").trim();
const nfmt = (v = 0) => new Intl.NumberFormat("en-US").format(Number(v || 0));

function normalizeBase(base, fallback) {
  let value = String(base || "").trim();
  if (!value) value = fallback;
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
  if (!value.startsWith("/")) value = `/${value}`;
  return value.replace(/\/+$/, "");
}

const streamBase = normalizeBase(config.streamBaseUrl, "/stream");
const streamHealthEndpoint = (() => {
  const explicit = String(config.streamHealthUrl || "").trim();
  if (explicit) return normalizeBase(explicit, "/stream-health");
  if (/^https?:\/\//i.test(streamBase)) return `${streamBase.replace(/\/stream\/?$/, "")}/health`;
  return "/stream-health";
})();

function streamMasterUrl(videoId) {
  return `${streamBase}/${videoId}/master.m3u8`;
}

function streamThumbnailUrl(videoId) {
  return `${streamBase}/${videoId}/thumbnail.jpg`;
}

function resolveStreamUrl(video) {
  if (!video?.id || String(video.status || "").toUpperCase() !== "READY") {
    return "";
  }
  return streamMasterUrl(video.id);
}

function resolveThumbnailUrl(video) {
  if (!video?.id || String(video.status || "").toUpperCase() !== "READY") {
    return "";
  }
  return streamThumbnailUrl(video.id);
}

function rel(iso) {
  if (!iso) return "unknown";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function dur(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds || 0)));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtClock(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds || 0)));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function uniqByVideoId(items) {
  const seen = new Set();
  const out = [];
  (items || []).forEach((item) => {
    const id = String(item?.video_id || item?.id || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(item);
  });
  return out;
}

function sid(prefix = "sess") {
  return window.crypto?.randomUUID ? `${prefix}-${window.crypto.randomUUID()}` : `${prefix}-${Date.now()}-${Math.floor(Math.random() * 99999)}`;
}

function isWeakAutoDescription(value) {
  const text = norm(value).toLowerCase();
  if (!text) return true;
  return (
    text.startsWith("auto-generated summary:") ||
    text.includes("style content with") ||
    text.includes("audio profile and")
  );
}

function bestVideoDescription(video) {
  const desc = norm(video?.description || "");
  if (!desc) return "No description provided.";
  if (isWeakAutoDescription(desc)) return "No description provided.";
  return desc;
}

function toast(msgText) {
  refs.toast.textContent = msgText;
  refs.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => refs.toast.classList.remove("show"), 2600);
}

function msg(el, text, type = "") {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "error");
  if (type) el.classList.add(type);
}

function setProgress(p) {
  const safe = Math.max(0, Math.min(100, Number(p || 0)));
  refs.uploadProgressBar.style.width = `${safe}%`;
  refs.uploadProgressValue.textContent = `${safe.toFixed(0)}%`;
}

function btnLoading(btn, loading, idle) {
  if (!btn) return;
  btn.disabled = loading;
  if (idle) btn.textContent = loading ? "Please wait..." : idle;
}

function setSession(token, user) {
  state.token = token || "";
  state.user = user || null;
  if (state.token) localStorage.setItem("scalastream_token", state.token);
  else localStorage.removeItem("scalastream_token");
  if (state.user) localStorage.setItem("scalastream_user", JSON.stringify(state.user));
  else localStorage.removeItem("scalastream_user");
  renderAuthState();
}

function api(path, options = {}, retries = 1) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return new Promise((resolve, reject) => {
    const run = async (attempt) => {
      try {
        const res = await fetch(`${config.apiBaseUrl}${path}`, { ...options, headers });
        const text = await res.text();
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch (_e) {
          body = { raw: text };
        }
        if (!res.ok) {
          const err = new Error(body.error || body.detail || body.raw || `HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }
        resolve(body);
      } catch (e) {
        const retriable = (!e.status || e.status >= 500) && attempt < retries;
        if (!retriable) return reject(e);
        setTimeout(() => run(attempt + 1), 300 + attempt * 300);
      }
    };
    run(0);
  });
}

function logClient(level, message, details = "") {
  api(
    "/internal/client-log",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, message, details, route: window.location.pathname }),
    },
    0
  ).catch(() => {});
}

async function restoreSession() {
  if (!state.token) {
    // No token found, user is logged out
    return setSession("", null);
  }
  
  try {
    // Verify token is still valid by checking with server
    const me = await api("/auth/me", { method: "GET" }, 0);
    setSession(state.token, me.user || null);
  } catch (_e) {
    // Token is invalid or server error, clear session
    console.warn("Session restore failed, clearing credentials");
    setSession("", null);
  }
}

function requireAuth(action) {
  if (state.user?.id) return true;
  msg(refs.authMessage, `${action} requires sign in.`, "error");
  openAuth("login");
  return false;
}

function parseRoute() {
  const u = new URL(window.location.href);
  const watchMatch = u.pathname.match(/^\/watch\/([A-Za-z0-9-]+)$/);
  if (watchMatch) {
    return { view: "watch", videoId: watchMatch[1], q: norm(u.searchParams.get("q") || "") };
  }
  if (u.pathname === "/search") {
    return { view: "search", videoId: null, q: norm(u.searchParams.get("q") || "") };
  }
  if (u.pathname === "/manage") {
    return { view: "manage", videoId: null, q: "" };
  }
  return { view: "home", videoId: null, q: norm(u.searchParams.get("q") || "") };
}

function homePath(q) {
  const n = norm(q);
  return n ? `/search?q=${encodeURIComponent(n)}` : "/";
}

async function navigate(path, replace = false) {
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  // Reset scroll position to top for better UX
  window.scrollTo(0, 0);
  await applyRoute();
}

function setDiag(text, type = "info") {
  const p = type === "error" ? "Playback issue" : type === "loading" ? "Loading" : "Player";
  const diagText = `${p}: ${text}`;
  refs.playerDiag.textContent = diagText;
  // Only show error messages, hide info and loading
  refs.playerDiag.style.opacity = type === "error" ? "1" : "0";
  refs.playerDiag.style.pointerEvents = type === "error" ? "auto" : "none";
}

function hideResumePrompt() {
  state.resumePrompt = { videoId: "", seconds: 0 };
  refs.resumePrompt.classList.add("hidden");
}

function findWatchHistoryEntry(videoId) {
  return state.watchHistory.find((entry) => String(entry.video_id || "") === String(videoId || "")) || null;
}

function maybeShowResumePrompt(video) {
  hideResumePrompt();
  const entry = findWatchHistoryEntry(video?.id);
  if (!entry) return;
  const seconds = Number(entry.last_watch_seconds || 0);
  const duration = Math.max(Number(video?.duration_seconds || 0), Number(entry.duration_seconds || 0), 0);
  if (!Number.isFinite(seconds) || seconds < 4) return;
  if (!Number.isFinite(duration) || duration <= 10) return;
  const progress = seconds / duration;
  if (progress <= 0.04 || progress >= 0.96) return;

  state.resumePrompt = { videoId: String(video.id), seconds };
  refs.resumePromptText.textContent = `Continue from ${fmtClock(seconds)}?`;
  refs.resumePrompt.classList.remove("hidden");
}

function setActivityOpen(open) {
  state.activityOpen = Boolean(open);
  refs.activityBody.classList.toggle("hidden", !state.activityOpen);
  refs.toggleActivityBtn.setAttribute("aria-expanded", String(state.activityOpen));
  refs.toggleActivityBtn.textContent = state.activityOpen ? "Hide" : "Show";
}

function applyTheme(theme) {
  const resolved = theme === "dark" ? "dark" : "light";
  state.theme = resolved;
  document.body.setAttribute("data-theme", resolved);
  localStorage.setItem("scalastream_theme", resolved);
  refs.themeToggleBtn.textContent = resolved === "dark" ? "Light" : "Dark";
}

function setMobileRailOpen(open) {
  state.mobileRailOpen = Boolean(open);
  if (state.mobileRailOpen && state.route.view === "watch" && !refs.watchVideo.paused) {
    refs.watchVideo.pause();
  }
  document.body.classList.toggle("mobile-rail-open", state.mobileRailOpen);
  document.body.classList.toggle("mobile-no-scroll", state.mobileRailOpen);
  refs.mobileBackdrop.classList.toggle("hidden", !state.mobileRailOpen);
  refs.mobileMenuBtn.setAttribute("aria-expanded", String(state.mobileRailOpen));
}

function applyPlayerOrientation() {
  const shell = refs.watchVideo?.closest(".watch-player-shell");
  if (!shell) return;
  const width = Number(refs.watchVideo.videoWidth || 0);
  const height = Number(refs.watchVideo.videoHeight || 0);
  const vertical = width > 0 && height > 0 && height / width >= 1.15;
  shell.classList.toggle("vertical-video", vertical);
}

function openAuth(tab = "login") {
  if (state.route.view === "watch" && !refs.watchVideo.paused) {
    refs.watchVideo.pause();
  }
  refs.authModal.classList.remove("hidden");
  refs.loginTabBtn.classList.toggle("active", tab === "login");
  refs.registerTabBtn.classList.toggle("active", tab === "register");
  refs.loginForm.classList.toggle("hidden", tab !== "login");
  refs.registerForm.classList.toggle("hidden", tab !== "register");
}

function closeAuth() {
  refs.authModal.classList.add("hidden");
}

function renderAuthState() {
  const inUser = Boolean(state.user?.id);
  refs.signedOutActions.classList.toggle("hidden", inUser);
  refs.signedInActions.classList.toggle("hidden", !inUser);
  refs.sessionState.textContent = inUser ? state.user.email : "Not signed in";
  refs.sessionState.title = inUser ? state.user.email : "";
  Array.from(refs.uploadForm.elements).forEach((el) => {
    el.disabled = !inUser;
  });
  refs.uploadLockHint.textContent = inUser ? `Upload enabled as ${state.user.email}` : "Sign in to upload and manage your videos.";
  refs.watchCommentInput.disabled = !inUser || !state.watchVideo;
  refs.watchCommentBtn.disabled = !inUser || !state.watchVideo;
}

function setNav() {
  refs.railLinks.forEach((b) => {
    let active = false;
    if (b.dataset.nav === "home") {
      active = state.route.view === "home" || state.route.view === "search";
    } else if (b.dataset.nav === "manage") {
      active = state.route.view === "manage";
    } else {
      active = b.dataset.mode === state.recMode;
    }
    b.classList.toggle("active", active);
  });
  refs.mobileNavLinks.forEach((b) => {
    let active = false;
    if (b.dataset.nav === "home") {
      active = state.route.view === "home" || state.route.view === "search";
    } else if (b.dataset.nav === "manage") {
      active = state.route.view === "manage";
    } else if (b.dataset.mode) {
      active = b.dataset.mode === state.recMode && (state.route.view === "home" || state.route.view === "search");
    }
    b.classList.toggle("active", active);
  });
}

function updateMetrics() {
  refs.metricVideos.textContent = nfmt(state.videos.length);
  refs.metricViews.textContent = nfmt(state.videos.reduce((s, v) => s + Number(v.view_count || 0), 0));
  refs.metricQueue.textContent = nfmt(state.uploadQueue.filter((q) => String(q.status).toUpperCase() !== "READY").length);
  refs.metricRecs.textContent = nfmt(state.recIds.size);
}

function patchVideo(videoId, patch) {
  state.videos = state.videos.map((v) => (v.id === videoId ? { ...v, ...patch } : v));
  if (state.watchVideo?.id === videoId) state.watchVideo = { ...state.watchVideo, ...patch };
}

function canDeleteVideo(video) {
  if (!state.user?.id || !video) return false;
  if (typeof video.can_delete === "boolean") return Boolean(video.can_delete);
  return Boolean(video.owner_id && video.owner_id === state.user.id);
}

function renderUploadQueue() {
  refs.uploadQueue.innerHTML = "";
  state.uploadQueue.forEach((q) => {
    const st = String(q.status || "").toLowerCase();
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="queue-main">
        <strong>${esc(q.title || "Untitled")}</strong>
        <span>(${esc(String(q.videoId || "").slice(0, 8))}...)</span>
        <span class="queue-status ${st.includes("ready") ? "ready" : st.includes("fail") ? "failed" : st.includes("process") ? "processing" : "uploaded"}">${esc(q.status || "")}</span>
        <span>attempts: ${Number(q.attempts || 0)}</span>
      </div>
      ${q.error ? `<div class="queue-error">${esc(q.error)}</div>` : ""}
      <div class="queue-actions">${String(q.status).toUpperCase() === "FAILED" ? `<button class="queue-action retry-btn" data-video-id="${esc(q.videoId)}" data-title="${esc(q.title || "")}">Retry</button>` : ""}</div>
    `;
    refs.uploadQueue.appendChild(li);
  });
  updateMetrics();
}

function setQueue(videoId, title, status, attempts = 0, error = "") {
  const i = state.uploadQueue.findIndex((q) => q.videoId === videoId);
  const payload = { videoId, title, status, attempts, error };
  if (i === -1) state.uploadQueue.unshift(payload);
  else state.uploadQueue[i] = payload;
  state.uploadQueue = state.uploadQueue.slice(0, 8);
  renderUploadQueue();
}

function uploadStatusLabel(st) {
  const status = String(st?.status || "").toUpperCase();
  const pos = Number(st?.queue_position || 0);
  const total = Number(st?.queue_total || 0);
  if (status === "UPLOADED" && pos > 1) {
    return `UPLOADED (queued #${pos} of ${total || pos})`;
  }
  if (status === "PROCESSING" && pos >= 1) {
    return `PROCESSING (queue #${pos} of ${total || pos})`;
  }
  return status || "UNKNOWN";
}

function renderSuggestions(list) {
  refs.searchSuggestList.innerHTML = "";
  if (!list.length) {
    refs.searchSuggestPanel.classList.add("hidden");
    return;
  }
  list.slice(0, 10).forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      refs.searchInput.value = text;
      submitSearch(text);
    });
    refs.searchSuggestList.appendChild(li);
  });
  refs.searchSuggestPanel.classList.remove("hidden");
}

async function refreshSuggestions(v) {
  const q = norm(v);
  if (q.length < 1) return renderSuggestions([]);
  const fromHistory = state.searchHistory.map((s) => norm(s.query_text || "")).filter((s) => s && s.toLowerCase().includes(q.toLowerCase()));
  let fromServer = [];
  try {
    const rs = await api(`/videos/search?q=${encodeURIComponent(q)}&limit=6`, { method: "GET" }, 1);
    fromServer = (rs.items || []).map((i) => norm(i.title || ""));
  } catch (_e) {}
  const merged = [];
  [...fromHistory, ...fromServer].forEach((s) => {
    if (s && !merged.some((m) => m.toLowerCase() === s.toLowerCase())) merged.push(s);
  });
  renderSuggestions(merged);
}

function engagementScore(video) {
  const views = Number(video?.view_count || 0);
  const likes = Number(video?.like_count || 0);
  const comments = Number(video?.comment_count || 0);
  const watchSeconds = Number(video?.watch_time_total || 0);
  const watchMinutes = watchSeconds / 60;
  const createdMs = new Date(video?.created_at || 0).getTime();
  const ageHours = Math.max((Date.now() - createdMs) / (1000 * 60 * 60), 1);
  const freshness = Math.min(2.2, 24 / ageHours);
  return (
    Math.log10(1 + views) * 10 +
    Math.log10(1 + likes) * 14 +
    Math.log10(1 + comments) * 18 +
    Math.log10(1 + watchMinutes) * 11 +
    freshness * 4
  );
}

function filteredVideos() {
  let list = [...state.videos];
  if (state.filter === "recommended") {
    if (state.recItems.length) {
      const byId = new Map(state.videos.map((v) => [v.id, v]));
      const recOrdered = state.recItems
        .map((item) => byId.get(item.video_id || item.id))
        .filter(Boolean);
      if (recOrdered.length) {
        return uniqByVideoId(recOrdered);
      }
    }
    list = uniqByVideoId(list.filter((v) => state.recIds.has(v.id)));
  } else if (state.filter === "popular") {
    if (state.popularIds.size) {
      const byId = new Map(state.videos.map((video) => [String(video.id), video]));
      const trendingList = [];
      state.popularIds.forEach((id) => {
        const item = byId.get(String(id));
        if (item) trendingList.push(item);
      });
      if (trendingList.length) {
        return uniqByVideoId(trendingList);
      }
    }

    const scored = list
      .map((v) => {
        const score = engagementScore(v);
        return { v, score };
      })
      .filter((entry) => Number(entry.v.view_count || 0) > 0 || Number(entry.v.like_count || 0) > 0 || Number(entry.v.comment_count || 0) > 0)
      .sort((a, b) => b.score - a.score || Number(b.v.view_count || 0) - Number(a.v.view_count || 0));
    if (scored.length) {
      return scored.map((entry) => entry.v);
    }
    list = list
      .slice()
      .sort((a, b) => Number(b.view_count || 0) - Number(a.view_count || 0))
      .slice(0, 24);
    return list;
  }
  if (state.sort === "views") list.sort((a, b) => Number(b.view_count || 0) - Number(a.view_count || 0));
  else if (state.sort === "likes") list.sort((a, b) => Number(b.like_count || 0) - Number(a.like_count || 0));
  else if (state.sort === "title") list.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
  else list.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  return list;
}

function setFilter(filterName) {
  state.filter = filterName || "all";
  refs.filterButtons.forEach((btn) => {
    btn.classList.toggle("active", (btn.dataset.filter || "all") === state.filter);
  });
}

function renderVideos() {
  refs.videoGrid.innerHTML = "";
  if (state.loadingVideos) {
    refs.videoGrid.innerHTML = `<div class="empty-state">Loading videos...</div>`;
    return;
  }
  const list = filteredVideos();
  if (!list.length) {
    let message = "No ready videos yet.";
    if (state.q) {
      message = `No videos found for "${esc(state.q)}".`;
    } else if (state.filter === "recommended" || state.filter === "popular") {
      message = "No videos match this filter. Try 'All' or watch some videos first.";
    }
    refs.videoGrid.innerHTML = `<div class="empty-state">${message}<br><small>Videos may still be processing. Refresh in a moment.</small></div>`;
    return updateMetrics();
  }
  list.forEach((v) => {
    const thumbUrl = resolveThumbnailUrl(v);
    const tags = Array.isArray(v.search_tags) ? v.search_tags.slice(0, 3) : [];
    const category = norm(v.content_category || "");
    const cardDescription = bestVideoDescription(v);
    const card = document.createElement("article");
    card.className = "video-card";
    if (state.watchVideo?.id === v.id) card.classList.add("selected");
    card.innerHTML = `
      <div class="video-thumb ${thumbUrl ? "" : "no-thumb"}">
        ${thumbUrl ? `<img class="video-thumb-img" src="${esc(thumbUrl)}" alt="${esc(v.title || "Video")} thumbnail" loading="lazy" onerror="this.onerror=null;this.remove();this.parentElement.classList.add('no-thumb');" />` : ""}
        <span class="status">${esc(v.status || "READY")}</span>
        <span class="duration">${dur(v.duration_seconds || 0)}</span>
      </div>
      <div class="video-body">
        <h3>${esc(v.title || "Untitled Video")}</h3>
        <p class="video-desc">${esc(cardDescription)}</p>
        <div class="tag-row">
          ${category ? `<span class="tag-chip category">${esc(category)}</span>` : ""}
          ${tags.map((tag) => `<span class="tag-chip">${esc(tag)}</span>`).join("")}
        </div>
        <div class="video-meta"><span>${nfmt(v.view_count)} views</span><span>${nfmt(v.like_count)} likes</span><span>${nfmt(v.comment_count)} comments</span><span>${rel(v.created_at)}</span></div>
        <div class="video-actions"><button class="btn ghost watch-btn" type="button">Watch</button><button class="btn like-btn" type="button">${v.liked_by_me ? "Liked" : "Like"}</button></div>
      </div>
    `;
    const open = async () => navigate(`/watch/${v.id}`);
    card.addEventListener("click", open);
    card.querySelector(".watch-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      await open();
    });
    card.querySelector(".like-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleLike(v.id);
    });
    refs.videoGrid.appendChild(card);
  });
  updateMetrics();
}

function renderWatchMeta() {
  const v = state.watchVideo;
  if (!v) {
    refs.watchTitle.textContent = "No video selected";
    refs.watchMetaLine.textContent = "Open a video from home feed.";
    refs.watchDescription.textContent = "";
    refs.watchTagRow.innerHTML = "";
    refs.watchLikeBtn.disabled = true;
    refs.watchUnlikeBtn.disabled = true;
    refs.watchDeleteBtn.classList.add("hidden");
    return;
  }
  refs.watchTitle.textContent = v.title || "Untitled Video";
  refs.watchMetaLine.textContent = `${nfmt(v.view_count)} views | ${nfmt(v.like_count)} likes | ${nfmt(v.comment_count)} comments | ${rel(v.created_at)}`;
  refs.watchDescription.textContent = bestVideoDescription(v);
  const tags = Array.isArray(v.search_tags) ? v.search_tags.slice(0, 8) : [];
  const category = norm(v.content_category || "");
  refs.watchTagRow.innerHTML = `${category ? `<span class="tag-chip category">${esc(category)}</span>` : ""}${tags
    .map((tag) => `<span class="tag-chip">${esc(tag)}</span>`)
    .join("")}`;
  refs.watchLikeBtn.textContent = v.liked_by_me ? "Liked" : "Like";
  const can = Boolean(state.user?.id);
  refs.watchLikeBtn.disabled = !can || Boolean(v.liked_by_me);
  refs.watchUnlikeBtn.disabled = !can || !Boolean(v.liked_by_me);
  refs.watchCommentInput.disabled = !can;
  refs.watchCommentBtn.disabled = !can;
  refs.watchCommentInput.placeholder = can ? "Write a comment" : "Sign in to comment";
  if (canDeleteVideo(v)) {
    refs.watchDeleteBtn.classList.remove("hidden");
    refs.watchDeleteBtn.disabled = false;
  } else {
    refs.watchDeleteBtn.classList.add("hidden");
  }
}

function renderComments() {
  refs.watchComments.innerHTML = "";
  refs.watchCommentCount.textContent = `${state.watchComments.length} comment${state.watchComments.length === 1 ? "" : "s"}`;
  if (!state.watchComments.length) {
    refs.watchComments.innerHTML = `<li class="empty-state">No comments yet.</li>`;
    return;
  }
  state.watchComments.forEach((c) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="comment-head"><span class="comment-author">${esc(c.user_email || "viewer")}</span><span class="comment-time">${esc(rel(c.created_at))}</span></div><p class="comment-text">${esc(c.comment_text || "")}</p>`;
    refs.watchComments.appendChild(li);
  });
}

function renderRecList() {
  refs.watchRecommendationList.innerHTML = "";
  const list = uniqByVideoId(state.recItems)
    .filter((r) => (r.video_id || r.id) !== state.watchVideo?.id)
    .slice(0, 16);
  if (!list.length) {
    refs.watchRecommendationList.innerHTML = `<li class="empty-state">No recommendations yet.</li>`;
    return;
  }
  list.forEach((r, i) => {
    const vid = r.video_id || r.id;
    const recThumbUrl = resolveThumbnailUrl({ id: vid, status: "READY" });
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="rec-row">
        <div class="rec-thumb ${recThumbUrl ? "" : "no-thumb"}">
          ${recThumbUrl ? `<img src="${esc(recThumbUrl)}" alt="${esc(r.title || "Video")} thumbnail" loading="lazy" onerror="this.onerror=null;this.remove();this.parentElement.classList.add('no-thumb');" />` : ""}
        </div>
        <div class="rec-copy">
          <strong class="rec-title">#${i + 1} ${esc(r.title || "Video")}</strong>
          <div class="rec-meta">${nfmt(r.view_count || 0)} views | ${dur(r.duration_seconds || 0)} | ${esc(r.reason || "Recommended")}</div>
        </div>
      </div>
    `;
    li.addEventListener("click", async () => {
      await navigate(`/watch/${vid}`);
      if (state.autoplay) refs.watchVideo.play().catch(() => {});
    });
    refs.watchRecommendationList.appendChild(li);
  });
}

function destroyPlayer() {
  hideResumePrompt();
  if (state.watchHls) {
    state.watchHls.destroy();
    state.watchHls = null;
  }
  refs.watchVideo.pause();
  refs.watchVideo.removeAttribute("src");
  refs.watchVideo.load();
  refs.watchQualitySelect.innerHTML = `<option value="-1">Auto</option>`;
  refs.watchVideo.closest(".watch-player-shell")?.classList.remove("vertical-video");
}

function setupPlayer(video, autoPlay = false) {
  destroyPlayer();
  const streamUrl = resolveStreamUrl(video);
  if (!streamUrl) {
    refs.openRawBtn.disabled = true;
    return setDiag("Video is not ready for streaming yet.", "error");
  }
  refs.openRawBtn.disabled = false;
  refs.openRawBtn.dataset.url = streamUrl;
  state.watchSession = sid(`watch-${String(video.id).slice(0, 8)}`);
  state.telemetry = { t: 0, s: -1 };
  refs.watchVideo.addEventListener("loadedmetadata", () => maybeShowResumePrompt(video), { once: true });
  setDiag("Loading stream manifest...", "loading");

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true, maxBufferLength: 24, backBufferLength: 30 });
    state.watchHls = hls;
    hls.attachMedia(refs.watchVideo);
    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(streamUrl));
    hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, data) => {
      refs.watchQualitySelect.innerHTML = `<option value="-1">Auto</option>`;
      (data.levels || []).forEach((l, i) => {
        const op = document.createElement("option");
        op.value = String(i);
        op.textContent = l.height ? `${l.height}p` : `Level ${i}`;
        refs.watchQualitySelect.appendChild(op);
      });
      setDiag("Stream ready. Use quality and speed controls.", "ok");
      if (autoPlay) refs.watchVideo.play().catch(() => {});
    });
    hls.on(window.Hls.Events.ERROR, (_e, d) => {
      const details = d?.details || "unknown";
      if (details.includes("manifest")) setDiag(`Manifest error (${details}). Retry or open stream.`, d?.fatal ? "error" : "loading");
      else if (details.includes("frag") || details.includes("buffer")) setDiag(`Segment error (${details}). Retry playback.`, d?.fatal ? "error" : "loading");
      else setDiag(`Player error (${details}).`, d?.fatal ? "error" : "loading");
    });
  } else {
    refs.watchVideo.src = streamUrl;
    refs.watchVideo.addEventListener("loadedmetadata", () => {
      setDiag("Using native HLS playback.", "ok");
      if (autoPlay) refs.watchVideo.play().catch(() => {});
    }, { once: true });
    refs.watchVideo.addEventListener("error", () => setDiag("Native playback failed. Retry or open stream.", "error"), { once: true });
  }
}
async function loadWatch(videoId, autoPlay = false) {
  if (!videoId) return;
  setDiag("Loading selected video...", "loading");
  try {
    const v = await api(`/videos/${videoId}`, { method: "GET" }, 2);
    state.watchVideo = v;
    patchVideo(v.id, v);
    renderVideos();
    renderWatchMeta();
    await Promise.all([
      api(`/videos/${videoId}/comments?limit=25`, { method: "GET" }, 1).then((r) => {
        state.watchComments = r.items || [];
      }).catch(() => {
        state.watchComments = [];
      }),
      refreshRecs(),
      state.user?.id ? refreshHistory() : Promise.resolve(),
    ]);
    renderComments();
    renderRecList();
    setupPlayer(v, autoPlay);
  } catch (e) {
    setDiag(`Unable to load video: ${e.message}`, "error");
    logClient("error", "load-watch-failed", e.message);
  }
}

async function sendView(force = false) {
  if (!state.watchVideo?.id) return;
  const watched = Number(refs.watchVideo.currentTime || 0);
  const duration = Number(refs.watchVideo.duration || 0);
  const completion = duration > 0 ? Math.min(1, watched / duration) : 0;
  const now = Date.now();
  if (!force) {
    if (now - state.telemetry.t < 8000) return;
    if (Math.abs(watched - state.telemetry.s) < 0.8) return;
  }
  state.telemetry.t = now;
  state.telemetry.s = watched;
  try {
    await api(`/videos/${state.watchVideo.id}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.watchSession || sid("watch-fallback"),
        watchTimeSeconds: watched,
        completionRate: completion,
        durationSeconds: duration,
      }),
    }, 0);
  } catch (_e) {}
}

async function toggleLike(videoId) {
  if (!requireAuth("Like")) return;
  const cur = state.videos.find((v) => v.id === videoId) || state.watchVideo;
  const liked = Boolean(cur?.liked_by_me);
  try {
    if (liked) {
      await api(`/videos/${videoId}/like`, { method: "DELETE" }, 1);
      patchVideo(videoId, { liked_by_me: false, like_count: Math.max(0, Number(cur.like_count || 0) - 1) });
      toast("Like removed");
    } else {
      await api(`/videos/${videoId}/like`, { method: "POST" }, 1);
      patchVideo(videoId, { liked_by_me: true, like_count: Number(cur.like_count || 0) + 1 });
      toast("Liked");
    }
    renderVideos();
    renderWatchMeta();
    await refreshRecs();
  } catch (e) {
    toast(`Like action failed: ${e.message}`);
  }
}

async function deleteVideo(videoId) {
  if (!requireAuth("Delete video")) return;
  if (!confirm("Are you sure you want to delete this video? This action cannot be undone.")) return;
  
  refs.watchDeleteBtn.disabled = true;
  try {
    await api(`/videos/${videoId}`, { method: "DELETE" }, 1);
    toast("Video deleted successfully");
    // Navigate back to home after a short delay
    setTimeout(() => {
      navigate("/");
    }, 1000);
  } catch (e) {
    toast(`Delete failed: ${e.message}`);
  } finally {
    refs.watchDeleteBtn.disabled = false;
  }
}

async function submitComment() {
  if (!state.watchVideo?.id) return;
  if (!requireAuth("Comment")) return;
  const text = norm(refs.watchCommentInput.value);
  if (!text) return;
  refs.watchCommentBtn.disabled = true;
  try {
    await api(`/videos/${state.watchVideo.id}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment: text }),
    }, 1);
    refs.watchCommentInput.value = "";
    patchVideo(state.watchVideo.id, { comment_count: Number(state.watchVideo.comment_count || 0) + 1 });
    renderVideos();
    renderWatchMeta();
    const c = await api(`/videos/${state.watchVideo.id}/comments?limit=25`, { method: "GET" }, 1);
    state.watchComments = c.items || [];
    renderComments();
    toast("Comment posted");
  } catch (e) {
    toast(`Comment failed: ${e.message}`);
  } finally {
    refs.watchCommentBtn.disabled = false;
  }
}

async function refreshVideos() {
  state.loadingVideos = true;
  renderVideos();
  try {
    const ep = state.q.length >= 1 ? `/videos/search?q=${encodeURIComponent(state.q)}&limit=96` : "/videos?limit=96";
    const data = await api(ep, { method: "GET" }, 2);
    state.videos = data.items || [];
  } catch (e) {
    refs.videoGrid.innerHTML = `<div class="empty-state">Failed to load videos: ${esc(e.message)}</div>`;
    logClient("error", "refresh-videos-failed", e.message);
  } finally {
    state.loadingVideos = false;
  }
  
  // Always render, even if empty - shows proper empty state
  renderVideos();
}

async function refreshPopular() {
  try {
    const payload = await api("/feed/trending?limit=96", { method: "GET" }, 2);
    const ids = new Set();
    (payload.items || []).forEach((item) => {
      const id = String(item?.video_id || item?.id || "").trim();
      if (id) ids.add(id);
    });
    state.popularIds = ids;
  } catch (_e) {
    state.popularIds = new Set();
  }
}

async function refreshRecs() {
  const mode = recModes[state.recMode] || recModes.recommended;
  const fallback = recModes.trending;
  const useFallback = mode.requiresUser && !state.user?.id;
  const request = useFallback ? fallback : mode;
  refs.recMeta.textContent = "Refreshing recommendations...";
  try {
    const d = await api(request.endpoint(state.user?.id || ""), { method: "GET" }, 2);
    const uniqueItems = uniqByVideoId(d.items || []);
    state.recItems = state.recMode === "continue" ? uniqueItems.slice(0, 1) : uniqueItems;
    state.recIds = new Set(state.recItems.map((i) => i.video_id || i.id));
    refs.recMeta.textContent = `${useFallback ? `Login required for ${mode.label}. ` : ""}${request.label} | Source: ${d.source || "n/a"} | Users: ${d.training_summary?.users ?? 0}`;
  } catch (e) {
    state.recItems = [];
    state.recIds = new Set();
    refs.recMeta.textContent = `Recommendations unavailable: ${e.message}`;
    logClient("warn", "refresh-recommendations-failed", e.message);
  }
  renderRecList();
  renderVideos();
}

async function refreshHistory() {
  if (!state.user?.id) {
    state.watchHistory = [];
    state.searchHistory = [];
    state.historyExpanded = false;
    return renderHistory();
  }
  try {
    const [w, s] = await Promise.all([
      api("/videos/history/watch?limit=20", { method: "GET" }, 1),
      api("/videos/history/search?limit=20", { method: "GET" }, 1),
    ]);
    const dedupedHistory = [];
    const seenVideos = new Set();
    (w.items || []).forEach((item) => {
      const id = String(item?.video_id || "").trim();
      if (!id || seenVideos.has(id)) return;
      seenVideos.add(id);
      dedupedHistory.push(item);
    });
    state.watchHistory = dedupedHistory;
    if (state.watchHistory.length <= 1) state.historyExpanded = false;
    state.searchHistory = s.items || [];
  } catch (_e) {
    state.watchHistory = [];
    state.searchHistory = [];
    logClient("warn", "refresh-history-failed");
  }
  renderHistory();
}

function renderHistory() {
  refs.watchHistoryList.innerHTML = "";
  refs.searchHistoryList.innerHTML = "";
  if (!state.user?.id) {
    refs.watchHistoryList.innerHTML = `<li>Sign in to build watch history.</li>`;
    refs.searchHistoryList.innerHTML = `<li>Sign in to save search history.</li>`;
    return;
  }
  if (!state.watchHistory.length) {
    refs.watchHistoryList.innerHTML = `<li>No watch history yet.</li>`;
  } else {
    const items = state.historyExpanded ? state.watchHistory.slice(0, 6) : state.watchHistory.slice(0, 1);
    items.forEach((i) => {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${esc(i.title || "Untitled")}</strong><br/><span>${Number(i.progress_percent || 0)}% watched | ${rel(i.last_watched_at)}</span>`;
      li.addEventListener("click", async () => navigate(`/watch/${i.video_id}`));
      refs.watchHistoryList.appendChild(li);
    });

    if (state.watchHistory.length > 1) {
      const toggle = document.createElement("li");
      toggle.className = "history-more";
      toggle.innerHTML = `<button type="button" class="btn ghost full">${state.historyExpanded ? "Show less" : `Show ${Math.min(3, state.watchHistory.length - 1)} more`}</button>`;
      toggle.querySelector("button")?.addEventListener("click", () => {
        state.historyExpanded = !state.historyExpanded;
        renderHistory();
      });
      refs.watchHistoryList.appendChild(toggle);
    }
  }
  if (!state.searchHistory.length) refs.searchHistoryList.innerHTML = `<li>No search history yet.</li>`;
  else state.searchHistory.slice(0, 8).forEach((i) => {
    const q = norm(i.query_text || "");
    const li = document.createElement("li");
    li.innerHTML = `<strong>${esc(q)}</strong><br/><span>${rel(i.created_at)}</span>`;
    li.addEventListener("click", async () => {
      refs.searchInput.value = q;
      await submitSearch(q);
    });
    refs.searchHistoryList.appendChild(li);
  });
}

async function logSearch(q) {
  const n = norm(q).toLowerCase();
  if (!state.user?.id || n.length < 2) return;
  try {
    await api("/videos/history/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: n }),
    }, 0);
  } catch (_e) {}
}

async function submitSearch(raw) {
  if (state.searchBusy) return;
  state.searchBusy = true;
  const q = norm(raw || refs.searchInput.value);
  try {
    refs.searchInput.value = q;
    renderSuggestions([]);
    setFilter("all");
    const target = homePath(q);
    if (window.location.pathname + window.location.search === target) {
      state.q = q;
      await refreshVideos();
    } else {
      await navigate(target);
      await refreshVideos();
    }
    if (q.length >= 2) {
      await logSearch(q);
      await refreshHistory();
    }
  } finally {
    state.searchBusy = false;
  }
}

async function refreshHealth() {
  const checks = await Promise.allSettled([
    fetch(`${config.apiBaseUrl}/health`, { cache: "no-store" }),
    fetch(streamHealthEndpoint, { cache: "no-store" }),
  ]);
  const apiOk = checks[0].status === "fulfilled" && checks[0].value.ok;
  const streamOk = checks[1].status === "fulfilled" && checks[1].value.ok;
  if (apiOk && streamOk) return refs.healthBanner.classList.add("hidden");
  const p = [];
  if (!apiOk) p.push("API gateway unavailable");
  if (!streamOk) p.push("stream gateway unavailable");
  refs.healthBanner.textContent = `Service degraded: ${p.join(" | ")}. Retry may be required.`;
  refs.healthBanner.classList.remove("hidden");
}

async function refreshAll() {
  await Promise.all([refreshHealth(), refreshHistory(), refreshRecs(), refreshPopular(), refreshVideos()]);
}

async function applyRoute() {
  state.route = parseRoute();
  state.q = state.route.q;
  refs.searchInput.value = state.route.q;
  setMobileRailOpen(false);
  const watch = state.route.view === "watch";
  const manage = state.route.view === "manage";
  const searchMode = state.route.view === "search";
  if (searchMode) {
    setFilter("all");
  }
  if (!watch) {
    destroyPlayer();
  }
  refs.homeView.classList.toggle("hidden", watch || manage);
  refs.watchView.classList.toggle("hidden", !watch);
  refs.manageView.classList.toggle("hidden", !manage);
  refs.homeSubhead.textContent = searchMode && state.q
    ? `Search results for "${state.q}". Keyword ranking is active.`
    : "Use / to focus search. On watch page use Space/K (play), J/L (seek), M (mute), F (fullscreen).";
  setNav();
  if (watch) await loadWatch(state.route.videoId, false);
  else if (manage) await loadManageVideos();
  else renderVideos();
}

async function loadManageVideos() {
  if (!state.user?.id) {
    toast("Sign in to access video management");
    await navigate("/");
    return;
  }

  try {
    const result = await api("/videos?limit=200", { method: "GET" }, 1);
    state.videos = result.items || [];
    const deletableCount = state.videos.filter((video) => canDeleteVideo(video)).length;
    const totalCount = state.videos.length;
    if (!totalCount) {
      refs.manageSubhead.textContent = `Signed in as ${state.user.email}. No videos available right now.`;
    } else if (deletableCount === totalCount) {
      refs.manageSubhead.textContent = `Signed in as ${state.user.email}. Admin mode active: you can delete any video.`;
    } else {
      refs.manageSubhead.textContent = `Signed in as ${state.user.email}. You can delete only your own uploads (${deletableCount}/${totalCount} deletable).`;
    }
    renderManageGrid();
  } catch (e) {
    toast(`Failed to load videos: ${e.message}`);
    refs.manageGrid.innerHTML = `<div class="empty-state">Unable to load videos: ${esc(e.message)}</div>`;
  }
}

function renderManageGrid() {
  refs.manageGrid.innerHTML = "";
  
  if (!state.videos || state.videos.length === 0) {
    refs.manageGrid.innerHTML = `<div class="empty-state">No videos to manage. All videos deleted or none available.</div>`;
    return;
  }

  state.videos.forEach((v) => {
    const thumbUrl = resolveThumbnailUrl(v);
    const canDelete = canDeleteVideo(v);
    const card = document.createElement("div");
    card.className = "manage-card";
    card.innerHTML = `
      <div class="manage-thumb ${thumbUrl ? "" : "no-thumb"}">
        ${thumbUrl ? `<img src="${esc(thumbUrl)}" alt="${esc(v.title)}" loading="lazy" />` : "No thumbnail"}
      </div>
      <div class="manage-title" title="${esc(v.title)}">${esc(v.title || "Untitled")}</div>
      <div class="manage-meta">
        <span>${nfmt(v.view_count || 0)} views</span>
        <span>${nfmt(v.like_count || 0)} likes</span>
        <span>${v.status || "UNKNOWN"}</span>
      </div>
      <div class="manage-actions">
        <button class="btn ghost watch-btn">Watch</button>
        <button class="btn danger delete-btn" ${canDelete ? "" : "disabled"}>${canDelete ? "Delete" : "No Access"}</button>
      </div>
    `;
    
    const watchBtn = card.querySelector(".watch-btn");
    const deleteBtn = card.querySelector(".delete-btn");
    
    watchBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await navigate(`/watch/${v.id}`);
    });
    
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!canDelete) {
        toast("You can only delete videos you own unless admin mode is enabled.");
        return;
      }
      if (!confirm(`Delete "${esc(v.title)}"? This cannot be undone.`)) return;
      deleteBtn.disabled = true;
      try {
        await api(`/videos/${v.id}`, { method: "DELETE" }, 1);
        toast("Video deleted");
        state.videos = state.videos.filter((vid) => vid.id !== v.id);
        renderManageGrid();
      } catch (err) {
        toast(`Delete failed: ${err.message}`);
      } finally {
        deleteBtn.disabled = false;
      }
    });
    
    refs.manageGrid.appendChild(card);
  });
}

function isTyping(target) {
  const tag = String(target?.tagName || "").toLowerCase();
  return ["input", "textarea", "select"].includes(tag);
}

async function handleNavAction(nav, mode) {
  if (state.mobileRailOpen) {
    setMobileRailOpen(false);
  }

  if (nav === "home") {
    setFilter("all");
    state.q = "";
    refs.searchInput.value = "";
    await navigate("/");
    await refreshVideos();
    return;
  }
  if (nav === "manage") {
    await navigate("/manage");
    return;
  }
  if (!mode) {
    return;
  }

  state.recMode = mode;
  setNav();
  setFilter("recommended");
  const shouldResetSearch = state.q.length > 0;
  if (shouldResetSearch) {
    state.q = "";
    refs.searchInput.value = "";
  }
  const isHomeLike = state.route.view === "home" || state.route.view === "search";
  if (!isHomeLike || shouldResetSearch) {
    await navigate("/");
    await refreshVideos();
  } else {
    renderVideos();
  }
  await refreshRecs();
}

function wire() {
  applyTheme(state.theme);
  refs.autoplayToggle.checked = state.autoplay;
  setActivityOpen(false);
  setMobileRailOpen(false);
  refs.homeSubhead.textContent = "Use / to focus search. On watch page use Space/K (play), J/L (seek), M (mute), F (fullscreen).";

  refs.brandLink.addEventListener("click", async (e) => {
    e.preventDefault();
    setFilter("all");
    state.q = "";
    refs.searchInput.value = "";
    await navigate("/");
    await refreshVideos();
  });
  refs.mobileMenuBtn.addEventListener("click", () => setMobileRailOpen(!state.mobileRailOpen));
  refs.mobileMenuCloseBtn.addEventListener("click", () => setMobileRailOpen(false));
  refs.mobileBackdrop.addEventListener("click", () => setMobileRailOpen(false));
  refs.toggleActivityBtn.addEventListener("click", () => setActivityOpen(!state.activityOpen));
  refs.themeToggleBtn.addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));

  refs.openLoginBtn.addEventListener("click", () => openAuth("login"));
  refs.openRegisterBtn.addEventListener("click", () => openAuth("register"));
  refs.closeAuthBtn.addEventListener("click", closeAuth);
  refs.authModal.addEventListener("click", (e) => {
    if (e.target === refs.authModal) closeAuth();
  });
  refs.loginTabBtn.addEventListener("click", () => openAuth("login"));
  refs.registerTabBtn.addEventListener("click", () => openAuth("register"));

  refs.logoutBtn.addEventListener("click", async () => {
    destroyPlayer();
    setSession("", null);
    toast("Logged out");
    await refreshAll();
    renderWatchMeta();
  });

  refs.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = refs.loginForm.querySelector("button[type='submit']");
    const f = new FormData(refs.loginForm);
    btnLoading(b, true, "Sign In");
    try {
      const p = await api("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: norm(f.get("email") || "").toLowerCase(), password: String(f.get("password") || "") }),
      }, 0);
      setSession(p.token, p.user);
      refs.loginForm.reset();
      closeAuth();
      toast("Signed in successfully");
      await refreshAll();
      renderWatchMeta();
    } catch (err) {
      msg(refs.authMessage, `Login failed: ${err.message}`, "error");
    } finally {
      btnLoading(b, false, "Sign In");
    }
  });

  refs.registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = refs.registerForm.querySelector("button[type='submit']");
    const f = new FormData(refs.registerForm);
    btnLoading(b, true, "Create Account");
    try {
      const p = await api("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: norm(f.get("email") || "").toLowerCase(), password: String(f.get("password") || "") }),
      }, 0);
      setSession(p.token, p.user);
      refs.registerForm.reset();
      closeAuth();
      toast("Account created");
      await refreshAll();
      renderWatchMeta();
    } catch (err) {
      msg(refs.authMessage, `Register failed: ${err.message}`, "error");
    } finally {
      btnLoading(b, false, "Create Account");
    }
  });

  refs.searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await submitSearch(refs.searchInput.value);
  });
  refs.searchBtn?.addEventListener("click", async (e) => {
    e.preventDefault();
    await submitSearch(refs.searchInput.value);
  });
  refs.searchClearBtn.addEventListener("click", async () => {
    refs.searchInput.value = "";
    await submitSearch("");
  });
  refs.searchInput.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => refreshSuggestions(refs.searchInput.value), 180);
  });
  refs.searchInput.addEventListener("focus", () => refreshSuggestions(refs.searchInput.value));
  document.addEventListener("click", (e) => {
    if (!refs.searchForm.contains(e.target)) refs.searchSuggestPanel.classList.add("hidden");
  });

  refs.filterButtons.forEach((b) => {
    b.addEventListener("click", async () => {
      setFilter(b.dataset.filter || "all");
      if (state.filter === "popular" && !state.popularIds.size) {
        await refreshPopular();
      }
      renderVideos();
    });
  });
  refs.sortSelect.addEventListener("change", () => {
    state.sort = refs.sortSelect.value;
    renderVideos();
  });

  refs.railLinks.forEach((b) => {
    b.addEventListener("click", async () => {
      await handleNavAction(b.dataset.nav || "", b.dataset.mode || "");
    });
  });
  refs.mobileNavLinks.forEach((b) => {
    b.addEventListener("click", async () => {
      await handleNavAction(b.dataset.nav || "", b.dataset.mode || "");
    });
  });

  refs.retrainBtn.addEventListener("click", async () => {
    btnLoading(refs.retrainBtn, true, "Retrain Model");
    try {
      const r = await api("/feed/train", { method: "POST" }, 0);
      toast(`Model retrained (${r?.summary?.users ?? 0} users)`);
      await refreshRecs();
    } catch (e) {
      toast(`Retrain failed: ${e.message}`);
    } finally {
      btnLoading(refs.retrainBtn, false, "Retrain Model");
    }
  });

  refs.uploadForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireAuth("Upload")) return;
    if (!refs.videoFileInput.files?.[0]) return msg(refs.uploadMessage, "Choose a video file first.", "error");
    const file = refs.videoFileInput.files[0];
    if (!(String(file.type || "").startsWith("video/") || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name))) {
      return msg(refs.uploadMessage, "Selected file is not a supported video.", "error");
    }

    const b = refs.uploadForm.querySelector("button[type='submit']");
    btnLoading(b, true, "Upload and Process");
    setProgress(0);
    msg(refs.uploadMessage, "Uploading video...");
    const data = new FormData(refs.uploadForm);

    try {
      const payload = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${config.apiBaseUrl}/videos/upload`);
        if (state.token) xhr.setRequestHeader("Authorization", `Bearer ${state.token}`);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setProgress((ev.loaded / ev.total) * 100);
        };
        xhr.onerror = () => reject(new Error("Network error while uploading"));
        xhr.onload = () => {
          let body = {};
          try {
            body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
          } catch (_e) {
            body = {};
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(body);
          else reject(new Error(body.error || `Upload failed (HTTP ${xhr.status})`));
        };
        xhr.send(data);
      });

      const title = payload.title || String(data.get("title") || "Untitled Video");
      setQueue(payload.id, title, "UPLOADED", 0, "");
      setProgress(100);
      refs.uploadForm.reset();
      msg(refs.uploadMessage, `Upload complete. Processing "${title}"...`, "ok");
      toast("Upload accepted");
      let terminalStatus = "";
      for (let i = 0; i < uploadStatusMaxPollIterations; i += 1) {
        const st = await api(`/videos/${payload.id}/status`, { method: "GET" }, 1);
        terminalStatus = String(st.status || "").toUpperCase();
        const displayStatus = uploadStatusLabel(st);
        setQueue(payload.id, title, displayStatus, Number(st.attempts || 0), st.last_error || "");
        if (terminalStatus === "READY" || terminalStatus === "FAILED") break;
        await new Promise((r) => setTimeout(r, uploadStatusPollMs));
      }
      if (terminalStatus !== "READY" && terminalStatus !== "FAILED") {
        msg(
          refs.uploadMessage,
          `Upload accepted. Transcoding is still running in the background for "${title}". You can continue using the app and check queue status in Upload panel.`,
          "ok"
        );
      } else if (terminalStatus === "READY") {
        msg(refs.uploadMessage, `"${title}" is ready to watch.`, "ok");
      } else if (terminalStatus === "FAILED") {
        msg(refs.uploadMessage, `Transcoding failed for "${title}". Use Retry in queue.`, "error");
      }
      await refreshVideos();
    } catch (err) {
      setProgress(0);
      msg(refs.uploadMessage, `Upload failed: ${err.message}`, "error");
      toast(`Upload failed: ${err.message}`);
    } finally {
      btnLoading(b, false, "Upload and Process");
    }
  });

  refs.uploadQueue.addEventListener("click", async (e) => {
    const t = e.target.closest(".retry-btn");
    if (!t) return;
    if (!requireAuth("Retry transcode")) return;
    t.disabled = true;
    try {
      await api(`/videos/${t.dataset.videoId}/finalize`, { method: "POST" }, 1);
      toast("Retry queued");
    } catch (err) {
      toast(`Retry failed: ${err.message}`);
    } finally {
      t.disabled = false;
    }
  });

  refs.backHomeBtn.addEventListener("click", async () => {
    setFilter("all");
    state.q = "";
    refs.searchInput.value = "";
    await navigate("/");
    await refreshVideos();
  });
  refs.watchSpeedSelect.addEventListener("change", () => {
    refs.watchVideo.playbackRate = Number(refs.watchSpeedSelect.value);
  });
  refs.watchQualitySelect.addEventListener("change", () => {
    if (state.watchHls) state.watchHls.currentLevel = Number(refs.watchQualitySelect.value);
  });
  refs.autoplayToggle.addEventListener("change", () => {
    state.autoplay = refs.autoplayToggle.checked;
    localStorage.setItem("scalastream_autoplay", String(state.autoplay));
  });
  refs.retryPlaybackBtn.addEventListener("click", async () => {
    if (state.watchVideo?.id) await loadWatch(state.watchVideo.id, true);
  });
  refs.openRawBtn.addEventListener("click", () => {
    const u = refs.openRawBtn.dataset.url;
    if (u) window.open(u, "_blank", "noopener,noreferrer");
  });
  refs.resumeNowBtn.addEventListener("click", () => {
    if (state.resumePrompt.videoId && state.watchVideo?.id === state.resumePrompt.videoId) {
      refs.watchVideo.currentTime = Math.max(0, Number(state.resumePrompt.seconds || 0));
      refs.watchVideo.play().catch(() => {});
    }
    hideResumePrompt();
  });
  refs.resumeStartBtn.addEventListener("click", () => {
    if (state.watchVideo?.id) {
      refs.watchVideo.currentTime = 0;
      refs.watchVideo.play().catch(() => {});
    }
    hideResumePrompt();
  });
  refs.watchLikeBtn.addEventListener("click", async () => {
    if (state.watchVideo?.id) await toggleLike(state.watchVideo.id);
  });
  refs.watchUnlikeBtn.addEventListener("click", async () => {
    if (state.watchVideo?.id) await toggleLike(state.watchVideo.id);
  });
  refs.watchDeleteBtn.addEventListener("click", async () => {
    if (state.watchVideo?.id) await deleteVideo(state.watchVideo.id);
  });
  refs.watchCommentBtn.addEventListener("click", async () => submitComment());
  refs.watchCommentInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await submitComment();
    }
  });

  refs.watchVideo.addEventListener("loadedmetadata", applyPlayerOrientation);
  refs.watchVideo.addEventListener("play", () => {
    if (!refs.resumePrompt.classList.contains("hidden")) hideResumePrompt();
  });
  refs.watchVideo.addEventListener("timeupdate", () => {
    if (!refs.watchVideo.paused) sendView(false);
  });
  refs.watchVideo.addEventListener("pause", () => sendView(false));
  refs.watchVideo.addEventListener("ended", async () => {
    await sendView(true);
    if (!state.autoplay) return;
    const next = state.recItems.find((r) => (r.video_id || r.id) !== state.watchVideo?.id);
    if (next) {
      await navigate(`/watch/${next.video_id || next.id}`);
      refs.watchVideo.play().catch(() => {});
    }
  });

  window.addEventListener("popstate", async () => applyRoute());
  window.addEventListener("resize", () => {
    if (window.innerWidth > 900 && state.mobileRailOpen) {
      setMobileRailOpen(false);
    }
  });

  document.addEventListener("keydown", async (e) => {
    if (e.key === "Escape" && state.mobileRailOpen) {
      setMobileRailOpen(false);
    }
    if (e.key === "/" && !isTyping(document.activeElement)) {
      e.preventDefault();
      refs.searchInput.focus();
      refs.searchInput.select();
      return;
    }
    if (!refs.authModal.classList.contains("hidden")) {
      if (e.key === "Escape") closeAuth();
      return;
    }
    if (state.route.view !== "watch" || !state.watchVideo || isTyping(document.activeElement)) return;
    const p = refs.watchVideo;
    const key = e.key.toLowerCase();
    if (key === " " || key === "k") {
      e.preventDefault();
      if (p.paused) p.play().catch(() => {});
      else p.pause();
    } else if (key === "j") {
      e.preventDefault();
      p.currentTime = Math.max(0, p.currentTime - 10);
    } else if (key === "l") {
      e.preventDefault();
      p.currentTime = Math.min(p.duration || Number.MAX_SAFE_INTEGER, p.currentTime + 10);
    } else if (key === "m") {
      e.preventDefault();
      p.muted = !p.muted;
    } else if (key === "f") {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else p.requestFullscreen?.().catch(() => {});
    }
  });

  window.addEventListener("beforeunload", () => destroyPlayer());
}

async function bootstrap() {
  refs.autoplayToggle.checked = state.autoplay;
  refs.homeSubhead.textContent = "Use / to focus search. On watch page use Space/K (play), J/L (seek), M (mute), F (fullscreen).";
  wire();
  renderAuthState();

  const initial = parseRoute();
  state.q = initial.q;
  refs.searchInput.value = initial.q;

  // Restore session from localStorage - validates token with server
  await restoreSession();
  
  // Load recommendations, videos, and history in parallel
  await refreshAll();
  
  // Render current page (home or watch)
  await applyRoute();

  // Check service health every 30 seconds
  setInterval(refreshHealth, 30000);
}

bootstrap().catch((err) => {
  console.error("Bootstrap failed", err);
  logClient("error", "bootstrap-failed", err?.message || "unknown");
});
