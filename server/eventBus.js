import {
  addLog,
  gameState,
  getBoardItemByPosition,
  getLineText,
  getPublicState,
  getRouletteItems,
  nextPunishmentId,
  resetAllState,
  setRouletteItems,
} from "./gameState.js";

function emitState(io) {
  io.emit("state:update", getPublicState());
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function weightedPick(items) {
  const total = items.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  let cursor = Math.random() * total;
  for (const item of items) {
    cursor -= Number(item.weight || 0);
    if (cursor <= 0) return item;
  }
  return items[items.length - 1];
}

function rollDice() {
  const faces = gameState.config.diceFaces;
  const index = Math.floor(Math.random() * faces.length);
  return faces[index];
}

function buildPunishment(boardItem) {
  const base = {
    id: nextPunishmentId(),
    boardKey: boardItem.key,
    boardLabel: boardItem.label,
    kind: boardItem.kind,
    createdAt: Date.now(),
    done: false,
  };

  if (boardItem.kind === "normal") {
    return {
      ...base,
      title: boardItem.label,
      detail: "일반 벌칙",
      requiresManual: true,
      autoHideAt: Date.now() + 5 * 60 * 1000,
    };
  }

  if (boardItem.kind === "line") {
    return {
      ...base,
      title: boardItem.label,
      detail: getLineText(boardItem.linePoolKey),
      requiresManual: true,
      autoHideAt: Date.now() + 5 * 60 * 1000,
    };
  }

  if (boardItem.kind === "timer") {
    return {
      ...base,
      title: boardItem.label,
      detail: "타이머 벌칙",
      durationSec: boardItem.durationSec,
      remainingSec: boardItem.durationSec,
      endsAt: Date.now() + boardItem.durationSec * 1000,
      requiresManual: false,
    };
  }

  if (boardItem.kind === "horror") {
    return {
      ...base,
      title: `공포게임 ${gameState.board.horrorConfirmed}회 확정`,
      detail: "누적 5회 달성",
      persistent: true,
      requiresManual: true,
      stack: gameState.board.horrorStack,
      confirmed: gameState.board.horrorConfirmed,
    };
  }

  return {
    ...base,
    title: boardItem.label,
    detail: "",
    requiresManual: true,
  };
}

function addOrExtendTimerPunishment(boardItem) {
  const existing = gameState.activePunishments.find(
    item => !item.done && item.kind === "timer" && item.boardKey === boardItem.key
  );

  if (existing) {
    existing.remainingSec += boardItem.durationSec;
    existing.endsAt += boardItem.durationSec * 1000;
    addLog(`${boardItem.label} 타이머가 연장되었습니다.`);
    return existing;
  }

  const created = buildPunishment(boardItem);
  gameState.activePunishments.push(created);
  addLog(`${boardItem.label} 타이머 벌칙이 시작되었습니다.`);
  return created;
}

function triggerPunishment(boardItem, io) {
  if (boardItem.kind === "horror") {
    gameState.board.horrorStack += 1;
    addLog(`공포게임 스택 +1 (${gameState.board.horrorStack}/5)`);
    io.emit("ui:horrorStackToast", {
      stack: gameState.board.horrorStack,
      confirmed: gameState.board.horrorConfirmed,
    });

    if (gameState.board.horrorStack >= 5) {
      gameState.board.horrorStack = 0;
      gameState.board.horrorConfirmed += 1;
      const horrorPunishment = buildPunishment(boardItem);
      gameState.activePunishments.push(horrorPunishment);
      addLog(`공포게임 ${gameState.board.horrorConfirmed}회 확정`);
      io.emit("ui:horrorConfirmToast", {
        confirmed: gameState.board.horrorConfirmed,
      });
    }
    return;
  }

  if (boardItem.kind === "timer") {
    addOrExtendTimerPunishment(boardItem);
    return;
  }

  const punishment = buildPunishment(boardItem);
  gameState.activePunishments.push(punishment);
  addLog(`${boardItem.label} 벌칙이 활성화되었습니다.`);
}

function applyGaugeAndPunishment(boardItem, gain, io) {
  if (gain <= 0) {
    addLog(`${boardItem.label} 칸 도착 / 💣 결과로 게이지 변화 없음`);
    return;
  }

  const current = gameState.board.gauges[boardItem.key] || 0;
  const next = current + gain;

  if (next >= gameState.config.gaugeMax) {
    gameState.board.gauges[boardItem.key] = 0;
    addLog(`${boardItem.label} 게이지 +${gain} 후 100 도달`);
    triggerPunishment(boardItem, io);
  } else {
    gameState.board.gauges[boardItem.key] = next;
    addLog(`${boardItem.label} 게이지 +${gain} → ${next}`);
  }
}

export function enqueueDonation(io, payload = {}) {
  const amount = Number(payload.amount || gameState.config.minDonation);
  const donorName = String(payload.donorName || "테스트 후원");

  if (amount < gameState.config.minDonation) {
    addLog(`${donorName} 후원 무시 (${amount} / 최소 ${gameState.config.minDonation})`);
    emitState(io);
    return;
  }

  const queueItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    donorName,
    amount,
    createdAt: Date.now(),
  };

  gameState.runtime.queue.push(queueItem);
  gameState.runtime.totalDonations += 1;
  addLog(`${donorName} ${amount.toLocaleString()}치즈 대기열 추가`);
  emitState(io);
  processQueue(io);
}

