import express from "express";
import http from "http";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import session from "express-session";
import { Server } from "socket.io";

import { getPublicState, addLog } from "./gameState.js";
import { registerSocketEvents, removeCompletedAndExpired } from "./eventBus.js";
import {
  applyOAuthToSession,
  connectChzzkForSession,
  disconnectChzzkForSession,
  exchangeCodeForToken,
  getChzzkStatus,
} from "./chzzkConnector.js";

dotenv.config();

const REQUIRED_ENV = ["CHZZK_CLIENT_ID", "CHZZK_CLIENT_SECRET", "CHZZK_REDIRECT_URI", "SESSION_SECRET"];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
});

app.use(sessionMiddleware);
app.use(express.static(publicDir));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/api/state", (req, res) => {
  res.json(getPublicState());
});

app.get("/api/chzzk/status", (req, res) => {
  if (!req.sessionID) {
    return res.status(400).json({ ok: false, message: "세션이 없습니다." });
  }

  res.json({
    ok: true,
    ...getChzzkStatus(req.sessionID),
    redirectUri: process.env.CHZZK_REDIRECT_URI,
    callbackReady: missingEnv.length === 0,
    missingEnv,
  });
});

app.post("/api/chzzk/reconnect", async (req, res) => {
  try {
    if (missingEnv.length) {
      return res.status(500).json({ ok: false, message: `환경변수 누락: ${missingEnv.join(", ")}` });
    }

    const status = await connectChzzkForSession(io, req.sessionID);
    res.json({ ok: true, status });
  } catch (error) {
    res.status(500).json({ ok: false, message: error?.response?.data?.message || error?.message || "치지직 재연결 실패" });
  }
});

app.post("/api/chzzk/disconnect", async (req, res) => {
  const status = await disconnectChzzkForSession(req.sessionID, { revoke: false });
  res.json({ ok: true, status });
});

app.post("/api/chzzk/logout", async (req, res) => {
  await disconnectChzzkForSession(req.sessionID, { revoke: true });
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/auth/chzzk/login", (req, res) => {
  if (missingEnv.length) {
    return res.status(500).send(`<pre>환경변수가 누락되어 로그인 URL을 만들 수 없습니다.\n${missingEnv.join("\n")}</pre>`);
  }

  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    clientId: process.env.CHZZK_CLIENT_ID,
    redirectUri: process.env.CHZZK_REDIRECT_URI,
    state,
  });

  res.redirect(`https://chzzk.naver.com/account-interlock?${params.toString()}`);
});

app.get("/auth/chzzk/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send("치지직 로그인 검증에 실패했습니다. state 또는 code를 확인해 주세요.");
  }

  try {
    const tokenInfo = await exchangeCodeForToken({ code, state });
    applyOAuthToSession(req.sessionID, tokenInfo);
    await connectChzzkForSession(io, req.sessionID);
    addLog("[CHZZK] 로그인 및 자동 연동 완료");
    req.session.oauthState = null;
    res.redirect("/admin.html?chzzk=connected");
  } catch (error) {
    const message = error?.response?.data?.message || error?.message || "치지직 로그인 콜백 처리 실패";
    addLog(`[CHZZK] 콜백 실패: ${message}`);
    res.redirect(`/admin.html?chzzk=error&message=${encodeURIComponent(message)}`);
  }
});

app.get("/", (req, res) => {
  res.redirect("/display.html");
});

io.on("connection", (socket) => {
  socket.emit("state:update", getPublicState());
  registerSocketEvents(io, socket);
});

setInterval(() => {
  removeCompletedAndExpired(io);
}, 1000);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Display: http://localhost:${PORT}/display.html`);
  console.log(`Admin:   http://localhost:${PORT}/admin.html`);
  if (missingEnv.length) {
    console.warn(`Missing env vars: ${missingEnv.join(", ")}`);
  }
});
