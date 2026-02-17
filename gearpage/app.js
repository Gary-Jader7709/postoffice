const DATA_URL = "./data/clean_dataset.json";
const LS_KEY = "gearpage_custom_records_v2";
const THEME_KEY = "gearpage_theme_v1";

// ========= utils =========
function norm(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .trim()
    .replace(/\s+/g, "")
    .replace(/臺/g, "台")
    .replace(/号/g, "號");
}

function expandAbbr(s) {
  let t = norm(s);
  t = t.replace(/ST|st/g, "街");
  t = t.replace(/R/g, "路");
  t = t.replace(/L/g, "巷");
  t = t.replace(/A/g, "弄");
  t = t.replace(/F/g, "樓");
  t = t.replace(/NO:(\d+)/g, "$1號");
  return t;
}

function stripRoadSuffix(s) {
  return norm(s).replace(/(路|街|大道|段)$/g, "");
}

// 解析「使用者輸入的地址字串」用（用來做精準/半精準 key）
function parseAddress(input) {
  const raw = expandAbbr(input);

  // road
  const roadMatch = raw.match(/^(.+?(路|街|大道|段))/);
  const road = roadMatch ? roadMatch[1] : "";

  // no
  const noMatch = raw.match(/(\d+)(之(\d+))?號/);
  const noMain = noMatch ? noMatch[1] : "";
  const noSub = noMatch && noMatch[3] ? noMatch[3] : "";

  // floor
  const floorMatch = raw.match(/(\d+)樓/);
  const floor = floorMatch ? floorMatch[1] : "";

  // lane / alley (optional)
  const laneMatch = raw.match(/(\d+)巷/);
  const lane = laneMatch ? laneMatch[1] : "";
  const alleyMatch = raw.match(/(\d+)弄/);
  const alley = alleyMatch ? alleyMatch[1] : "";

  return { raw, road, noMain, noSub, floor, lane, alley };
}

function makeKey(road, noMain, noSub, floor) {
  return `${road}|${noMain}|${noSub}|${floor}`;
}
function makeKeyNoFloor(road, noMain, noSub) {
  return `${road}|${noMain}|${noSub}|`;
}

