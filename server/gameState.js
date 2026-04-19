const BOARD_ITEMS = [
  { key: "extend", label: "방송 1분 연장", kind: "timer", durationSec: 60 },
  { key: "aegyo", label: "애교 대사", kind: "line", linePoolKey: "aegyo" },
  { key: "song", label: "무반주 노래 1절", kind: "normal" },
  { key: "blame", label: "매도 대사", kind: "line", linePoolKey: "blame" },
  { key: "zero", label: "5분동안 00체", kind: "timer", durationSec: 300 },
  { key: "anthem", label: "냥체 애국가", kind: "normal" },
  { key: "squat", label: "스쿼트 5번", kind: "normal" },
  { key: "korean", label: "5분동안 한국어만 사용", kind: "timer", durationSec: 300 },
  { key: "horror", label: "공포게임", kind: "horror" },
  { key: "photo", label: "포토타임", kind: "normal" },
];

const DEFAULT_ROULETTE_ITEMS = [
  { icon: "7️⃣7️⃣7️⃣", value: 100, weight: 0.05 },
  { icon: "💎💎💎", value: 50, weight: 3.0 },
  { icon: "🔔🔔🔔", value: 30, weight: 9.0 },
  { icon: "🍀🍀🍀", value: 20, weight: 12.0 },
  { icon: "🍇🍇🍇", value: 15, weight: 15.0 },
  { icon: "🍒🍒🍒", value: 10, weight: 25.0 },
  { icon: "🍋🍋🍋", value: 5, weight: 30.0 },
  { icon: "💣💣💣", value: 0, weight: 5.95 },
];

const LINE_TEXT_POOLS = {
  aegyo: [
    "5초 동안 애교 섞어서 인사하기",
    "하트 세 번 보내면서 감사 인사하기",
    "말 끝마다 사랑 붙이기",
    "가장 귀여운 목소리로 자기소개하기"
  ],
  blame: [
    "3초 동안 츤데레 말투로 혼내기",
    "장난스럽게 한마디 하기",
    "시청자에게 농담식으로 투덜대기",
    "도도한 말투로 반응해주기"
  ]
};

let punishmentSeq = 1;
const usedLineTextByPool = new Map();

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function createInitialGauges() {
  return Object.fromEntries(BOARD_ITEMS.map(item => [item.key, 0]));
}

export const gameState = {
  connectedClients: {
    admin: 0,
    display: 0,
  },

  config: {
    minDonation: 3000,
    gaugeMax: 100,
    diceFaces: [1, 2, 3, 4, 5, 6],
    rouletteItems: clone(DEFAULT_ROULETTE_ITEMS),
  },

  boardItems: clone(BOARD_ITEMS),

  board: {
    position: 0,
    gauges: createInitialGauges(),
    horrorStack: 0,
    horrorConfirmed: 0,
  },

  runtime: {
    queue: [],
    totalDonations: 0,
    diceRollCount: 0,
    isProcessing: false,
    currentPhase: "idle",
    currentDonation: null,
    currentRoulette: null,
    currentDice: null,
  },

  activePunishments: [],
  logs: [],
};

export function addLog(message) {
  const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  gameState.logs.unshift({ time, message });
  if (gameState.logs.length > 120) {
    gameState.logs.length = 120;
  }
}

export function getPublicState() {
  return {
    connectedClients: gameState.connectedClients,
    config: gameState.config,
    boardItems: gameState.boardItems,
    board: gameState.board,
    runtime: gameState.runtime,
    activePunishments: gameState.activePunishments,
    logs: gameState.logs,
  };
}

export function getBoardItemByPosition(position) {
  return gameState.boardItems[position] || gameState.boardItems[0];
}

export function nextPunishmentId() {
  return punishmentSeq++;
}

export function getRouletteItems() {
  return gameState.config.rouletteItems;
}

export function setRouletteItems(items) {
  if (!Array.isArray(items) || !items.length) return;
  gameState.config.rouletteItems = items.map(item => ({
    icon: String(item.icon ?? "🍋🍋🍋"),
    value: Number(item.value ?? 0),
    weight: Number(item.weight ?? 0),
  }));
}

export function getLineText(poolKey) {
  const pool = LINE_TEXT_POOLS[poolKey] || [];
  if (!pool.length) return "대사 텍스트 없음";

  const used = usedLineTextByPool.get(poolKey) || new Set();
  const available = pool.filter(text => !used.has(text));
  const source = available.length ? available : pool;
  const picked = source[Math.floor(Math.random() * source.length)];

  if (!available.length) used.clear();

  used.add(picked);
  usedLineTextByPool.set(poolKey, used);
  return picked;
}

export function resetAllState() {
  gameState.board.position = 0;
  gameState.board.gauges = createInitialGauges();
  gameState.board.horrorStack = 0;
  gameState.board.horrorConfirmed = 0;

  gameState.runtime.queue = [];
  gameState.runtime.totalDonations = 0;
  gameState.runtime.diceRollCount = 0;
  gameState.runtime.isProcessing = false;
  gameState.runtime.currentPhase = "idle";
  gameState.runtime.currentDonation = null;
  gameState.runtime.currentRoulette = null;
  gameState.runtime.currentDice = null;

  gameState.activePunishments = [];
  gameState.logs = [];
  punishmentSeq = 1;
  usedLineTextByPool.clear();
}
