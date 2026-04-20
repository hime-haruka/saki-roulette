const socket = io({
  transports: ["websocket"],
  upgrade: false,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1500,
  timeout: 10000,
});

socket.on("connect_error", (error) => {
  console.error("[display] socket connect error", error?.message || error);
});

socket.on("disconnect", (reason) => {
  console.warn("[display] socket disconnected", reason);
});

const pointerEl = document.getElementById("boardPointer");
const overlayStackEl = document.getElementById("overlayStack");
const toastLayerEl = document.getElementById("toastLayer");
const gaugeRowsEl = document.getElementById("gaugeRows");
const roulettePopupEl = document.getElementById("roulettePopup");
const rouletteIconEl = document.getElementById("rouletteIcon");
const rouletteSpanEls = rouletteIconEl ? Array.from(rouletteIconEl.querySelectorAll("span")) : [];
const dicePopupEl = document.getElementById("dicePopup");
const dicePipsEl = document.getElementById("dicePips");

const CURSOR_POS = [
  { x: 130,  y: 820 },
  { x: 390,  y: 880 },
  { x: 600,  y: 895 },
  { x: 750,  y: 905 },
  { x: 880,  y: 910 },
  { x: 1020, y: 910 },
  { x: 1150, y: 905 },
  { x: 1310, y: 895 },
  { x: 1510, y: 880 },
  { x: 1750, y: 820 },
];
const CURSOR_OFFSET = { x: -18, y: -30 };
const CURSOR_ROT = [30, 18, 10, 4, 0, 0, -4, -10, -18, -30];
const gaugeTopList = [24, 59, 95, 130, 165, 201, 236, 272, 307, 343];
const roulettePool = ["🍋", "🍒", "🍇", "🍀", "🔔", "💎", "7️⃣", "💣"];

let rouletteSpinToken = 0;
let isRouletteSpinning = false;
let previousPosition = null;
let lastGaugeKey = "";
let lastOverlayKey = "";

socket.on("connect", () => {
  socket.emit("client:register", "display");
});

socket.on("state:update", (state) => {
  try {
    renderFromState(state);
  } catch (error) {
    console.error("[display] state:update render error", error);
  }
});

socket.on("game:move", async ({ position, fromPosition, dice }) => {
  await movePointerAnimated(position, fromPosition, dice);
});

socket.on("animation:rouletteStart", async () => {
  await playRouletteSpin();
});

socket.on("animation:rouletteEnd", async (roulette) => {
  await stopRouletteSpin(roulette?.icon || "🍋🍋🍋");
});

socket.on("animation:diceStart", () => {
  showDicePopup();
});

socket.on("animation:diceEnd", async (payload) => {
  const dice = typeof payload === "number" ? payload : payload?.dice;
  await playDiceRoll(dice ?? 1);
});

socket.on("ui:horrorStackToast", ({ stack }) => {
  showToast("공겜 스택 증가", `현재 ${stack} / 5`);
});

socket.on("ui:horrorConfirmToast", ({ confirmed }) => {
  showToast("공포게임 확정", `누적 ${confirmed}회 확정`);
});

function renderFromState(state) {
  const safeState = state || {};
  const board = safeState.board || {};
  const runtime = safeState.runtime || {};

  if (previousPosition === null) {
    applyPointerPosition(Number.isFinite(board.position) ? board.position : 0, false);
    previousPosition = Number.isFinite(board.position) ? board.position : 0;
  }

  const gaugeKey = JSON.stringify({ gauges: board.gauges, max: safeState.config?.gaugeMax });
  if (gaugeKey !== lastGaugeKey) {
    lastGaugeKey = gaugeKey;
    renderGaugeRows(safeState);
  }

  const overlayKey = JSON.stringify({ activePunishments: safeState.activePunishments, board: safeState.board });
  if (overlayKey !== lastOverlayKey) {
    lastOverlayKey = overlayKey;
    renderOverlayStack(safeState);
  }

  if (!isRouletteSpinning && runtime.currentRoulette?.icon) {
    setRouletteResult(runtime.currentRoulette.icon);
  }

  renderDiceFace(runtime.currentDice || 1);
}

