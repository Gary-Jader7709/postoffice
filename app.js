// app.js (ES module)
// 需要 Supabase：這裡用 ESM CDN（避免 script tag 全域變數問題）
// 來源：Supabase 官方建議可用 CDN；esm.sh 是常見的無打包方案。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ====== 1) 你要改這兩個（Supabase 專案 Settings → API 可拿到） ======
const SUPABASE_URL = 'https://nwxoduqhgjmseosgweqj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_wF1Vq7wOdv2EOQUPWSULcA_MtAhFf7X';

// 你的 Postgres RPC 函式名稱（下面我給你 SQL 直接貼進 Supabase）
const RPC_SEARCH = 'search_mailboxes';
const RPC_UPDATE = 'update_mailbox';
const RPC_INSERT = 'insert_mailbox';

// ====== 2) localStorage keys ======
const THEME_KEY = 'po_theme_v1';
const UNLOCK_KEY = 'po_edit_unlocked_v1';
const PASS_KEY = 'po_edit_pass_v1'; // ⚠️ 只給你媽用、單一裝置：才建議記住

// ====== 3) init ======
if (!SUPABASE_URL.startsWith('http')) {
  console.warn('你還沒填 SUPABASE_URL / SUPABASE_ANON_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ====== 4) DOM helpers ======
const el = (id) => document.getElementById(id);
const statusEl = el('status');
const resultEl = el('result');
const qEl = el('q');
const editModeBtn = el('editModeBtn');
const themeBtn = el('themeBtn');
const newBtn = el('newBtn');

// search mode: all | addr | box | borrower
let SEARCH_MODE = 'all';
let EDIT_UNLOCKED = false;

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function normInput(s) {
  return String(s ?? '').trim();
}

// ====== 5) Theme ======
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') applyTheme(saved);
}

themeBtn?.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

// ====== 6) Modal (unlock + edit) ======
function mountModals() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div id="unlockBackdrop" class="modalBackdrop" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true">
        <h3>解鎖編輯模式</h3>
        <div class="muted">輸入通關碼後，此裝置會記住（你選 B1）。</div>
        <input id="unlockPass" class="input" type="password" placeholder="通關碼" autocomplete="current-password" />
        <div class="row">
          <button id="unlockCancel" class="btn" type="button">取消</button>
          <button id="unlockOk" class="btn primary" type="button">解鎖</button>
        </div>
        <div id="unlockMsg" class="help"></div>
      </div>
    </div>

    <div id="editBackdrop" class="modalBackdrop" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true">
        <h3 id="editTitle">編輯資料</h3>

        <div class="grid2">
          <div>
            <label class="label">廂號（box_no）</label>
            <input id="fBox" class="input" placeholder="例：37" />
          </div>
          <div>
            <label class="label">樓層（floor）</label>
            <input id="fFloor" class="input" placeholder="例：2" />
          </div>
        </div>

        <label class="label">姓名 / 公司名（borrower）</label>
        <input id="fBorrower" class="input" placeholder="例：王小明 / XX股份有限公司" />

        <label class="label">地址（address）</label>
        <input id="fAddress" class="input" placeholder="例：新進路123號" />

        <label class="label">備註（note）</label>
        <input id="fNote" class="input" placeholder="可空" />

        <label class="label">來源（source）</label>
        <input id="fSource" class="input" placeholder="可空" />

        <div class="row">
          <button id="editCancel" class="btn" type="button">取消</button>
          <button id="editSave" class="btn primary" type="button">儲存</button>
        </div>
        <div id="editMsg" class="help"></div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
}
mountModals();

const unlockBackdrop = el('unlockBackdrop');
const unlockPass = el('unlockPass');
const unlockCancel = el('unlockCancel');
const unlockOk = el('unlockOk');
const unlockMsg = el('unlockMsg');

const editBackdrop = el('editBackdrop');
const editTitle = el('editTitle');
const fBox = el('fBox');
const fFloor = el('fFloor');
const fBorrower = el('fBorrower');
const fAddress = el('fAddress');
const fNote = el('fNote');
const fSource = el('fSource');
const editCancel = el('editCancel');
const editSave = el('editSave');
const editMsg = el('editMsg');

let editingId = null;
let editingIsNew = false;

function showModal(backdropEl) {
  backdropEl.classList.add('show');
  backdropEl.setAttribute('aria-hidden', 'false');
}
function hideModal(backdropEl) {
  backdropEl.classList.remove('show');
  backdropEl.setAttribute('aria-hidden', 'true');
}

unlockCancel?.addEventListener('click', () => hideModal(unlockBackdrop));
editCancel?.addEventListener('click', () => hideModal(editBackdrop));