function isEmptyValue(v) {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

// ========= data =========
let baseRecords = [];
let customRecords = [];
let index = new Map(); // key -> candidates
let allPayloads = [];  // for fuzzy search

async function loadBase() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`底庫載入失敗：${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("底庫不是陣列 JSON");
  baseRecords = data;
}

function loadCustom() {
  try {
    const x = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    customRecords = Array.isArray(x) ? x : [];
  } catch {
    customRecords = [];
  }
}

function saveCustom() {
  localStorage.setItem(LS_KEY, JSON.stringify(customRecords));
}

function toIntOrNull(v) {
  const n = Number(String(v ?? "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function candidateSort(list) {
  const copy = [...list];

  copy.sort((a, b) => {
    // custom first
    if (a.source !== b.source) return a.source === "custom" ? -1 : 1;

    // box no ascending if numeric
    const an = toIntOrNull(a.boxNo);
    const bn = toIntOrNull(b.boxNo);
    if (an !== null && bn !== null && an !== bn) return an - bn;

    // then address string
    return a.addrNorm.localeCompare(b.addrNorm, "zh-Hant");
  });

  // dedupe by (source + addrNorm + boxNo)
  const seen = new Set();
  const out = [];
  for (const x of copy) {
    const k = `${x.source}|${x.addrNorm}|${x.boxNo}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function rebuildIndex() {
  index = new Map();
  allPayloads = [];

  const all = [
    ...baseRecords.map(r => ({ ...r, _source: "base" })),
    ...customRecords.map(r => ({ ...r, _source: "custom" })),
  ];

  for (const r of all) {
    // 你的 JSON 欄位：地址_norm / 地址 / display
    const addrNorm = norm(r["地址_norm"] || r.addr_norm || r.full_address || r.address);
    const addrRaw = norm(r["地址"] || r.addr || r.address || "");
    const display = norm(r.display || "");

    // 對於查詢展示：優先 addrNorm，沒有就 display，再沒有就 addrRaw
    const addrForParse = addrNorm || display || addrRaw;

    // 你的 JSON 已經拆好 road/no/floor，也可能有空
    // 但我們仍做 fallback：如果缺 road/no，才用 parseAddress 從 addrForParse 抓
    let road = norm(r.road || "");
    let noMain = norm(r.no || "");
    let noSub = ""; // 你的資料看起來沒拆之號，先留空
    let floor = norm(r.floor || "");
    let lane = norm(r.lane || "");
    let alley = norm(r.alley || "");

    if (!road || !noMain) {
      const p = parseAddress(addrForParse);
      road = road || p.road;
      noMain = noMain || p.noMain;
      noSub = noSub || p.noSub;
      floor = floor || p.floor;
      lane = lane || p.lane;
      alley = alley || p.alley;
    }

    // 沒路或沒號就不做精準索引，但仍可用模糊搜尋
    const boxNo = r.boxNo ?? r.box_no ?? r["箱號_int"] ?? r["箱號"] ?? "";
    const note = r.note ?? r["備註"] ?? "";

    const payload = {
      source: r._source,
      row_id: r.row_id ?? r["row_id"] ?? null,
      boxNo: String(boxNo ?? "").trim(),
      note: isEmptyValue(note) ? "" : String(note),
      display: addrNorm || display || addrRaw,   // 顯示用
      addrNorm: addrNorm || display || addrRaw,  // 統一給搜尋用
      addrRaw,
      road,
      roadKey: stripRoadSuffix(road),
      noMain,
      noSub,
      floor: floor.replace("樓", ""),
      lane,
      alley,
      raw: r
    };

    allPayloads.push(payload);

    if (!road || !noMain) continue;

    const k1 = makeKey(road, noMain, noSub, payload.floor);
    const k2 = makeKeyNoFloor(road, noMain, noSub);

    if (!index.has(k1)) index.set(k1, []);
    index.get(k1).push(payload);

    if (!index.has(k2)) index.set(k2, []);
    index.get(k2).push(payload);
  }

  // debug: 看索引是否正常建立
  console.log("indexed payloads:", allPayloads.length, "index keys:", index.size);
}

// ========= fuzzy search =========
function fuzzySearch(q, limit = 50) {
  const query = stripRoadSuffix(expandAbbr(q));
  if (!query) return [];

  const scored = [];

  for (const x of allPayloads) {
    const addr = x.addrNorm || "";
    const roadKey = x.roadKey || "";
    const box = String(x.boxNo || "");

    let score = 9999;
    let hit = false;

    // road match
    if (roadKey && roadKey === query) { score = 0; hit = true; }
    else if (roadKey && roadKey.startsWith(query)) { score = 6; hit = true; }
    else if (roadKey && roadKey.includes(query)) { score = 12; hit = true; }

    // address contains
    if (!hit && addr.includes(query)) { score = 20; hit = true; }

    // box contains
    if (!hit && box && box.includes(query)) { score = 25; hit = true; }

    if (hit) {
      if (x.source === "custom") score -= 2;
      scored.push({ score, x });
    }
  }

  scored.sort((a, b) => a.score - b.score);
  const out = [];
  const seen = new Set();

  for (const s of scored) {
    const k = `${s.x.source}|${s.x.addrNorm}|${s.x.boxNo}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s.x);
    if (out.length >= limit) break;
  }

  return candidateSort(out);
}

// ========= UI =========
const el = (id) => document.getElementById(id);
const statusEl = el("status");
const resultEl = el("result");
const qEl = el("q");

// add form
const addAddrEl = el("addAddr");
const addBoxEl = el("addBox");
const addNoteEl = el("addNote");
const addMsgEl = el("addMsg");
const customListEl = el("customList");

function renderResults(list, mode, parsed) {
  resultEl.innerHTML = "";

  if (!list || list.length === 0) {
    resultEl.innerHTML = `
      <div class="item">
        <b>查無結果（${mode}）</b>
        <div class="muted">輸入：${norm(qEl.value) || "(空)"}</div>
        ${
          parsed
            ? `<div class="muted">解析：${parsed.road || "?"}${parsed.noMain ? parsed.noMain+"號" : ""}${parsed.floor ? parsed.floor+"樓" : ""}</div>`
            : ""
        }
      </div>
    `;
    return;
  }

  const finalList = candidateSort(list);

  const html = finalList.map(x => `
    <div class="item">
      <div><b>${x.display}</b></div>
      <div class="muted">廂號：<b>${x.boxNo || "(空)"}</b>　來源：${x.source === "custom" ? "自建" : "底庫"}</div>
      ${x.note ? `<div class="muted">備註：${x.note}</div>` : ""}
    </div>
  `).join("");

  resultEl.innerHTML = `
    <div class="muted">找到 ${finalList.length} 筆（${mode}｜自建優先）</div>
    ${html}
  `;
}

// ====== 查詢模式：地址查 / 廂號查 ======
let SEARCH_MODE = "addr"; // "addr" | "box"

// 初始化模式按鈕（如果 HTML 還沒加按鈕，這段也不會噴錯）
(function initSearchModeButtons() {
  const btnAddr = el("modeAddr");
  const btnBox = el("modeBox");

  if (!btnAddr || !btnBox) return;

  function setMode(mode) {
    SEARCH_MODE = mode;

    if (mode === "addr") {
      btnAddr.classList.add("primary");
      btnBox.classList.remove("primary");
      qEl.placeholder = "地址查廂號：例 中山路123號2樓 / 太子R200L79A32F2";
    } else {
      btnBox.classList.add("primary");
      btnAddr.classList.remove("primary");
      qEl.placeholder = "廂號查地址：例 37（可重號，會列出多筆）";
    }

    resultEl.innerHTML = "";
    qEl.value = "";
  }

  btnAddr.addEventListener("click", () => setMode("addr"));
  btnBox.addEventListener("click", () => setMode("box"));

  // 預設模式（配合你 HTML 一開始是地址查）
  setMode("addr");
})();

// 廂號反查：輸入 37 → 找所有箱號=37 的地址（重號就列多筆）
function searchByBoxNo(input) {
  const q = norm(input);
  const digits = q.replace(/[^\d]/g, ""); // 只留數字
  if (!digits) return [];

  // 精準比對：箱號完全等於 digits
  const exact = allPayloads.filter(x =>
    String(x.boxNo || "").replace(/[^\d]/g, "") === digits
  );
  if (exact.length > 0) return exact;

  // 找不到再退一步：包含（例如輸入 3 想看 30~39 之類）
  const contains = allPayloads.filter(x =>
    String(x.boxNo || "").includes(digits)
  );
  return contains;
}

// ====== 覆蓋這個：新版 doSearch（依模式分流）======
function doSearch() {
  const input = qEl.value;

  // ① 廂號查地址（反查）
  if (SEARCH_MODE === "box") {
    const list = searchByBoxNo(input);
    const finalList = candidateSort(list); // 你原本就有：自建優先 + 去重/排序
    renderResults(finalList, "廂號反查", null);
    return;
  }

  // ② 地址查廂號（原本邏輯）
  const parsed = parseAddress(input);

  // 有路+號 => 優先精準
  if (parsed.road && parsed.noMain) {
    const k1 = makeKey(parsed.road, parsed.noMain, parsed.noSub, parsed.floor);
    const k2 = makeKeyNoFloor(parsed.road, parsed.noMain, parsed.noSub);

    const exact = index.get(k1) || [];
    const noFloor = index.get(k2) || [];

    if (exact.length > 0) {
      renderResults(exact, "精準匹配", parsed);
      return;
    }
    if (noFloor.length > 0) {
      renderResults(noFloor, "同地址（忽略樓層）", parsed);
      return;
    }

    // 精準找不到 -> 模糊
    const fuzzy = fuzzySearch(input, 50);
    renderResults(fuzzy, "模糊搜尋", parsed);
    return;
  }

  // 沒路號（例如只打 太子 / 太子路 / 240）-> 模糊
  const fuzzy = fuzzySearch(input, 50);
  renderResults(fuzzy, "模糊搜尋", parsed);
}


// ========= add / manage custom =========
function renderCustomList() {
  customListEl.innerHTML = "";
  if (customRecords.length === 0) {
    customListEl.innerHTML = `<div class="muted">目前沒有自建資料。</div>`;
    return;
  }

  customListEl.innerHTML = customRecords.map((r, i) => `
    <div class="rowItem">
      <div class="meta">
        <div><b>${r["地址_norm"] || r.full_address || r.address || r.display || ""}</b></div>
        <div class="muted">廂號：<b>${r["箱號_int"] ?? r.boxNo ?? ""}</b>${r["備註"] ? `　備註：${r["備註"]}` : ""}</div>
      </div>
      <button class="btn danger" data-del="${i}">刪除</button>
    </div>
  `).join("");

  customListEl.querySelectorAll("button[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.del);
      customRecords.splice(idx, 1);
      saveCustom();
      rebuildIndex();
      renderCustomList();
    });
  });
}

function addRecord() {
  const addrInput = addAddrEl.value;
  const boxNo = norm(addBoxEl.value);
  const note = addNoteEl.value?.trim() || "";

  if (!addrInput || !boxNo) {
    addMsgEl.textContent = "請填地址與廂號。";
    return;
  }

  const addrNorm = norm(expandAbbr(addrInput));
  const p = parseAddress(addrNorm);

  // 至少要能抓到路+號，否則自建也不好查
  if (!p.road || !p.noMain) {
    addMsgEl.textContent = "地址解析失敗：至少要有 路/街 + 門牌號（例：太子路200號）。";
    return;
  }

  // 允許同地址不同廂號，但不允許同地址同廂號重複
  const exists = customRecords.some(x => norm(x["地址_norm"] || x.full_address) === addrNorm && String(x["箱號_int"] ?? x.boxNo) === boxNo);
  if (exists) {
    addMsgEl.textContent = "已存在同地址同廂號的自建資料。";
    return;
  }

  // 你的底庫 schema：我用一樣欄位命名存
  const rec = {
    _source: "custom",
    id: crypto.randomUUID(),
    row_id: null,
    箱號_int: Number.isFinite(Number(boxNo)) ? Number(boxNo) : boxNo,
    display: addrNorm,
    road: p.road,
    section: null,
    lane: p.lane ? Number(p.lane) : null,
    alley: p.alley ? Number(p.alley) : null,
    no: p.noMain,
    floor: p.floor || null,
    備註: note || "",
    地址: addrNorm,
    地址_norm: addrNorm,
    issues: ""
  };

  customRecords.unshift(rec);
  saveCustom();
  rebuildIndex();
  renderCustomList();

  addAddrEl.value = "";
  addBoxEl.value = "";
  addNoteEl.value = "";
  addMsgEl.textContent = "新增完成 ✅";
}

function exportCustom() {
  const blob = new Blob([JSON.stringify(customRecords, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "custom_records.json";
  a.click();
  URL.revokeObjectURL(url);
}

async function importCustom(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("檔案內容不是陣列");

  // 合併去重：用 id 或 地址_norm+箱號
  const map = new Map();
  for (const r of customRecords) {
    const key = r.id || `${norm(r["地址_norm"])}|${r["箱號_int"] ?? ""}`;
    map.set(key, r);
  }
  for (const r of data) {
    if (!r) continue;
    const addrNorm = norm(r["地址_norm"] || r.full_address || r.address || r.display);
    const box = r["箱號_int"] ?? r.boxNo ?? r["箱號"];
    if (!addrNorm || isEmptyValue(box)) continue;

    const key = r.id || `${addrNorm}|${box}`;
    map.set(key, { ...r, _source: "custom" });
  }

  customRecords = Array.from(map.values());
  saveCustom();
  rebuildIndex();
  renderCustomList();
}

function wipeCustom() {
  if (!confirm("確定要清空此台電腦的自建資料？")) return;
  customRecords = [];
  saveCustom();
  rebuildIndex();
  renderCustomList();
}

// ========= theme =========
function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const theme = saved || "dark";
  document.documentElement.setAttribute("data-theme", theme);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
}

// ========= init =========
async function init() {
  loadTheme();
  statusEl.textContent = "載入中…";

  await loadBase();
  loadCustom();
  rebuildIndex();
  renderCustomList();

  statusEl.textContent = `底庫 ${baseRecords.length} 筆，自建 ${customRecords.length} 筆（可新增）`;
}

el("searchBtn").addEventListener("click", doSearch);
el("clearBtn").addEventListener("click", () => { qEl.value = ""; resultEl.innerHTML = ""; });
qEl.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

el("addBtn").addEventListener("click", addRecord);

el("exportBtn").addEventListener("click", exportCustom);
el("importFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try { await importCustom(f); }
  catch (err) { alert("匯入失敗：" + err.message); }
  finally { e.target.value = ""; }
});
el("wipeBtn").addEventListener("click", wipeCustom);

el("themeBtn").addEventListener("click", toggleTheme);

init().catch(err => {
  statusEl.textContent = "初始化失敗：" + err.message;
  console.error(err);
});
