import axios from "axios";
import socketIoClient from "socket.io-client";
import { addLog } from "./gameState.js";
import { enqueueDonation } from "./eventBus.js";

const OPENAPI_BASE = process.env.CHZZK_OPENAPI_BASE || "https://openapi.chzzk.naver.com";
const SESSION_STATUS = new Map();

function unwrapApiResponse(data) {
  if (data && typeof data === "object" && "content" in data) {
    return data.content;
  }
  return data;
}

function createEmptyStatus() {
  return {
    isLoggedIn: false,
    oauthReady: false,
    connectState: "idle",
    sessionKey: null,
    channelId: null,
    connectedAt: null,
    lastError: null,
    lastDonation: null,
  };
}

function getState(sessionId) {
  if (!SESSION_STATUS.has(sessionId)) {
    SESSION_STATUS.set(sessionId, {
      ...createEmptyStatus(),
      socket: null,
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: 0,
      subscribed: false,
      connectTimer: null,
    });
  }
  return SESSION_STATUS.get(sessionId);
}

function clearConnectTimer(state) {
  if (state.connectTimer) {
    clearTimeout(state.connectTimer);
    state.connectTimer = null;
  }
}

function setError(state, message) {
  state.connectState = "error";
  state.lastError = message;
}

function toPublicStatus(state) {
  return {
    isLoggedIn: !!state.accessToken,
    oauthReady: !!state.accessToken,
    connectState: state.connectState,
    sessionKey: state.sessionKey,
    channelId: state.channelId,
    connectedAt: state.connectedAt,
    lastError: state.lastError,
    lastDonation: state.lastDonation,
    subscribed: !!state.subscribed,
  };
}