function applyPointerPosition(position, animateHop = true) {
  if (!pointerEl) return;
  const point = CURSOR_POS[position] || CURSOR_POS[0];
  const rotation = CURSOR_ROT[position] || 0;
  pointerEl.style.left = `${point.x + CURSOR_OFFSET.x}px`;
  pointerEl.style.top = `${point.y + CURSOR_OFFSET.y}px`;
  pointerEl.style.transform = `rotate(${rotation}deg)`;

  if (animateHop) {
    pointerEl.classList.remove("is-hop");
    void pointerEl.offsetWidth;
    pointerEl.classList.add("is-hop");
  }
}

async function movePointerAnimated(position, fromPosition = null, dice = 1) {
  const total = CURSOR_POS.length;
  const start = Number.isInteger(fromPosition) ? fromPosition : previousPosition ?? 0;
  const steps = Math.max(1, Number(dice || 1));

  for (let step = 1; step <= steps; step += 1) {
    const target = (start + step) % total;
    applyPointerPosition(target, true);
    previousPosition = target;
    await sleep(step === steps ? 130 : 105);
  }

  if (previousPosition !== position) {
    applyPointerPosition(position, true);
    previousPosition = position;
  }
}

function renderOverlayStack(state) {
  if (!overlayStackEl) return;
  const items = Array.isArray(state?.activePunishments) ? state.activePunishments.filter(item => !item?.done) : [];
  const overlayHtml = [];
  const horrorStack = Number(state?.board?.horrorStack || 0);
  const horrorConfirmed = Number(state?.board?.horrorConfirmed || 0);

  if (horrorStack > 0 || horrorConfirmed > 0) {
    overlayHtml.push(renderHorrorCard({ stack: horrorStack, confirmed: horrorConfirmed }, state));
  }

  items.forEach((item) => {
    const kind = String(item?.kind || "normal");
    if (kind === "horror") return;
    if (kind === "timer") return overlayHtml.push(renderTimerCard(item));
    if (kind === "line") return overlayHtml.push(renderLineCard(item));
    overlayHtml.push(renderNormalCard(item));
  });

  overlayStackEl.innerHTML = overlayHtml.join("");
}

function renderTimerCard(item) {
  const totalSec = Math.max(0, Number(item?.remainingSec || 0));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  return `
    <section class="overlay-panel">
      <div class="timer-clock">
        <span>${pad2(h)}</span><em>시간</em>
        <span>${pad2(m)}</span><em>분</em>
        <span>${pad2(s)}</span><em>초</em>
      </div>
      <div class="overlay-content">${escapeHtml(item?.title || "타이머")}</div>
    </section>
  `;
}

function renderNormalCard(item) {
  return `
    <section class="overlay-panel">
      <div class="overlay-heading">일반 벌칙</div>
      <div class="overlay-content">${escapeHtml(item?.title || "일반 벌칙")}</div>
    </section>
  `;
}

function renderLineCard(item) {
  return `
    <section class="overlay-panel">
      <div class="overlay-heading">대사 벌칙</div>
      <div class="overlay-content">${escapeHtml(item?.detail || item?.title || "대사 없음")}</div>
    </section>
  `;
}

function renderHorrorCard(item, state) {
  const board = state?.board || {};
  const stack = Number(item?.stack ?? board.horrorStack ?? 0);
  const confirmed = Number(item?.confirmed ?? board.horrorConfirmed ?? 0);

  return `
    <section class="overlay-panel">
      <div class="overlay-heading">공겜 스택 미리보기</div>
      <div class="horror-preview">
        ${Array.from({ length: 5 }, (_, i) => `<div class="horror-chip ${i < stack ? "active" : ""}"></div>`).join("")}
      </div>
      <div class="overlay-subtext">확정 ${confirmed}회</div>
    </section>
  `;
}