export async function processQueue(io) {
  if (gameState.runtime.isProcessing) return;
  if (gameState.runtime.queue.length === 0) {
    gameState.runtime.currentPhase = "idle";
    emitState(io);
    return;
  }

  gameState.runtime.isProcessing = true;

  while (gameState.runtime.queue.length > 0) {
    const donation = gameState.runtime.queue.shift();
    gameState.runtime.currentDonation = donation;
    gameState.runtime.currentPhase = "roulette";
    emitState(io);

    await delay(300);

    io.emit("animation:rouletteStart", { donation });
    emitState(io);

    await delay(1000);

    const roulette = weightedPick(getRouletteItems());
    gameState.runtime.currentRoulette = roulette;
    io.emit("animation:rouletteEnd", roulette);
    addLog(`룰렛 결과 ${roulette.icon} / +${roulette.value}`);
    emitState(io);

    await delay(500);

    const dice = rollDice();
    gameState.runtime.currentPhase = "dice";
    gameState.runtime.currentDice = dice;
    gameState.runtime.diceRollCount += 1;
    io.emit("animation:diceStart");
    emitState(io);

    await delay(400);

    io.emit("animation:diceEnd", { dice });
    addLog(`주사위 결과 ${dice}`);

    await delay(900);

    const fromPosition = gameState.board.position;
    const newPosition = (gameState.board.position + dice) % gameState.boardItems.length;
    gameState.board.position = newPosition;
    const boardItem = getBoardItemByPosition(newPosition);

    io.emit("game:move", { position: newPosition, fromPosition, boardItem, dice });
    gameState.runtime.currentPhase = "apply";
    applyGaugeAndPunishment(boardItem, roulette.value, io);
    emitState(io);

    await delay(300);

    gameState.runtime.currentPhase = "done";
    emitState(io);
    await delay(250);
  }

  gameState.runtime.isProcessing = false;
  gameState.runtime.currentPhase = "idle";
  gameState.runtime.currentDonation = null;
  gameState.runtime.currentRoulette = null;
  gameState.runtime.currentDice = null;
  emitState(io);
}

export function completePunishment(io, punishmentId) {
  const id = Number(punishmentId);
  const target = gameState.activePunishments.find(item => item.id === id);
  if (!target) return;
  target.done = true;
  target.completedAt = Date.now();
  addLog(`${target.title} 완료 처리`);
  emitState(io);
}

export function removeCompletedAndExpired(io) {
  const now = Date.now();
  let changed = false;

  for (const item of gameState.activePunishments) {
    if (item.kind === "timer" && !item.done) {
      const nextRemaining = Math.max(0, Math.ceil((item.endsAt - now) / 1000));
      if (nextRemaining !== item.remainingSec) {
        item.remainingSec = nextRemaining;
        changed = true;
      }
      if (item.remainingSec <= 0) {
        item.done = true;
        item.completedAt = now;
        addLog(`${item.title} 타이머 종료`);
        changed = true;
      }
    }

    if ((item.kind === "normal" || item.kind === "line") && !item.done && item.autoHideAt && item.autoHideAt <= now) {
      item.done = true;
      item.completedAt = now;
      addLog(`${item.title} 자동 종료`);
      changed = true;
    }
  }

  const before = gameState.activePunishments.length;
  gameState.activePunishments = gameState.activePunishments.filter(item => {
    if (item.kind === "horror") return true;
    if (!item.done) return true;
    if (item.kind === "timer") return now - item.completedAt < 60000;
    return now - item.completedAt < 30000;
  });

  if (before !== gameState.activePunishments.length) changed = true;
  if (changed) emitState(io);
}

export function updateRouletteConfig(io, items) {
  setRouletteItems(items);
  addLog("룰렛 설정이 변경되었습니다.");
  emitState(io);
}

export function manualReset(io) {
  const adminCount = gameState.connectedClients.admin;
  const displayCount = gameState.connectedClients.display;
  resetAllState();
  gameState.connectedClients.admin = adminCount;
  gameState.connectedClients.display = displayCount;
  addLog("수동 초기화");
  emitState(io);
}

export function registerSocketEvents(io, socket) {
  socket.on("client:register", role => {
    socket.data.role = role;

    if (role === "admin") gameState.connectedClients.admin += 1;
    if (role === "display") gameState.connectedClients.display += 1;

    emitState(io);
  });

  socket.on("disconnect", () => {
    const role = socket.data.role;
    if (role === "admin" && gameState.connectedClients.admin > 0) gameState.connectedClients.admin -= 1;
    if (role === "display" && gameState.connectedClients.display > 0) gameState.connectedClients.display -= 1;
    emitState(io);
  });

  socket.on("admin:enqueueDonation", payload => {
    enqueueDonation(io, payload);
  });

  socket.on("admin:updateRouletteConfig", items => {
    updateRouletteConfig(io, items);
  });

  socket.on("admin:updateGauge", ({ key, delta }) => {
    if (!key || !(key in gameState.board.gauges)) return;
    const next = Math.max(
      0,
      Math.min(
        gameState.config.gaugeMax,
        Number(gameState.board.gauges[key] || 0) + Number(delta || 0)
      )
    );
    gameState.board.gauges[key] = next;
    addLog(`${key} 게이지 수동 조정 → ${next}`);
    emitState(io);
  });

  socket.on("admin:setGauge", ({ key, value }) => {
    if (!key || !(key in gameState.board.gauges)) return;
    const next = Math.max(0, Math.min(gameState.config.gaugeMax, Number(value || 0)));
    gameState.board.gauges[key] = next;
    addLog(`${key} 게이지 수동 설정 → ${next}`);
    emitState(io);
  });

  socket.on("admin:completePunishment", punishmentId => {
    completePunishment(io, punishmentId);
  });

  socket.on("admin:resetAll", () => {
    manualReset(io);
  });
}
