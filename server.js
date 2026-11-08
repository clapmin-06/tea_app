// 차 추천 앱 백엔드 — 외부 패키지 없이 Node 내장 모듈만 사용
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = path.join(__dirname, "data", "teas.json");
const STORE_FILE = path.join(__dirname, "data", "store.json"); // 실행 중 생성되는 사용자 데이터
const MAX_HISTORY = 20;

const { teas: TEAS, questions: QUESTIONS } = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

// ---- 추천 로직 ----------------------------------------------------------
const FLAVOR_ALIAS = {
  floral: ["floral", "light"], sour: ["sour", "fruity", "citrus"], sweet: ["sweet", "creamy"],
  roasted: ["roasted", "earthy"], robust: ["robust", "earthy"], spicy: ["spicy", "minty"],
  grassy: ["grassy", "bitter", "light"],
};

function score(tea, a) {
  let s = 0;
  const max = 100;
  if (tea.goal.includes(a.goal)) s += 40;
  if (tea.caffeine <= a.caffeine) s += 25 - (a.caffeine - tea.caffeine) * 3;
  else s -= 30;
  const want = FLAVOR_ALIAS[a.flavor];
  const hits = tea.flavor.filter((f) => want.includes(f)).length;
  if (tea.flavor.includes(a.flavor)) s += 25;
  else if (hits) s += 12 + hits * 3;
  if (tea.temp.includes(a.temp)) s += 10; else s -= 15;
  if (a.goal === "sleep" && tea.caffeine > 0) s -= 50;
  return { tea, s, pct: Math.max(0, Math.min(99, Math.round((s / max) * 100))) };
}

function recommend(a, n = 3) {
  return TEAS.map((t) => score(t, a)).sort((x, y) => y.s - x.s).slice(0, n)
    .map(({ tea, pct }) => ({ ...tea, match: pct }));
}

// 질문 정의에 있는 값만 허용
function validateAnswers(a) {
  if (!a || typeof a !== "object") return null;
  const clean = {};
  for (const q of QUESTIONS) {
    if (!q.opts.some((o) => o.v === a[q.id])) return null;
    clean[q.id] = a[q.id];
  }
  return clean;
}

// ---- 저장소 (JSON 파일) -------------------------------------------------
let store = { users: {} };
try { store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch {}

function saveStore() {
  const tmp = STORE_FILE + ".tmp"; // 쓰다가 끊겨도 원본이 깨지지 않도록 임시파일 후 교체
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function getUser(id) {
  return (store.users[id] ??= { history: [], favorites: [] });
}

// ---- HTTP 유틸 ----------------------------------------------------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon" };

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": MIME[".json"] });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 10_000) { reject(new Error("too large")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: "forbidden" });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

// ---- API 라우터 ---------------------------------------------------------
async function handleApi(req, res, pathname) {
  const clientId = String(req.headers["x-client-id"] || "");
  const needUser = () => /^[\w-]{8,64}$/.test(clientId);
  const m = req.method;

  if (m === "GET" && pathname === "/api/questions") return send(res, 200, QUESTIONS);

  if (m === "GET" && pathname === "/api/teas") return send(res, 200, TEAS);

  if (m === "POST" && pathname === "/api/recommend") {
    const body = await readJson(req);
    const answers = validateAnswers(body.answers);
    if (!answers) return send(res, 400, { error: "invalid answers" });
    const results = recommend(answers);
    if (needUser()) {
      const u = getUser(clientId);
      u.history.unshift({ at: new Date().toISOString(), answers, top: results.map((r) => r.name) });
      u.history.length = Math.min(u.history.length, MAX_HISTORY);
      saveStore();
    }
    return send(res, 200, results);
  }

  // 아래 엔드포인트는 클라이언트 ID 필요
  if (pathname === "/api/history" || pathname.startsWith("/api/favorites")) {
    if (!needUser()) return send(res, 400, { error: "X-Client-Id header required" });
    const u = getUser(clientId);

    if (m === "GET" && pathname === "/api/history") return send(res, 200, u.history);
    if (m === "DELETE" && pathname === "/api/history") { u.history = []; saveStore(); return send(res, 200, []); }

    if (m === "GET" && pathname === "/api/favorites") return send(res, 200, u.favorites);

    const name = decodeURIComponent(pathname.split("/")[3] || "");
    if (!TEAS.some((t) => t.name === name)) return send(res, 404, { error: "unknown tea" });
    if (m === "PUT") {
      if (!u.favorites.includes(name)) u.favorites.push(name);
      saveStore(); return send(res, 200, u.favorites);
    }
    if (m === "DELETE") {
      u.favorites = u.favorites.filter((f) => f !== name);
      saveStore(); return send(res, 200, u.favorites);
    }
  }

  return send(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname.startsWith("/api/")) await handleApi(req, res, pathname);
    else if (req.method === "GET") serveStatic(req, res, pathname);
    else send(res, 405, { error: "method not allowed" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: "bad request" });
  }
});

server.listen(PORT, () => console.log(`🍵 http://localhost:${PORT}`));