function renderGaugeRows(state) {
  if (!gaugeRowsEl) return;
  const items = Array.isArray(state?.boardItems) ? state.boardItems : [];
  const gauges = state?.board?.gauges || {};
  const gaugeMax = Number(state?.config?.gaugeMax || 100);

  gaugeRowsEl.innerHTML = items.map((item, index) => {
    const top = gaugeTopList[index] ?? (24 + index * 35);
    const value = Number(gauges[item?.key] || 0);
    const width = clamp((value / gaugeMax) * 100, 0, 100);

    return `
      <div class="gauge-row" style="top:${top}px;">
        <div class="gauge-bar">
          <div class="gauge-fill" style="width:${width}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

async function playRouletteSpin() {
  if (!roulettePopupEl || !rouletteSpanEls.length) return;
  rouletteSpinToken += 1;
  const token = rouletteSpinToken;
  isRouletteSpinning = true;
  roulettePopupEl.classList.remove("is-hidden");
  rouletteSpanEls.forEach((span) => span.classList.add("is-spin"));

  const start = performance.now();
  while (performance.now() - start < 900) {
    if (token !== rouletteSpinToken) return;
    rouletteSpanEls.forEach((span) => { span.textContent = pickRandom(roulettePool); });
    await sleep(80);
  }
}

async function stopRouletteSpin(iconText) {
  if (!roulettePopupEl || !rouletteSpanEls.length) return;
  rouletteSpinToken += 1;
  isRouletteSpinning = false;

  const chars = splitRoulette(iconText);
  rouletteSpanEls.forEach((span, index) => {
    span.classList.remove("is-spin");
    span.textContent = chars[index] || "🍋";
  });

  await sleep(700);
  roulettePopupEl.classList.add("is-hidden");
}

function setRouletteResult(iconText) {
  const chars = splitRoulette(iconText);
  rouletteSpanEls.forEach((span, index) => {
    span.classList.remove("is-spin");
    span.textContent = chars[index] || "🍋";
  });
}

function showDicePopup() {
  if (dicePopupEl) dicePopupEl.classList.remove("is-hidden");
}

async function playDiceRoll(value) {
  if (!dicePopupEl) return;
  dicePopupEl.classList.remove("is-hidden");
  dicePopupEl.classList.remove("is-roll");
  void dicePopupEl.offsetWidth;
  dicePopupEl.classList.add("is-roll");

  for (let i = 0; i < 5; i += 1) {
    renderDiceFace(1 + Math.floor(Math.random() * 6));
    await sleep(80);
  }
  renderDiceFace(value);
  await sleep(700);
  dicePopupEl.classList.add("is-hidden");
}

function renderDiceFace(value) {
  if (!dicePipsEl) return;
  const face = clamp(Math.floor(Number(value || 1)), 1, 6);
  dicePipsEl.className = `dice-pips dice-face-${face}`;

  if (!dicePipsEl.dataset.ready) {
    dicePipsEl.dataset.ready = "1";
    dicePipsEl.innerHTML = `
      <span class="pip tl">♥</span>
      <span class="pip tr">♥</span>
      <span class="pip ml">♥</span>
      <span class="pip mc">♥</span>
      <span class="pip mr">♥</span>
      <span class="pip bl">♥</span>
      <span class="pip br">♥</span>
    `;
  }
}

function showToast(title, body) {
  if (!toastLayerEl) return;
  const card = document.createElement("section");
  card.className = "toast-card";
  card.innerHTML = `<strong>${escapeHtml(title)}</strong><div>${escapeHtml(body)}</div>`;
  toastLayerEl.prepend(card);
  setTimeout(() => card.remove(), 2400);
}

function splitRoulette(text) {
  const s = String(text || "");
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = new Intl.Segmenter("ko", { granularity: "grapheme" });
    const arr = Array.from(seg.segment(s), (x) => x.segment);
    return [arr[0] || "🍋", arr[1] || "🍋", arr[2] || "🍋"];
  }
  const keycaps = s.match(/\d\uFE0F?\u20E3/gu);
  if (keycaps && keycaps.length >= 3) return [keycaps[0], keycaps[1], keycaps[2]];
  const arr = Array.from(s);
  return [arr[0] || "🍋", arr[1] || "🍋", arr[2] || "🍋"];
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pad2(value) { return String(value).padStart(2, "0"); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