// ====== 7) Edit unlock ======
function setUnlocked(on) {
  EDIT_UNLOCKED = !!on;
  localStorage.setItem(UNLOCK_KEY, on ? '1' : '0');
  editModeBtn.textContent = on ? '編輯模式：已解鎖' : '編輯模式：未解鎖';
  if (newBtn) newBtn.style.display = on ? 'inline-flex' : 'none';
  // 重新渲染結果，讓「編輯」按鈕出現
  if (lastResults) renderResults(lastResults);
}

function getSavedPass() {
  return localStorage.getItem(PASS_KEY) || '';
}

async function tryUnlock(pass) {
  // 用一個「不改資料」的方式驗證通關碼：
  // 這裡用 update_mailbox 對不存在 id 的更新一定會失敗。
  // 所以我們改成呼叫 insert_mailbox 但不給必填欄位也會失敗。
  // 最穩的方式：你在 SQL 另外做一個 check_pass(pass) RPC。
  // 為了少一個函式，我們用 update_mailbox 對 random UUID，SQL 端會先驗 pass，再查 id；
  // pass 不對會直接回錯。
  const fakeId = crypto.randomUUID();
  const { error } = await supabase.rpc(RPC_UPDATE, {
    pass,
    p_id: fakeId,
    p_box_no: null,
    p_floor: null,
    p_borrower: null,
    p_address: null,
    p_note: null,
    p_source: null,
  });

  // 只要不是「通關碼錯誤」就算 pass 正確；
  // 因為 fakeId 不存在會報另一種錯。
  if (!error) return true;

  const msg = String(error.message || error);
  if (msg.toLowerCase().includes('invalid passcode')) return false;
  return true;
}

editModeBtn?.addEventListener('click', async () => {
  if (EDIT_UNLOCKED) {
    // 讓你能一鍵鎖回去
    if (confirm('要鎖回未解鎖狀態嗎？')) {
      setUnlocked(false);
    }
    return;
  }
  unlockMsg.textContent = '';
  unlockPass.value = '';
  showModal(unlockBackdrop);
  setTimeout(() => unlockPass.focus(), 50);
});

unlockOk?.addEventListener('click', async () => {
  const pass = normInput(unlockPass.value);
  if (!pass) {
    unlockMsg.textContent = '請輸入通關碼';
    return;
  }
  unlockMsg.textContent = '驗證中…';
  const ok = await tryUnlock(pass);
  if (!ok) {
    unlockMsg.textContent = '通關碼錯誤';
    return;
  }
  localStorage.setItem(PASS_KEY, pass);
  setUnlocked(true);
  hideModal(unlockBackdrop);
});

// ====== 8) Search mode buttons ======
function setMode(mode) {
  SEARCH_MODE = mode;
  const btns = [
    ['modeAll', 'all'],
    ['modeAddr', 'addr'],
    ['modeBox', 'box'],
    ['modeBorrower', 'borrower'],
  ];
  for (const [id, m] of btns) {
    const b = el(id);
    if (!b) continue;
    if (m === mode) b.classList.add('primary');
    else b.classList.remove('primary');
  }
}
el('modeAll')?.addEventListener('click', () => setMode('all'));
el('modeAddr')?.addEventListener('click', () => setMode('addr'));
el('modeBox')?.addEventListener('click', () => setMode('box'));
el('modeBorrower')?.addEventListener('click', () => setMode('borrower'));
setMode('all');

