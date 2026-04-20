const socket = io();

const donorNameEl = document.getElementById("donorName");
const donationAmountEl = document.getElementById("donationAmount");
const enqueueDonationBtn = document.getElementById("enqueueDonationBtn");
const resetAllBtn = document.getElementById("resetAllBtn");

const queueCountEl = document.getElementById("queueCount");
const donationCountEl = document.getElementById("donationCount");
const diceCountEl = document.getElementById("diceCount");
const positionValueEl = document.getElementById("positionValue");
const horrorStackValueEl = document.getElementById("horrorStackValue");
const horrorConfirmedValueEl = document.getElementById("horrorConfirmedValue");
const phaseValueEl = document.getElementById("phaseValue");

const punishmentListEl = document.getElementById("punishmentList");
const logListEl = document.getElementById("logList");
const rouletteConfigListEl = document.getElementById("rouletteConfigList");
const gaugeControlListEl = document.getElementById("gaugeControlList");

const authNoticeEl = document.getElementById("authNotice");
const authLoggedInEl = document.getElementById("authLoggedIn");
const authConnectStateEl = document.getElementById("authConnectState");
const reconnectBtn = document.getElementById("reconnectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const logoutBtn = document.getElementById("logoutBtn");

let latestState = null;

socket.on("connect", () => {
  socket.emit("client:register", "admin");
});

enqueueDonationBtn.addEventListener("click", () => {
  socket.emit("admin:enqueueDonation", {
    donorName: donorNameEl.value.trim() || "테스트 후원자",
    amount: Number(donationAmountEl.value || 3000),
  });
});

resetAllBtn.addEventListener("click", () => {
  socket.emit("admin:resetAll");
});

reconnectBtn.addEventListener("click", async () => {
  const response = await fetch("/api/chzzk/reconnect", { method: "POST" });
  const data = await response.json();
  if (!data.ok) showNotice(data.message || "재연결 실패", true);
  refreshAuthStatus();
});

disconnectBtn.addEventListener("click", async () => {
  await fetch("/api/chzzk/disconnect", { method: "POST" });
  refreshAuthStatus();
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/chzzk/logout", { method: "POST" });
  refreshAuthStatus();
  showNotice("치지직 로그아웃을 완료했습니다.", false);
});

socket.on("state:update", (state) => {
  latestState = state;
  queueCountEl.textContent = state.runtime?.queue?.length ?? 0;
  donationCountEl.textContent = state.runtime?.totalDonations ?? 0;
  diceCountEl.textContent = state.runtime?.diceRollCount ?? 0;
  positionValueEl.textContent = state.board?.position ?? 0;
  horrorStackValueEl.textContent = state.board?.horrorStack ?? 0;
  horrorConfirmedValueEl.textContent = state.board?.horrorConfirmed ?? 0;
  phaseValueEl.textContent = state.runtime?.currentPhase ?? "idle";

  renderRouletteConfig(state.config?.rouletteItems || []);
  renderGaugeControls(state.boardItems || [], state.board?.gauges || {}, state.config?.gaugeMax || 100);
  renderPunishments(state.activePunishments || []);
  renderLogs(state.logs || []);
});

function formatConnectState(value) {
  switch (String(value || "").toLowerCase()) {
    case "connected":
      return "연결됨";
    case "connecting":
      return "연결 중";
    case "subscribed":
      return "연동 중";
    case "error":
      return "오류";
    case "idle":
    default:
      return "대기";
  }
}

async function refreshAuthStatus() {
  const response = await fetch("/api/chzzk/status", { credentials: "same-origin" });
  const data = await response.json();

  authLoggedInEl.textContent = data.isLoggedIn ? "완료" : "미완료";
  authConnectStateEl.textContent = formatConnectState(data.connectState || "idle");

  if (Array.isArray(data.missingEnv) && data.missingEnv.length) {
    showNotice(`환경 변수가 누락되었습니다.: ${data.missingEnv.join(", ")}`, true);
    return;
  }

  if (data.lastError) {
    showNotice(data.lastError, true);
    return;
  }

  hideNotice();
}

function renderRouletteConfig(items) {
  rouletteConfigListEl.innerHTML = items.map((item, index) => `
    <div class="card">
      <small>${escapeHtml(item.icon || "")}</small>
      <div class="inline-row">
        <input class="inline-input" data-r-field="value" data-r-index="${index}" type="number" value="${Number(item.value || 0)}" />
        <input class="inline-input" data-r-field="weight" data-r-index="${index}" type="number" step="0.01" value="${Number(item.weight || 0)}" />
        <button class="small" data-r-apply="${index}">적용</button>
      </div>
    </div>
  `).join("");

  rouletteConfigListEl.querySelectorAll("[data-r-apply]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.rApply);
      const nextItems = (latestState?.config?.rouletteItems || []).map((item) => ({ ...item }));
      const valueEl = rouletteConfigListEl.querySelector(`[data-r-field="value"][data-r-index="${index}"]`);
      const weightEl = rouletteConfigListEl.querySelector(`[data-r-field="weight"][data-r-index="${index}"]`);
      nextItems[index].value = Number(valueEl?.value || 0);
      nextItems[index].weight = Number(weightEl?.value || 0);
      socket.emit("admin:updateRouletteConfig", nextItems);
    });
  });
}

