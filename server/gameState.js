import axios from "axios";

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

const DEFAULT_LINE_TEXT_POOLS = {
  aegyo: [
    "5초 동안 애교 섞어서 인사하기",
    "하트 세 번 보내면서 감사 인사하기",
    "말 끝마다 사랑 붙이기",
    "가장 귀여운 목소리로 자기소개하기",
  ],
  blame: [
    "3초 동안 츤데레 말투로 혼내기",
    "장난스럽게 한마디 하기",
    "시청자에게 농담식으로 투덜대기",
    "도도한 말투로 반응해주기",
  ],
};

const LINE_SHEET_URLS = {
  aegyo:
    process.env.LINE_SHEET_AEGYO_URL ||
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYdgJl0NssjIFPmxcajkgHEKaI03lFknP94a_Q0ZPrA8WHV271uUSuDvk_2aXrdlr5JYzLmiq5gpFq/pub?gid=0&single=true&output=csv",
  blame:
    process.env.LINE_SHEET_BLAME_URL ||
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYdgJl0NssjIFPmxcajkgHEKaI03lFknP94a_Q0ZPrA8WHV271uUSuDvk_2aXrdlr5JYzLmiq5gpFq/pub?gid=1082447927&single=true&output=csv",
};

let punishmentSeq = 1;
const usedLineTextByPool = new Map();

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function createInitialGauges() {
  return Object.fromEntries(BOARD_ITEMS.map((item) => [item.key, 0]));
}

function createInitialLineTextState() {
  return {
    pools: clone(DEFAULT_LINE_TEXT_POOLS),
    source: {
      aegyo: LINE_SHEET_URLS.aegyo,
      blame: LINE_SHEET_URLS.blame,
    },
    counts: {
      aegyo: DEFAULT_LINE_TEXT_POOLS.aegyo.length,
      blame: DEFAULT_LINE_TEXT_POOLS.blame.length,
    },
    lastLoadedAt: null,
    lastError: null,
    isLoadedFromRemote: false,
  };
}

export const gameState = {
  connectedClients: {
    admin: 0,
    display: 0,
  },

  config: {
    minDonation: 1,
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

  lineTexts: createInitialLineTextState(),

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
    lineTexts: getLineTextPoolsStatus(),
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
  gameState.config.rouletteItems = items.map((item) => ({
    icon: String(item.icon ?? "🍋🍋🍋"),
    value: Number(item.value ?? 0),
    weight: Number(item.weight ?? 0),
  }));
}

function normalizeBool(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["true", "1", "y", "yes", "on"].includes(normalized);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(field);
      field = "";
      if (row.some((cell) => String(cell).length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((cell) => String(cell).length > 0)) {
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map((header) => String(header || "").trim());
  return rows.slice(1).map((values) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = values[index] ?? "";
    });
    return item;
  });
}

async function fetchCsvRows(url) {
  const response = await axios.get(url, {
    responseType: "text",
    transformResponse: [(data) => data],
    timeout: 15000,
  });
  return parseCsv(String(response.data || ""));
}

function buildPoolFromRows(rows) {
  return rows
    .filter((row) => normalizeBool(row.enabled))
    .map((row) => ({
      order: Number(row.order || 0),
      text: String(row.text ?? "").trim(),
    }))
    .filter((row) => row.text.length > 0)
    .sort((a, b) => a.order - b.order)
    .map((row) => row.text);
}

export async function loadLineTextPools() {
  const nextPools = clone(DEFAULT_LINE_TEXT_POOLS);

  try {
    const [aegyoRows, blameRows] = await Promise.all([
      fetchCsvRows(LINE_SHEET_URLS.aegyo),
      fetchCsvRows(LINE_SHEET_URLS.blame),
    ]);

    const aegyoPool = buildPoolFromRows(aegyoRows);
    const blamePool = buildPoolFromRows(blameRows);

    if (aegyoPool.length) nextPools.aegyo = aegyoPool;
    if (blamePool.length) nextPools.blame = blamePool;

    gameState.lineTexts.pools = nextPools;
    gameState.lineTexts.counts = {
      aegyo: nextPools.aegyo.length,
      blame: nextPools.blame.length,
    };
    gameState.lineTexts.lastLoadedAt = Date.now();
    gameState.lineTexts.lastError = null;
    gameState.lineTexts.isLoadedFromRemote = true;
    usedLineTextByPool.clear();

    addLog(
      `[LINES] 시트 새로고침 완료 (애교 ${nextPools.aegyo.length}개 / 매도 ${nextPools.blame.length}개)`
    );

    return getLineTextPoolsStatus();
  } catch (error) {
    const message =
      error?.response?.data?.message ||
      error?.message ||
      "대사 시트를 불러오지 못했습니다.";

    gameState.lineTexts.lastError = message;

    if (!gameState.lineTexts.lastLoadedAt) {
      gameState.lineTexts.pools = clone(DEFAULT_LINE_TEXT_POOLS);
      gameState.lineTexts.counts = {
        aegyo: gameState.lineTexts.pools.aegyo.length,
        blame: gameState.lineTexts.pools.blame.length,
      };
      gameState.lineTexts.isLoadedFromRemote = false;
    }

    addLog(`[LINES] 시트 새로고침 실패: ${message}`);
    throw error;
  }
}

export function getLineText(poolKey) {
  const pool = gameState.lineTexts.pools[poolKey] || [];
  if (!pool.length) return "대사 텍스트 없음";

  const used = usedLineTextByPool.get(poolKey) || new Set();
  const available = pool.filter((text) => !used.has(text));
  const source = available.length ? available : pool;
  const picked = source[Math.floor(Math.random() * source.length)];

  if (!available.length) {
    used.clear();
  }

  used.add(picked);
  usedLineTextByPool.set(poolKey, used);
  return picked;
}

export function getLineTextPoolsStatus() {
  return {
    counts: clone(gameState.lineTexts.counts),
    source: clone(gameState.lineTexts.source),
    lastLoadedAt: gameState.lineTexts.lastLoadedAt,
    lastError: gameState.lineTexts.lastError,
    isLoadedFromRemote: gameState.lineTexts.isLoadedFromRemote,
  };
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