// ====== 9) Search + render ======
let lastResults = [];

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderResults(rows) {
  lastResults = Array.isArray(rows) ? rows : [];
  resultEl.innerHTML = '';

  if (!rows || rows.length === 0) {
    resultEl.innerHTML = `
      <div class="item">
        <b>查無結果</b>
        <div class="muted">搜尋：${escapeHtml(qEl.value || '(空)')}（模式：${escapeHtml(SEARCH_MODE)}）</div>
      </div>
    `;
    return;
  }

  const html = rows.map(r => {
    const box = r.box_no ?? '';
    const borrower = r.borrower ?? '';
    const addr = r.address ?? '';
    const floor = r.floor ?? '';
    const note = r.note ?? '';
    const source = r.source ?? '';
    const id = r.id;

    const title1 = borrower || '(未填姓名/公司)';
    const title2 = floor ? `${addr} ${floor}樓` : addr;
    const subParts = [];
    if (note) subParts.push(`備註：${escapeHtml(note)}`);
    if (source) subParts.push(`來源：${escapeHtml(source)}`);

    return `
      <div class="item">
        <div class="resultCard">
          <div class="boxBadge">${escapeHtml(box || '—')}</div>
          <div class="cardMain">
            <div class="title">${escapeHtml(title1)}</div>
            <div class="title">${escapeHtml(title2 || '(未填地址)')}</div>
            ${subParts.length ? `<div class="sub">${subParts.join('　')}</div>` : `<div class="sub">&nbsp;</div>`}
            <div class="cardActions" style="${EDIT_UNLOCKED ? '' : 'display:none;'}">
              <button class="btn" data-edit="${escapeHtml(id)}">編輯</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  resultEl.innerHTML = `
    <div class="muted">找到 ${rows.length} 筆（模式：${escapeHtml(SEARCH_MODE)}）</div>
    ${html}
  `;

  if (EDIT_UNLOCKED) {
    resultEl.querySelectorAll('button[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-edit');
        const row = rows.find(x => String(x.id) === String(id));
        if (!row) return;
        openEditModal(row);
      });
    });
  }
}

async function doSearch() {
  const q = normInput(qEl.value);
  setStatus('查詢中…');

  const { data, error } = await supabase.rpc(RPC_SEARCH, {
    q,
    mode: SEARCH_MODE,
    lim: 100,
  });

  if (error) {
    console.error(error);
    setStatus(`查詢失敗：${error.message || error}`);
    renderResults([]);
    return;
  }

  setStatus('');
  renderResults(data || []);
}

el('searchBtn')?.addEventListener('click', doSearch);
qEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});
el('clearBtn')?.addEventListener('click', () => {
  qEl.value = '';
  setStatus('');
  renderResults([]);
});

// ====== 10) Edit / Insert ======
function openEditModal(row) {
  editingIsNew = false;
  editingId = row.id;
  editTitle.textContent = '編輯資料';

  fBox.value = row.box_no ?? '';
  fFloor.value = row.floor ?? '';
  fBorrower.value = row.borrower ?? '';
  fAddress.value = row.address ?? '';
  fNote.value = row.note ?? '';
  fSource.value = row.source ?? '';

  editMsg.textContent = '';
  showModal(editBackdrop);
  setTimeout(() => fBox.focus(), 50);
}

function openNewModal() {
  editingIsNew = true;
  editingId = null;
  editTitle.textContent = '新增資料';

  fBox.value = '';
  fFloor.value = '';
  fBorrower.value = '';
  fAddress.value = '';
  fNote.value = '';
  fSource.value = '';

  editMsg.textContent = '';
  showModal(editBackdrop);
  setTimeout(() => fBox.focus(), 50);
}

newBtn?.addEventListener('click', () => {
  if (!EDIT_UNLOCKED) return;
  openNewModal();
});

editSave?.addEventListener('click', async () => {
  if (!EDIT_UNLOCKED) {
    editMsg.textContent = '尚未解鎖編輯模式';
    return;
  }
  const pass = getSavedPass();
  if (!pass) {
    editMsg.textContent = '找不到通關碼，請重新解鎖一次';
    setUnlocked(false);
    return;
  }

  const payload = {
    pass,
    p_id: editingId,
    p_box_no: normInput(fBox.value) || null,
    p_floor: normInput(fFloor.value) || null,
    p_borrower: normInput(fBorrower.value) || null,
    p_address: normInput(fAddress.value) || null,
    p_note: normInput(fNote.value) || null,
    p_source: normInput(fSource.value) || null,
  };

  // 簡單必填檢查（避免空資料亂塞）
  if (!payload.p_box_no || !payload.p_address) {
    editMsg.textContent = '請至少填「廂號」與「地址」';
    return;
  }

  editMsg.textContent = '儲存中…';

  const rpcName = editingIsNew ? RPC_INSERT : RPC_UPDATE;
  const { data, error } = await supabase.rpc(rpcName, payload);

  if (error) {
    console.error(error);
    editMsg.textContent = `儲存失敗：${error.message || error}`;
    if (String(error.message || '').toLowerCase().includes('invalid passcode')) {
      setUnlocked(false);
      localStorage.removeItem(PASS_KEY);
    }
    return;
  }

  editMsg.textContent = '已儲存 ✅';
  hideModal(editBackdrop);
  // 重新查詢（保證列表更新）
  await doSearch();
});

// ====== 11) boot ======
function boot() {
  initTheme();

  const unlocked = localStorage.getItem(UNLOCK_KEY) === '1';
  const pass = getSavedPass();
  setUnlocked(unlocked && !!pass);

  // 初始跑一次（空字串會由 SQL 決定要不要回最新 N 筆）
  doSearch();
}

boot();