function parseSocketPayload(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function requestToken(body) {
  const response = await axios.post(
    `${OPENAPI_BASE}/auth/v1/token`,
    body,
    { headers: { "Content-Type": "application/json" } }
  );
  return unwrapApiResponse(response.data);
}

async function revokeToken(token) {
  if (!token) return;
  try {
    await axios.post(
      `${OPENAPI_BASE}/auth/v1/token/revoke`,
      {
        clientId: process.env.CHZZK_CLIENT_ID,
        clientSecret: process.env.CHZZK_CLIENT_SECRET,
        token,
        tokenTypeHint: "access_token",
      },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch {
    // ignore revoke failures
  }
}

export async function exchangeCodeForToken({ code, state }) {
  const token = await requestToken({
    grantType: "authorization_code",
    clientId: process.env.CHZZK_CLIENT_ID,
    clientSecret: process.env.CHZZK_CLIENT_SECRET,
    code,
    state,
  });

  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresIn: Number(token.expiresIn || 86400),
    tokenType: token.tokenType || "Bearer",
  };
}

async function refreshAccessToken(state) {
  if (!state.refreshToken) {
    throw new Error("리프레시 토큰이 없습니다. 다시 로그인해 주세요.");
  }

  const token = await requestToken({
    grantType: "refresh_token",
    refreshToken: state.refreshToken,
    clientId: process.env.CHZZK_CLIENT_ID,
    clientSecret: process.env.CHZZK_CLIENT_SECRET,
  });

  state.accessToken = token.accessToken;
  state.refreshToken = token.refreshToken;
  state.accessTokenExpiresAt = Date.now() + Number(token.expiresIn || 86400) * 1000;
  state.lastError = null;
  return state.accessToken;
}

async function ensureAccessToken(state) {
  if (!state.accessToken) {
    throw new Error("치지직 로그인이 필요합니다.");
  }

  if (!state.accessTokenExpiresAt || Date.now() < state.accessTokenExpiresAt - 60_000) {
    return state.accessToken;
  }

  return refreshAccessToken(state);
}

async function getUserSessionUrl(accessToken) {
  const response = await axios.get(`${OPENAPI_BASE}/open/v1/sessions/auth`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  const content = unwrapApiResponse(response.data);
  return content.url;
}

async function subscribeDonation(accessToken, sessionKey) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  try {
    const response = await axios.post(
      `${OPENAPI_BASE}/open/v1/sessions/events/subscribe/donation`,
      null,
      {
        headers,
        params: { sessionKey },
      }
    );
    return unwrapApiResponse(response.data);
  } catch (error) {
    const message =
      error?.response?.data?.message ||
      error?.message ||
      "";

    addLog(`[CHZZK] 후원 구독 1차 실패(query): ${message}`);
  }

  try {
    const body = new URLSearchParams();
    body.append("sessionKey", sessionKey);

    const response = await axios.post(
      `${OPENAPI_BASE}/open/v1/sessions/events/subscribe/donation`,
      body.toString(),
      {
        headers: {
          ...headers,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    return unwrapApiResponse(response.data);
  } catch (error) {
    const message =
      error?.response?.data?.message ||
      error?.message ||
      "";

    addLog(`[CHZZK] 후원 구독 2차 실패(form): ${message}`);
  }

  const response = await axios.post(
    `${OPENAPI_BASE}/open/v1/sessions/events/subscribe/donation`,
    { sessionKey },
    {
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
    }
  );

  return unwrapApiResponse(response.data);
}

function attachSocketHandlers(io, sessionId, state, socket) {
  socket.on("connect", () => {
    addLog("[CHZZK] 소켓 connect 이벤트 수신");
  });

  socket.on("connect_error", (error) => {
    clearConnectTimer(state);
    setError(state, error?.message || "치지직 세션 연결 실패");
    addLog(`[CHZZK] connect_error: ${state.lastError}`);
  });

  socket.on("error", (error) => {
    clearConnectTimer(state);
    setError(state, error?.message || "치지직 소켓 오류");
    addLog(`[CHZZK] socket error: ${state.lastError}`);
  });

  socket.on("disconnect", (reason) => {
    clearConnectTimer(state);
    if (state.connectState !== "idle" && state.connectState !== "error") {
      state.connectState = "disconnected";
    }
    state.subscribed = false;
    addLog(`[CHZZK] 연결 종료: ${reason}`);
  });

  socket.on("SYSTEM", async (rawMessage) => {
    const message = parseSocketPayload(rawMessage);

    if (typeof message === "string") {
      addLog(`[CHZZK] SYSTEM 파싱 실패: ${message}`);
      setError(state, "SYSTEM 메시지 파싱 실패");
      return;
    }

    try {
      addLog(`[CHZZK] SYSTEM 수신: ${JSON.stringify(message)}`);
    } catch {
      addLog("[CHZZK] SYSTEM 수신");
    }

    const type = message?.type;

    if (type === "connected") {
      clearConnectTimer(state);
      state.sessionKey = message?.data?.sessionKey || null;
      state.connectedAt = Date.now();
      state.connectState = "authorizing";
      state.lastError = null;
      addLog(`[CHZZK] 세션 연결 완료: ${state.sessionKey || "sessionKey 없음"}`);

      try {
        const accessToken = await ensureAccessToken(state);
        await subscribeDonation(accessToken, state.sessionKey);
        addLog("[CHZZK] 후원 구독 요청 완료");
      } catch (error) {
        setError(state, error?.response?.data?.message || error?.message || "후원 구독 실패");
        addLog(`[CHZZK] 후원 구독 실패: ${state.lastError}`);
      }
      return;
    }

    if (type === "subscribed") {
      if (message?.data?.eventType === "DONATION") {
        state.subscribed = true;
        state.connectState = "connected";
        state.channelId = message?.data?.channelId || null;
        state.lastError = null;
        addLog("[CHZZK] DONATION 구독 완료");
      }
      return;
    }

    if (type === "unsubscribed") {
      if (message?.data?.eventType === "DONATION") {
        state.subscribed = false;
        state.connectState = "idle";
        addLog("[CHZZK] DONATION 구독 해제");
      }
      return;
    }

    if (type === "revoked") {
      state.subscribed = false;
      state.connectState = "revoked";
      state.lastError = "치지직 권한이 철회되었습니다. 다시 로그인해 주세요.";
      addLog("[CHZZK] 권한 철회 감지");
    }
  });

  socket.on("DONATION", (rawMessage) => {
    const message = parseSocketPayload(rawMessage);

    if (typeof message === "string") {
      addLog(`[CHZZK] DONATION 파싱 실패: ${message}`);
      return;
    }

    const donorName = String(message?.donatorNickname || "치지직 후원자");
    const amount = Number(message?.payAmount || 0);
    const donationText = String(message?.donationText || "");

    state.lastDonation = {
      donorName,
      amount,
      donationText,
      donationType: message?.donationType || null,
      receivedAt: Date.now(),
    };

    addLog(`[CHZZK] ${donorName} ${amount.toLocaleString()}원 후원 수신`);
    enqueueDonation(io, { donorName, amount });
  });
}

export function applyOAuthToSession(sessionId, tokenInfo) {
  const state = getState(sessionId);
  state.accessToken = tokenInfo.accessToken;
  state.refreshToken = tokenInfo.refreshToken;
  state.accessTokenExpiresAt = Date.now() + Number(tokenInfo.expiresIn || 86400) * 1000;
  state.lastError = null;
  return toPublicStatus(state);
}

export async function connectChzzkForSession(io, sessionId) {
  const state = getState(sessionId);
  const accessToken = await ensureAccessToken(state);

  if (state.socket) {
    try {
      state.socket.removeAllListeners();
      state.socket.disconnect();
    } catch {}
    state.socket = null;
  }

  clearConnectTimer(state);
  state.connectState = "connecting";
  state.sessionKey = null;
  state.channelId = null;
  state.connectedAt = null;
  state.lastError = null;
  state.subscribed = false;

  addLog("[CHZZK] 세션 URL 요청 시작");
  const sessionUrl = await getUserSessionUrl(accessToken);
  addLog("[CHZZK] 세션 URL 발급 완료");

  const socket = socketIoClient.connect(sessionUrl, {
    reconnection: false,
    "force new connection": true,
    "connect timeout": 3000,
    transports: ["websocket"],
  });

  state.socket = socket;
  attachSocketHandlers(io, sessionId, state, socket);

  state.connectTimer = setTimeout(() => {
    if (!state.sessionKey && state.connectState === "connecting") {
      setError(state, "세션 연결 응답이 오지 않았습니다.");
      addLog("[CHZZK] 세션 연결 타임아웃");
      try {
        socket.disconnect();
      } catch {}
    }
  }, 8000);

  addLog("[CHZZK] 소켓 연결 시도");
  return toPublicStatus(state);
}

export async function disconnectChzzkForSession(sessionId, { revoke = false } = {}) {
  const state = getState(sessionId);
  clearConnectTimer(state);

  if (state.socket) {
    try {
      state.socket.removeAllListeners();
      state.socket.disconnect();
    } catch {}
  }

  if (revoke && state.accessToken) {
    await revokeToken(state.accessToken);
  }

  SESSION_STATUS.set(sessionId, {
    ...createEmptyStatus(),
    socket: null,
    accessToken: revoke ? null : state.accessToken,
    refreshToken: revoke ? null : state.refreshToken,
    accessTokenExpiresAt: revoke ? 0 : state.accessTokenExpiresAt,
    subscribed: false,
    connectTimer: null,
  });

  addLog(revoke ? "[CHZZK] 로그아웃 완료" : "[CHZZK] 연결 해제 완료");
  return toPublicStatus(getState(sessionId));
}

export function clearSessionOauth(sessionId) {
  const state = getState(sessionId);
  clearConnectTimer(state);
  state.accessToken = null;
  state.refreshToken = null;
  state.accessTokenExpiresAt = 0;
  state.subscribed = false;
  state.connectState = "idle";
}

export function getChzzkStatus(sessionId) {
  return toPublicStatus(getState(sessionId));
}