function renderGaugeControls(items, gauges, gaugeMax) {
  gaugeControlListEl.innerHTML = items.map((item) => `
    <div class="card">
      <div class="flex-box">
        <small class="small">${escapeHtml(item.label || item.key || "")}</small>
        <div class="stat">현재: ${Number(gauges[item.key] || 0)} / ${Number(gaugeMax || 100)}</div>
      </div>
      <div class="actions">
        <button class="small" data-g-change="${item.key}" data-g-delta="5">+5</button>
        <button class="small" data-g-change="${item.key}" data-g-delta="10">+10</button>
        <button class="small ghost" data-g-change="${item.key}" data-g-delta="-10">-10</button>
        <button class="small ghost" data-g-reset="${item.key}">0</button>
      </div>
    </div>
  `).join("");

  gaugeControlListEl.querySelectorAll("[data-g-change]").forEach((button) => {
    button.addEventListener("click", () => {
      socket.emit("admin:updateGauge", {
        key: button.dataset.gChange,
        delta: Number(button.dataset.gDelta || 0),
      });
    });
  });

  gaugeControlListEl.querySelectorAll("[data-g-reset]").forEach((button) => {
    button.addEventListener("click", () => {
      socket.emit("admin:setGauge", {
        key: button.dataset.gReset,
        value: 0,
      });
    });
  });
}

function renderPunishments(items) {
  const visible = items.filter(item => !item.done);

  if (!visible.length) {
    punishmentListEl.innerHTML = `<div class="card">활성 벌칙 없음</div>`;
    return;
  }

  punishmentListEl.innerHTML = visible.map(item => {
    const detail = item.detail ? `<div>${escapeHtml(item.detail)}</div>` : "";
    const timer = item.kind === "timer" ? `<div>남은 시간: ${item.remainingSec ?? 0}초</div>` : "";
    const completeBtn = item.kind === "timer" ? "" : `<button data-complete-id="${item.id}">완료 처리</button>`;

    return `
      <div class="card">
        <small>${escapeHtml(item.kind)}</small>
        <strong>${escapeHtml(item.title || "")}</strong>
        ${detail}
        ${timer}
        ${completeBtn}
      </div>
    `;
  }).join("");

  punishmentListEl.querySelectorAll("[data-complete-id]").forEach((button) => {
    button.addEventListener("click", () => {
      socket.emit("admin:completePunishment", Number(button.dataset.completeId));
    });
  });
}

function renderLogs(logs) {
  if (!logs.length) {
    logListEl.innerHTML = `<div class="card">로그 없음</div>`;
    return;
  }

  logListEl.innerHTML = logs.map(log => `
    <div class="card">
      <small>${escapeHtml(log.time || "")}</small>
      <div>${escapeHtml(log.message || "")}</div>
    </div>
  `).join("");
}

function showNotice(message, isError) {
  authNoticeEl.textContent = message;
  authNoticeEl.classList.remove("is-hidden");
  authNoticeEl.style.background = isError ? "rgba(255,78,78,0.14)" : "rgba(255,108,168,0.14)";
  authNoticeEl.style.borderColor = isError ? "rgba(255,78,78,0.28)" : "rgba(255,108,168,0.28)";
}

function hideNotice() {
  authNoticeEl.classList.add("is-hidden");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

(function init() {
  const params = new URLSearchParams(window.location.search);
  const chzzk = params.get("chzzk");
  const message = params.get("message");

  if (chzzk === "connected") {
    showNotice("후원 연동이 완료되었습니다.", false);
  } else if (chzzk === "error") {
    showNotice(message || "치지직 로그인 처리 중 오류가 발생했습니다.", true);
  } else {
    hideNotice();
  }

  refreshAuthStatus();
  setInterval(refreshAuthStatus, 5000);
})();
