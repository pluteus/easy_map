(() => {
"use strict";

/* ---------------------------------------------------------
   状態管理
--------------------------------------------------------- */
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
let DPR = Math.max(1, window.devicePixelRatio || 1);

const state = {
  gridSize: 32,      // ワールド座標系でのグリッド間隔(px)
  scale: 1,           // 画面表示倍率
  offsetX: 40,
  offsetY: 90,
  viewRotation: 0,    // キャンバス全体の表示回転(0/90/180/270度)
  rects: [],           // {id,x,y,w,h,rotation,text,fontSize}
  nextId: 1,
};

let selection = new Set();   // 選択中の四角のID集合(通常モードでも0〜1個で利用)
let clipboardRects = [];     // コピー/切り取りした四角のデータ(貼り付け用、id は含まない)

let rectRotAnim = null;      // 四角の回転アニメーション中の一時的な描画状態(Map<id, {currentRotation,currentX,currentY}>)
let rotationAnimActive = false; // 回転アニメーション中は入力をブロックする

/* ---------------------------------------------------------
   編集モード (hand / pencil / select)
--------------------------------------------------------- */
const MODE_ORDER = ["hand", "pencil", "layout", "select"];
let editMode = "pencil";
let isSelectMode = false;    // editMode === "select" と同期させておく(既存コード互換用)

const MODE_ICONS = {
  hand: `<svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l3 3" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19l-4 1z" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 7l3 3" fill="none" stroke-width="1.6"/></svg>`,
  layout: `<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1.5" fill="none" stroke-width="1.6"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3" fill="none" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  select: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke-width="1.7" stroke-dasharray="3 2.4"/><circle cx="4" cy="4" r="1.6" fill="#fff" stroke="none"/><circle cx="20" cy="4" r="1.6" fill="#fff" stroke="none"/><circle cx="4" cy="20" r="1.6" fill="#fff" stroke="none"/><circle cx="20" cy="20" r="1.6" fill="#fff" stroke="none"/></svg>`,
};
const MODE_TITLES = {
  hand: "ハンドモード(タップで切替)",
  pencil: "ペンシルモード(タップで切替)",
  layout: "レイアウトモード(タップで切替)",
  select: "範囲選択モード(タップで切替)",
};
const MODE_HINTS = {
  hand: "ハンドモード:1本指でキャンバスを移動できます",
  pencil: "ペンシルモード:1本指のスワイプで四角を作成できます",
  layout: "レイアウトモード:四角の移動・リサイズ・回転と、キャンバスの移動・回転ができます(新規作成は不可)",
  select: "範囲選択モード:ドラッグで範囲選択、四角をタップで選択/解除",
};

function updateModeButton() {
  const btn = document.getElementById("btn-mode");
  if (!btn) return;
  btn.innerHTML = MODE_ICONS[editMode];
  btn.title = MODE_TITLES[editMode];
  btn.classList.toggle("active", editMode !== "pencil");
}

function setMode(mode) {
  editMode = mode;
  isSelectMode = (mode === "select");
  dragMode = null;
  cancelLongPress();
  clearSelection();
  updateModeButton();
  draw();
}

function cycleMode() {
  const idx = MODE_ORDER.indexOf(editMode);
  const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
  setMode(next);
  showHint(MODE_HINTS[next], 2400);
}

/* ---------------------------------------------------------
   モード切替メニュー(モードボタン下に一覧表示)
--------------------------------------------------------- */
const modeMenu = document.getElementById("mode-menu");

function isModeMenuOpen() {
  return !modeMenu.classList.contains("hidden");
}

function closeModeMenu() {
  modeMenu.classList.add("hidden");
}

function openModeMenu() {
  // 選択中以外のモードボタンを一覧表示
  modeMenu.querySelectorAll(".mode-menu-item").forEach(el => el.remove());
  MODE_ORDER.filter(m => m !== editMode).forEach(m => {
    const btn = document.createElement("button");
    btn.className = "mode-menu-item";
    btn.innerHTML = `<span class="mode-menu-icon">${MODE_ICONS[m]}</span><span>${MODE_TITLES[m].replace("(タップで切替)", "")}</span>`;
    btn.addEventListener("click", () => {
      closeModeMenu();
      setMode(m);
      showHint(MODE_HINTS[m], 2400);
    });
    modeMenu.appendChild(btn);
  });

  modeMenu.classList.remove("hidden");

  const btnMode = document.getElementById("btn-mode");
  const margin = 8;
  const btnRect = btnMode.getBoundingClientRect();
  const menuRect = modeMenu.getBoundingClientRect();
  let left = Math.min(btnRect.left, window.innerWidth - menuRect.width - margin);
  left = Math.max(margin, left);
  let top = Math.min(btnRect.bottom + 6, window.innerHeight - menuRect.height - margin);
  top = Math.max(margin, top);
  modeMenu.style.left = left + "px";
  modeMenu.style.top = top + "px";
}

function toggleModeMenu() {
  if (isModeMenuOpen()) {
    closeModeMenu();
  } else {
    openModeMenu();
  }
}

// モードメニュー表示中に、メニューとモードボタン以外の場所をタップしたら閉じる
document.addEventListener("pointerdown", (e) => {
  if (!isModeMenuOpen()) return;
  if (modeMenu.contains(e.target)) return;
  if (e.target.closest && e.target.closest("#btn-mode")) return;
  closeModeMenu();
});

function selectOnly(id) { selection = new Set(id == null ? [] : [id]); }
function clearSelection() { selection = new Set(); }
function toggleSelectionId(id) {
  if (selection.has(id)) selection.delete(id); else selection.add(id);
}
function isSelected(id) { return selection.has(id); }

/* ---------------------------------------------------------
   元に戻す / やり直す (履歴管理)
--------------------------------------------------------- */
const HISTORY_LIMIT = 50;
let undoStack = [];
let redoStack = [];

function snapshotRects() {
  return JSON.parse(JSON.stringify(state.rects));
}

function pushHistory() {
  undoStack.push(snapshotRects());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  updateUndoRedoButtons();
}

function undo() {
  if (isOverlayOpen() || undoStack.length === 0) return;
  redoStack.push(snapshotRects());
  state.rects = undoStack.pop();
  clearSelection();
  dragMode = null;
  draw();
  updateUndoRedoButtons();
}

function redo() {
  if (isOverlayOpen() || redoStack.length === 0) return;
  undoStack.push(snapshotRects());
  state.rects = redoStack.pop();
  clearSelection();
  dragMode = null;
  draw();
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById("btn-undo");
  const redoBtn = document.getElementById("btn-redo");
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

/* ---------------------------------------------------------
   ユーティリティ
--------------------------------------------------------- */
const HANDLE_R = 22;       // 角ハンドルのヒット半径(画面px)
const MIN_SCALE = 0.25, MAX_SCALE = 4;

function uid() { return state.nextId++; }

function snap(v, grid) { return Math.round(v / grid) * grid; }

function worldToScreen(x, y) {
  const sx = x * state.scale + state.offsetX;
  const sy = y * state.scale + state.offsetY;
  return rotateScreenPoint(sx, sy, state.viewRotation);
}
function screenToWorld(x, y) {
  const pre = rotateScreenPoint(x, y, -state.viewRotation);
  return { x: (pre.x - state.offsetX) / state.scale, y: (pre.y - state.offsetY) / state.scale };
}
function rotVec(x, y, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: x * c - y * s, y: x * s + y * c };
}
function screenCenter() {
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}
// キャンバス全体の表示回転(viewRotation)を考慮して、画面中心を軸に
// スクリーン座標を回転させる。worldToScreen/screenToWorld から利用する。
function rotateScreenPoint(x, y, deg) {
  if (!deg) return { x, y };
  const c = screenCenter();
  const rel = rotVec(x - c.x, y - c.y, deg);
  return { x: c.x + rel.x, y: c.y + rel.y };
}
// draw() や drawCreatePreview() で使う、ワールド座標系からデバイス座標系への
// 一連の ctx 変換(表示回転→パン/ズーム)をまとめて適用するヘルパー
function applyViewTransform() {
  const c = screenCenter();
  ctx.translate(c.x, c.y);
  ctx.rotate((state.viewRotation * Math.PI) / 180);
  ctx.translate(-c.x, -c.y);
  ctx.translate(state.offsetX, state.offsetY);
  ctx.scale(state.scale, state.scale);
}

function getRect(id) { return state.rects.find(r => r.id === id); }

// 四隅のローカル符号 (回転前, 中心基準)
const CORNERS = {
  nw: { sx: -1, sy: -1 },
  ne: { sx: 1, sy: -1 },
  se: { sx: 1, sy: 1 },
  sw: { sx: -1, sy: 1 },
};

function rectCenter(r) { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }

function rectCornerWorld(r, key) {
  const c = CORNERS[key];
  const local = { x: (c.sx * r.w) / 2, y: (c.sy * r.h) / 2 };
  const rotated = rotVec(local.x, local.y, r.rotation);
  const center = rectCenter(r);
  return { x: center.x + rotated.x, y: center.y + rotated.y };
}

function pointInRect(r, worldPt) {
  const center = rectCenter(r);
  const rel = { x: worldPt.x - center.x, y: worldPt.y - center.y };
  const local = rotVec(rel.x, rel.y, -r.rotation);
  return Math.abs(local.x) <= r.w / 2 && Math.abs(local.y) <= r.h / 2;
}

// 選択中の四角すべてを囲む外接矩形(ワールド座標)を求める
function selectionBounds(rects) {
  if (!rects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    for (const key of Object.keys(CORNERS)) {
      const c = rectCornerWorld(r, key);
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

function selectionBoundsPadding() { return state.gridSize * 0.15; }

// 範囲選択モードで複数選択中の四角を囲む破線エリアの「内側の空白部分」に
// 指定したスクリーン座標が含まれるかどうかを判定する(コピー/切り取りメニュー表示用)
function selectionBoundsContainsScreenPoint(x, y) {
  if (!isSelectMode || selection.size < 2) return false;
  const selRects = state.rects.filter(r => isSelected(r.id));
  const bounds = selectionBounds(selRects);
  if (!bounds) return false;
  const pad = selectionBoundsPadding();
  const w = screenToWorld(x, y);
  return w.x >= bounds.minX - pad && w.x <= bounds.maxX + pad &&
         w.y >= bounds.minY - pad && w.y <= bounds.maxY + pad;
}

// 2本の指の位置(画面座標)がどちらも外接矩形の範囲内(タッチ許容込み)にあるか
function bothPointsInBounds(pA, pB, bounds) {
  const pad = selectionBoundsPadding();
  const tol = HANDLE_R / state.scale;
  const minX = bounds.minX - pad - tol, maxX = bounds.maxX + pad + tol;
  const minY = bounds.minY - pad - tol, maxY = bounds.maxY + pad + tol;
  const inBounds = (p) => {
    const w = screenToWorld(p.x, p.y);
    return w.x >= minX && w.x <= maxX && w.y >= minY && w.y <= maxY;
  };
  return inBounds(pA) && inBounds(pB);
}

// 90度回転した四角の「見た目の外接矩形」がグリッドに沿うよう、中心位置を
// 調整して x,y(回転前基準の左上)を計算し直す。四角が正方形でない場合、
// 90/270度回転すると見た目の幅と高さが入れ替わるため必要になる。
function snapPositionForRotation(r, desiredCenter) {
  const g = state.gridSize;
  const rot = ((r.rotation % 360) + 360) % 360;
  const swapped = (rot === 90 || rot === 270);
  const visualW = swapped ? r.h : r.w;
  const visualH = swapped ? r.w : r.h;
  const snappedLeft = snap(desiredCenter.x - visualW / 2, g);
  const snappedTop = snap(desiredCenter.y - visualH / 2, g);
  const newCenter = { x: snappedLeft + visualW / 2, y: snappedTop + visualH / 2 };
  r.x = newCenter.x - r.w / 2;
  r.y = newCenter.y - r.h / 2;
}

// 選択中の四角群を、外接矩形の中心を軸に stepDeg 度だけ一括回転する
function rotateGroup(rects, pivot, stepDeg) {
  for (const r of rects) {
    const c = rectCenter(r);
    const rel = { x: c.x - pivot.x, y: c.y - pivot.y };
    const rotated = rotVec(rel.x, rel.y, stepDeg);
    const newCenter = { x: pivot.x + rotated.x, y: pivot.y + rotated.y };
    r.rotation = ((r.rotation + stepDeg) % 360 + 360) % 360;
    snapPositionForRotation(r, newCenter);
  }
}

/* ---------------------------------------------------------
   キャンバスサイズ調整
--------------------------------------------------------- */
function resizeCanvas() {
  DPR = Math.max(1, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.round(w * DPR);
  canvas.height = Math.round(h * DPR);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  draw();
}
window.addEventListener("resize", resizeCanvas);
window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 200));

/* ---------------------------------------------------------
   ツールバーのレイアウト調整
   左ツールバー(toolbar-tl)が右ツールバー(toolbar-tr)と重ならないよう、
   利用可能な幅を実測して割り当て、収まらない分はスクロールで
   アクセスできるようにする。
--------------------------------------------------------- */
const toolbarTl = document.getElementById("toolbar-tl");
const toolbarTr = document.getElementById("toolbar-tr");

function layoutToolbars() {
  if (!toolbarTl || !toolbarTr) return;
  const GAP = 12; // tl と tr の間に確保する最小余白
  const trWidth = toolbarTr.getBoundingClientRect().width;
  const tlLeft = toolbarTl.getBoundingClientRect().left;
  const available = window.innerWidth - tlLeft - trWidth - GAP;
  // 最低でもボタン1個分強は確保し、崩れないようにする
  toolbarTl.style.maxWidth = Math.max(56, available) + "px";
  updateToolbarFade();
}

function updateToolbarFade() {
  if (!toolbarTl) return;
  const atStart = toolbarTl.scrollLeft <= 1;
  const atEnd = toolbarTl.scrollLeft + toolbarTl.clientWidth >= toolbarTl.scrollWidth - 1;
  toolbarTl.classList.toggle("no-fade-l", atStart);
  toolbarTl.classList.toggle("no-fade-r", atEnd);
}

if (toolbarTl) {
  toolbarTl.addEventListener("scroll", updateToolbarFade, { passive: true });
}
window.addEventListener("resize", layoutToolbars);
window.addEventListener("orientationchange", () => setTimeout(layoutToolbars, 200));

/* ---------------------------------------------------------
   描画
--------------------------------------------------------- */
function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, canvas.width / DPR, canvas.height / DPR);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width / DPR, canvas.height / DPR);

  ctx.save();
  applyViewTransform();
  drawGrid();
  for (const r of state.rects) drawRect(r);
  drawSelectionBounds();
  ctx.restore();

  scheduleAutosave();
}

function drawSelectionBounds() {
  if (!isSelectMode || selection.size === 0) return;
  const selRects = state.rects.filter(r => isSelected(r.id));
  const bounds = selectionBounds(selRects);
  if (!bounds) return;
  const pad = selectionBoundsPadding();
  ctx.save();
  ctx.strokeStyle = "#2b6cf6";
  ctx.lineWidth = 2 / state.scale;
  ctx.setLineDash([7 / state.scale, 5 / state.scale]);
  ctx.strokeRect(
    bounds.minX - pad,
    bounds.minY - pad,
    (bounds.maxX - bounds.minX) + pad * 2,
    (bounds.maxY - bounds.minY) + pad * 2
  );
  ctx.restore();
}

// グリッドは drawRect などと同じ ctx 変換(applyViewTransform)の中で、
// ワールド座標のまま直接描くことで、キャンバス全体の表示回転にも自動的に追従する。
function drawGrid() {
  const g = state.gridSize;
  const w = canvas.width / DPR, h = canvas.height / DPR;
  const corners = [
    screenToWorld(0, 0), screenToWorld(w, 0),
    screenToWorld(0, h), screenToWorld(w, h),
  ];
  const minX = Math.min(...corners.map(p => p.x));
  const maxX = Math.max(...corners.map(p => p.x));
  const minY = Math.min(...corners.map(p => p.y));
  const maxY = Math.max(...corners.map(p => p.y));

  const startX = Math.floor(minX / g) * g;
  const endX = Math.ceil(maxX / g) * g;
  const startY = Math.floor(minY / g) * g;
  const endY = Math.ceil(maxY / g) * g;

  ctx.save();
  ctx.strokeStyle = "#d7d7da";
  ctx.lineWidth = 1 / state.scale;
  ctx.beginPath();
  for (let x = startX; x <= endX; x += g) {
    ctx.moveTo(x, startY);
    ctx.lineTo(x, endY);
  }
  for (let y = startY; y <= endY; y += g) {
    ctx.moveTo(startX, y);
    ctx.lineTo(endX, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawRect(r) {
  const sel = isSelected(r.id);
  const groupSel = sel && (isSelectMode || selection.size > 1);
  const anim = rectRotAnim ? rectRotAnim.get(r.id) : null;
  const effRotation = anim ? anim.currentRotation : r.rotation;
  const center = anim
    ? { x: anim.currentX + r.w / 2, y: anim.currentY + r.h / 2 }
    : rectCenter(r);
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate((effRotation * Math.PI) / 180);

  // 本体
  ctx.fillStyle = groupSel ? "rgba(43,108,246,0.14)" : "#ffffff";
  ctx.strokeStyle = sel ? "#2b6cf6" : "#1a1a1a";
  ctx.lineWidth = (sel ? 3 : 2) / state.scale;
  ctx.fillRect(-r.w / 2, -r.h / 2, r.w, r.h);
  ctx.strokeRect(-r.w / 2, -r.h / 2, r.w, r.h);

  if (r.text) drawText(r, effRotation);

  ctx.restore();

  // アニメーション中はハンドルの位置がずれて見えるため非表示にする
  if (sel && !groupSel && !anim) drawHandles(r);
}

function drawHandles(r) {
  ctx.save();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  for (const key of Object.keys(CORNERS)) {
    const wpt = rectCornerWorld(r, key);
    const spt = worldToScreen(wpt.x, wpt.y);
    ctx.beginPath();
    ctx.arc(spt.x, spt.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = "#2b6cf6";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------------------------------------------------------
   テキストレイアウト(横書き・縦書き・自動縮小)
--------------------------------------------------------- */
const PAD = 6;
const MIN_FONT = 9;
const MAX_FONT = 120; // 四角が大きい場合でも際限なく巨大化しないための上限

// 縦書き時、横向きのまま描画すると不自然に見える記号(長音記号・各種ハイフン類)。
// これらは90度回転させて縦棒として表示する。
const VERTICAL_ROTATE_CHARS = new Set(["ー", "ｰ", "－", "-", "‐", "‑", "‒", "–", "−", "〜", "～", "_"]);

// 縦書きの1文字を描画する。回転対象の記号は90度回転させて縦棒に見せる。
function fillVerticalChar(targetCtx, ch, x, y, colWidth) {
  if (VERTICAL_ROTATE_CHARS.has(ch)) {
    targetCtx.save();
    targetCtx.translate(x, y);
    targetCtx.rotate(Math.PI / 2);
    targetCtx.fillText(ch, 0, 0, colWidth);
    targetCtx.restore();
  } else {
    targetCtx.fillText(ch, x, y, colWidth);
  }
}

function splitParagraphs(text) {
  return text.split("\n");
}

function layoutHorizontal(text, w, h, maxFont) {
  const paras = splitParagraphs(text);
  for (let fontSize = maxFont; fontSize >= MIN_FONT; fontSize--) {
    ctx.font = `${fontSize}px sans-serif`;
    const lineHeight = fontSize * 1.3;
    const maxWidth = w - PAD * 2;
    const lines = [];
    for (const para of paras) {
      if (para === "") { lines.push(""); continue; }
      let cur = "";
      for (const ch of para) {
        const test = cur + ch;
        if (ctx.measureText(test).width > maxWidth && cur !== "") {
          lines.push(cur);
          cur = ch;
        } else {
          cur = test;
        }
      }
      lines.push(cur);
    }
    const totalHeight = lines.length * lineHeight;
    if (totalHeight <= h - PAD * 2 || fontSize === MIN_FONT) {
      return { fontSize, lineHeight, lines, maxWidth };
    }
  }
}

function layoutVertical(text, w, h, maxFont) {
  const paras = splitParagraphs(text);
  for (let fontSize = maxFont; fontSize >= MIN_FONT; fontSize--) {
    const colWidth = fontSize * 1.3;
    const maxCharsPerCol = Math.max(1, Math.floor((h - PAD * 2) / (fontSize * 1.15)));
    const columns = [];
    for (const para of paras) {
      if (para === "") { columns.push(""); continue; }
      let idx = 0;
      while (idx < para.length) {
        columns.push(para.slice(idx, idx + maxCharsPerCol));
        idx += maxCharsPerCol;
      }
    }
    const totalWidth = columns.length * colWidth;
    if (totalWidth <= w - PAD * 2 || fontSize === MIN_FONT) {
      return { fontSize, colWidth, columns, maxCharsPerCol };
    }
  }
}

function drawText(r, effRotation) {
  // 表示上の総回転(キャンバス全体の回転 + 四角自体の回転)。
  // 90度単位でしか回転しないため、常に 0/90/180/270 のいずれかになる。
  const total = ((state.viewRotation + effRotation) % 360 + 360) % 360;
  const swapped = total === 90 || total === 270; // 見た目の縦横が入れ替わる
  // 文字を常に画面基準で正しい(逆さまにならない)向きに戻す補正
  const extraRotation = total === 90 ? -90 : total === 180 ? 180 : total === 270 ? 90 : 0;
  const boxW = swapped ? r.h : r.w; // 見た目上の幅
  const boxH = swapped ? r.w : r.h; // 見た目上の高さ
  const isHorizontal = boxW >= boxH; // 正方形・横長(見た目) -> 横書き / 縦長(見た目) -> 縦書き
  const maxFont = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.floor(Math.min(r.w, r.h) / 3)));

  ctx.save();
  if (extraRotation) ctx.rotate((extraRotation * Math.PI) / 180);
  ctx.fillStyle = "#1a1a1a";
  ctx.textBaseline = "middle";

  if (isHorizontal) {
    const layout = layoutHorizontal(r.text, boxW, boxH, maxFont);
    if (!layout) { ctx.restore(); return; }
    ctx.font = `${layout.fontSize}px sans-serif`;
    ctx.textAlign = "center";
    const totalH = layout.lines.length * layout.lineHeight;
    let y = -totalH / 2 + layout.lineHeight / 2;
    for (const line of layout.lines) {
      ctx.fillText(line, 0, y, boxW - PAD * 2);
      y += layout.lineHeight;
    }
  } else {
    const layout = layoutVertical(r.text, boxW, boxH, maxFont);
    if (!layout) { ctx.restore(); return; }
    ctx.font = `${layout.fontSize}px sans-serif`;
    ctx.textAlign = "center";
    const totalW = layout.columns.length * layout.colWidth;
    // 右から左に並べる(縦書きの慣習)
    let x = totalW / 2 - layout.colWidth / 2;
    for (const col of layout.columns) {
      let y = -((col.length - 1) * layout.fontSize * 1.15) / 2;
      for (const ch of col) {
        fillVerticalChar(ctx, ch, x, y, layout.colWidth);
        y += layout.fontSize * 1.15;
      }
      x -= layout.colWidth;
    }
  }
  ctx.restore();
}

/* ---------------------------------------------------------
   ヒットテスト
--------------------------------------------------------- */
function hitTest(screenX, screenY) {
  const list = [...state.rects].reverse();
  for (const r of list) {
    for (const key of Object.keys(CORNERS)) {
      const wpt = rectCornerWorld(r, key);
      const spt = worldToScreen(wpt.x, wpt.y);
      const dx = spt.x - screenX, dy = spt.y - screenY;
      if (Math.sqrt(dx * dx + dy * dy) <= HANDLE_R) {
        return { type: "resize", rect: r, corner: key };
      }
    }
    const wpt = screenToWorld(screenX, screenY);
    if (pointInRect(r, wpt)) return { type: "move", rect: r };
  }
  return { type: "create" };
}

function rectUnderBothPoints(pA, pB) {
  for (const r of [...state.rects].reverse()) {
    const wa = screenToWorld(pA.x, pA.y);
    const wb = screenToWorld(pB.x, pB.y);
    const nearA = pointInRect(r, wa) || Object.keys(CORNERS).some(k => {
      const s = worldToScreen(rectCornerWorld(r, k).x, rectCornerWorld(r, k).y);
      return Math.hypot(s.x - pA.x, s.y - pA.y) <= HANDLE_R * 1.6;
    });
    const nearB = pointInRect(r, wb) || Object.keys(CORNERS).some(k => {
      const s = worldToScreen(rectCornerWorld(r, k).x, rectCornerWorld(r, k).y);
      return Math.hypot(s.x - pB.x, s.y - pB.y) <= HANDLE_R * 1.6;
    });
    if (nearA && nearB) return r;
  }
  return null;
}

/* ---------------------------------------------------------
   ジェスチャー処理
--------------------------------------------------------- */
const pointers = new Map(); // id -> {x,y}
let dragMode = null; // 'create' | 'move' | 'resize' | 'pinch' | 'rotate'
let dragData = {};
let lastTap = null; // {time,x,y,rectId}

function showHint(msg, ms = 1600) {
  const el = document.getElementById("hint");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showHint._t);
  showHint._t = setTimeout(() => el.classList.remove("show"), ms);
}

function showZoom() {
  const el = document.getElementById("zoom-indicator");
  el.textContent = Math.round(state.scale * 100) + "%";
  el.classList.remove("hidden");
  clearTimeout(showZoom._t);
  showZoom._t = setTimeout(() => el.classList.add("hidden"), 900);
}

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerUp);
canvas.addEventListener("pointerleave", (e) => { if (pointers.has(e.pointerId)) onPointerUp(e); });

const TAP_MOVE_THRESH = 10; // これ以上動いたら「タップ」ではなく「ドラッグ」とみなす(画面px)

function onPointerDown(e) {
  if (isOverlayOpen()) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
    startSingleDrag(e.clientX, e.clientY);
  } else if (pointers.size === 2) {
    cancelLongPress();
    startTwoFingerGesture();
  }
}

function startSingleDrag(x, y) {
  const hit = hitTest(x, y);

  if (editMode === "hand") {
    dragMode = "pan";
    dragData = { startScreenX: x, startScreenY: y, startOffsetX: state.offsetX, startOffsetY: state.offsetY };
    if (hit.type === "create") {
      startCanvasLongPress(x, y);
    } else {
      cancelLongPress();
    }
    draw();
    return;
  }

  // レイアウトモード:四角の移動・リサイズは通常モードと同じ挙動にしつつ、
  // 空白部分のドラッグは四角の新規作成ではなくキャンバスのパンにする
  if (editMode === "layout" && hit.type === "create") {
    dragMode = "pan";
    dragData = { startScreenX: x, startScreenY: y, startOffsetX: state.offsetX, startOffsetY: state.offsetY };
    startCanvasLongPress(x, y);
    draw();
    return;
  }

  const now = Date.now();

  if (hit.type === "move") {
    startLongPress(hit.rect, x, y);
  } else if (hit.type === "create") {
    if (isSelectMode && selectionBoundsContainsScreenPoint(x, y)) {
      startSelectionLongPress(x, y);
    } else {
      startCanvasLongPress(x, y);
    }
  } else {
    cancelLongPress();
  }

  if (isSelectMode) {
    if (hit.type === "create") {
      // 空白部分:ドラッグで矩形選択、タップのみなら選択解除
      dragMode = "marquee-pending";
      dragData = { startX: x, startY: y, curX: x, curY: y };
    } else {
      // 四角の上:タップなら選択トグル、ドラッグなら選択中の四角をまとめて移動
      dragMode = "toggle-pending";
      dragData = { rect: hit.rect, startScreenX: x, startScreenY: y, grabWorld: screenToWorld(x, y) };
    }
    draw();
    return;
  }

  // 通常モード(単一選択)
  if (hit.type === "move") {
    if (lastTap && lastTap.rectId === hit.rect.id &&
        now - lastTap.time < 350 &&
        Math.hypot(lastTap.x - x, lastTap.y - y) < 32) {
      lastTap = null;
      dragMode = null;
      cancelLongPress();
      selectOnly(hit.rect.id);
      draw();
      openTextEditor(hit.rect);
      return;
    }
    lastTap = { time: now, x, y, rectId: hit.rect.id };
  } else {
    lastTap = null;
  }

  selectOnly(hit.type === "create" ? null : hit.rect.id);

  if (hit.type === "resize") {
    const r = hit.rect;
    const g = CORNERS[hit.corner];
    const anchorKey = { nw: "se", ne: "sw", se: "nw", sw: "ne" }[hit.corner];
    const anchorWorld = rectCornerWorld(r, anchorKey);
    pushHistory();
    dragMode = "resize";
    dragData = { rect: r, corner: hit.corner, gsx: g.sx, gsy: g.sy, anchorWorld, rotation: r.rotation };
  } else if (hit.type === "move") {
    const r = hit.rect;
    const w = screenToWorld(x, y);
    pushHistory();
    dragMode = "move";
    dragData = { rect: r, grabWorld: w, startX: r.x, startY: r.y };
  } else {
    const w = screenToWorld(x, y);
    const g = state.gridSize;
    const sx = snap(w.x, g), sy = snap(w.y, g);
    dragMode = "create";
    dragData = { startX: sx, startY: sy, curX: sx, curY: sy };
  }
  draw();
}

function startPinch(pA, pB) {
  const dist = Math.hypot(pB.x - pA.x, pB.y - pA.y);
  const mid = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
  const ang = Math.atan2(pB.y - pA.y, pB.x - pA.x) * (180 / Math.PI);
  dragMode = "pinch";
  dragData = {
    startDist: dist,
    startScale: state.scale,
    startOffsetX: state.offsetX,
    startOffsetY: state.offsetY,
    midWorld: screenToWorld(mid.x, mid.y),
    baseAngle: ang,
  };
  draw();
}

function startTwoFingerGesture() {
  const pts = [...pointers.values()];
  const [pA, pB] = pts;

  // ハンドモードでは2本指は常にピンチズーム専用
  if (editMode === "hand") {
    startPinch(pA, pB);
    return;
  }

  // 範囲選択モード中に、選択中の四角を囲む破線四角の内側で2本指ツイスト
  // →選択グループ全体を、破線四角の中心を軸に回転
  if (isSelectMode && selection.size > 0) {
    const selRects = state.rects.filter(r => isSelected(r.id));
    const bounds = selectionBounds(selRects);
    if (bounds && bothPointsInBounds(pA, pB, bounds)) {
      const ang = Math.atan2(pB.y - pA.y, pB.x - pA.x) * (180 / Math.PI);
      const pivot = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
      pushHistory();
      dragMode = "rotate-group";
      dragData = { rects: selRects, baseAngle: ang, pivot };
      draw();
      return;
    }
  }

  const rect = !isSelectMode ? rectUnderBothPoints(pA, pB) : null;
  if (rect) {
    selectOnly(rect.id);
    const ang = Math.atan2(pB.y - pA.y, pB.x - pA.x) * (180 / Math.PI);
    pushHistory();
    dragMode = "rotate";
    dragData = { rects: [rect], baseAngle: ang };
    draw();
  } else {
    startPinch(pA, pB);
  }
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (longPressTimer && longPressStart &&
      Math.hypot(e.clientX - longPressStart.x, e.clientY - longPressStart.y) > LONG_PRESS_MOVE_THRESH) {
    cancelLongPress();
  }

  if (dragMode === "pan") {
    const raw = { x: e.clientX - dragData.startScreenX, y: e.clientY - dragData.startScreenY };
    const d = rotVec(raw.x, raw.y, -state.viewRotation);
    state.offsetX = dragData.startOffsetX + d.x;
    state.offsetY = dragData.startOffsetY + d.y;
    draw();
  } else if (dragMode === "create") {
    const w = screenToWorld(e.clientX, e.clientY);
    const g = state.gridSize;
    dragData.curX = snap(w.x, g);
    dragData.curY = snap(w.y, g);
    draw();
    drawCreatePreview();
  } else if (dragMode === "move") {
    const r = dragData.rect;
    const w = screenToWorld(e.clientX, e.clientY);
    const dx = w.x - dragData.grabWorld.x, dy = w.y - dragData.grabWorld.y;
    const g = state.gridSize;
    r.x = snap(dragData.startX + dx, g);
    r.y = snap(dragData.startY + dy, g);
    draw();
  } else if (dragMode === "resize") {
    doResize(e.clientX, e.clientY);
    draw();
  } else if (dragMode === "marquee-pending") {
    dragData.curX = e.clientX; dragData.curY = e.clientY;
    if (Math.hypot(e.clientX - dragData.startX, e.clientY - dragData.startY) > TAP_MOVE_THRESH) {
      dragMode = "marquee";
      draw();
      drawMarquee();
    }
  } else if (dragMode === "marquee") {
    dragData.curX = e.clientX; dragData.curY = e.clientY;
    draw();
    drawMarquee();
  } else if (dragMode === "toggle-pending") {
    if (Math.hypot(e.clientX - dragData.startScreenX, e.clientY - dragData.startScreenY) > TAP_MOVE_THRESH) {
      if (!isSelected(dragData.rect.id)) selection.add(dragData.rect.id);
      const starts = new Map();
      for (const r of state.rects) if (isSelected(r.id)) starts.set(r.id, { x: r.x, y: r.y });
      pushHistory();
      dragMode = "group-move";
      dragData = { grabWorld: dragData.grabWorld, starts };
      draw();
    }
  } else if (dragMode === "group-move") {
    const w = screenToWorld(e.clientX, e.clientY);
    const dx = w.x - dragData.grabWorld.x, dy = w.y - dragData.grabWorld.y;
    const g = state.gridSize;
    const sdx = snap(dx, g), sdy = snap(dy, g);
    for (const r of state.rects) {
      const s = dragData.starts.get(r.id);
      if (s) { r.x = s.x + sdx; r.y = s.y + sdy; }
    }
    draw();
  } else if (dragMode === "pinch" && pointers.size >= 2) {
    if (rotationAnimActive) return;
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const factor = dist / dragData.startDist;
    let newScale = dragData.startScale * factor;
    newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

    state.scale = newScale;
    // ピンチの中心(mid)がその瞬間のワールド座標(midWorld)を指し続けるよう offset を再計算
    const pre = rotateScreenPoint(mid.x, mid.y, -state.viewRotation);
    state.offsetX = pre.x - dragData.midWorld.x * newScale;
    state.offsetY = pre.y - dragData.midWorld.y * newScale;
    draw();
    showZoom();

    // 2本指ツイストでキャンバス全体を90度単位で回転(ピンチズームと同時に検知)。
    // サブメニューの回転ボタンと同じアニメーションで回す。
    const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * (180 / Math.PI);
    let delta = ang - dragData.baseAngle;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    const ROTATE_THRESH = 42;
    if (Math.abs(delta) >= ROTATE_THRESH) {
      const step = delta > 0 ? 90 : -90;
      dragData.baseAngle = ang;
      if (navigator.vibrate) navigator.vibrate(8);
      animateCanvasRotation(step);
    }
  } else if (dragMode === "rotate" && pointers.size >= 2) {
    if (rotationAnimActive) return;
    const pts = [...pointers.values()];
    const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * (180 / Math.PI);
    let delta = ang - dragData.baseAngle;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    const THRESH = 42;
    if (Math.abs(delta) >= THRESH) {
      const step = delta > 0 ? 90 : -90;
      dragData.baseAngle = ang;
      if (navigator.vibrate) navigator.vibrate(8);
      for (const r of dragData.rects) {
        animateRectRotation(r, step);
      }
    }
  } else if (dragMode === "rotate-group" && pointers.size >= 2) {
    if (rotationAnimActive) return;
    const pts = [...pointers.values()];
    const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * (180 / Math.PI);
    let delta = ang - dragData.baseAngle;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    const THRESH = 42;
    if (Math.abs(delta) >= THRESH) {
      const step = delta > 0 ? 90 : -90;
      dragData.baseAngle = ang;
      if (navigator.vibrate) navigator.vibrate(8);
      animateGroupRotation(dragData.rects, dragData.pivot, step);
    }
  }
}

function drawMarquee() {
  const { startX, startY, curX, curY } = dragData;
  const x = Math.min(startX, curX), y = Math.min(startY, curY);
  const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
  ctx.save();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = "rgba(43,108,246,0.10)";
  ctx.strokeStyle = "#2b6cf6";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function doResize(screenX, screenY) {
  const { rect: r, gsx, gsy, anchorWorld, rotation } = dragData;
  const w = screenToWorld(screenX, screenY);
  const rel = { x: w.x - anchorWorld.x, y: w.y - anchorWorld.y };
  const local = rotVec(rel.x, rel.y, -rotation);
  const g = state.gridSize;

  let newW = Math.round((local.x * gsx) / g) * g;
  let newH = Math.round((local.y * gsy) / g) * g;
  newW = Math.max(g, newW);
  newH = Math.max(g, newH);

  const centerLocal = { x: (gsx * newW) / 2, y: (gsy * newH) / 2 };
  const centerRot = rotVec(centerLocal.x, centerLocal.y, rotation);
  const newCenter = { x: anchorWorld.x + centerRot.x, y: anchorWorld.y + centerRot.y };

  r.w = newW; r.h = newH;
  r.x = newCenter.x - newW / 2;
  r.y = newCenter.y - newH / 2;
}

function drawCreatePreview() {
  const { startX, startY, curX, curY } = dragData;
  const x = Math.min(startX, curX), y = Math.min(startY, curY);
  const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
  if (w <= 0 || h <= 0) return;
  ctx.save();
  applyViewTransform();
  ctx.fillStyle = "rgba(43,108,246,0.12)";
  ctx.strokeStyle = "#2b6cf6";
  ctx.lineWidth = 2 / state.scale;
  ctx.setLineDash([6 / state.scale, 4 / state.scale]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  cancelLongPress();

  if (dragMode === "create") {
    const { startX, startY, curX, curY } = dragData;
    const x = Math.min(startX, curX), y = Math.min(startY, curY);
    const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
    if (w >= state.gridSize && h >= state.gridSize) {
      pushHistory();
      const rect = { id: uid(), x, y, w, h, rotation: 0, text: "" };
      state.rects.push(rect);
      selectOnly(rect.id);
    } else {
      selectOnly(null);
    }
    dragMode = null;
    draw();
    return;
  }

  if (dragMode === "marquee-pending") {
    // 移動なしのタップ:選択解除
    clearSelection();
    dragMode = null;
  } else if (dragMode === "marquee") {
    const { startX, startY, curX, curY } = dragData;
    const wa = screenToWorld(Math.min(startX, curX), Math.min(startY, curY));
    const wb = screenToWorld(Math.max(startX, curX), Math.max(startY, curY));
    for (const r of state.rects) {
      const intersects = r.x < wb.x && r.x + r.w > wa.x && r.y < wb.y && r.y + r.h > wa.y;
      if (intersects) selection.add(r.id);
    }
    dragMode = null;
  } else if (dragMode === "toggle-pending") {
    // 移動なしのタップ:選択トグル
    toggleSelectionId(dragData.rect.id);
    dragMode = null;
  }

  if (pointers.size === 0) {
    dragMode = null;
    draw();
  } else if (pointers.size === 1) {
    // 2本指→1本指になった場合、残り1本で新規ドラッグを再開
    const [p] = [...pointers.values()];
    startSingleDrag(p.x, p.y);
  } else {
    draw();
  }
}

/* ---------------------------------------------------------
   デスクトップ用ホイールズーム(補助)
--------------------------------------------------------- */
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = Math.pow(1.0015, -e.deltaY);
  const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor));
  const before = screenToWorld(e.clientX, e.clientY);
  state.scale = newScale;
  const after = worldToScreen(before.x, before.y);
  const d = rotVec(e.clientX - after.x, e.clientY - after.y, -state.viewRotation);
  state.offsetX += d.x;
  state.offsetY += d.y;
  draw();
  showZoom();
}, { passive: false });

/* ---------------------------------------------------------
   テキスト編集
--------------------------------------------------------- */
const textOverlay = document.getElementById("text-edit-overlay");
const textInput = document.getElementById("text-edit-input");
let editingRectId = null;

function isOverlayOpen() {
  return !textOverlay.classList.contains("hidden") ||
         !document.getElementById("save-menu").classList.contains("hidden") ||
         !document.getElementById("settings-panel").classList.contains("hidden") ||
         !rectContextMenu.classList.contains("hidden") ||
         !document.getElementById("canvas-context-menu").classList.contains("hidden") ||
         !document.getElementById("update-dialog").classList.contains("hidden") ||
         !document.getElementById("mode-menu").classList.contains("hidden") ||
         rotationAnimActive;
}

function openTextEditor(rect) {
  editingRectId = rect.id;
  textInput.value = rect.text || "";
  textOverlay.classList.remove("hidden");
  setTimeout(() => textInput.focus(), 50);
}
function closeTextEditor() {
  textOverlay.classList.add("hidden");
  editingRectId = null;
}
document.getElementById("text-edit-ok").addEventListener("click", () => {
  const r = getRect(editingRectId);
  if (r && r.text !== textInput.value) {
    pushHistory();
    r.text = textInput.value;
  }
  closeTextEditor();
  draw();
});
document.getElementById("text-edit-cancel").addEventListener("click", closeTextEditor);
document.getElementById("text-edit-delete").addEventListener("click", () => {
  pushHistory();
  state.rects = state.rects.filter(r => r.id !== editingRectId);
  selection.delete(editingRectId);
  closeTextEditor();
  draw();
});

/* ---------------------------------------------------------
   回転アニメーション
   四角の回転・キャンバスの回転を、値の即時変更ではなく
   短いアニメーションを挟んで行うことで、どちらが/どちらに
   回転したのかを視覚的に分かりやすくする。アニメーション中は
   全画面を覆う #rotation-lock で入力をブロックする。
--------------------------------------------------------- */
const rotationLock = document.getElementById("rotation-lock");
const ROTATION_ANIM_MS = 260;

function lockForRotation() {
  rotationAnimActive = true;
  if (rotationLock) rotationLock.classList.remove("hidden");
}
function unlockAfterRotation() {
  rotationAnimActive = false;
  if (rotationLock) rotationLock.classList.add("hidden");
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// 四角を90度単位で回転させるアニメーション。delta は +90 か -90。
function animateRectRotation(rect, delta) {
  if (rotationAnimActive) return;
  const fromRotation = rect.rotation;
  const toRotation = ((fromRotation + delta) % 360 + 360) % 360;
  const fromX = rect.x, fromY = rect.y;
  const preview = { ...rect, rotation: toRotation };
  snapPositionForRotation(preview, rectCenter(rect));
  const toX = preview.x, toY = preview.y;

  lockForRotation();
  const startTime = performance.now();
  rectRotAnim = new Map([[rect.id, { currentRotation: fromRotation, currentX: fromX, currentY: fromY }]]);

  function step(now) {
    const t = Math.min(1, (now - startTime) / ROTATION_ANIM_MS);
    const e = easeInOutCubic(t);
    rectRotAnim.set(rect.id, {
      currentRotation: fromRotation + delta * e,
      currentX: fromX + (toX - fromX) * e,
      currentY: fromY + (toY - fromY) * e,
    });
    draw();
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      rect.rotation = toRotation;
      rect.x = toX;
      rect.y = toY;
      rectRotAnim = null;
      unlockAfterRotation();
      draw();
    }
  }
  requestAnimationFrame(step);
}

// 選択中の四角群を、外接矩形の中心を軸に stepDeg 度だけ一括回転させるアニメーション。
// 2本指ツイストでの一括回転を、右クリックメニューでの単体回転と同じ見た目にする。
function animateGroupRotation(rects, pivot, stepDeg) {
  if (rotationAnimActive) return;
  const items = rects.map((r) => {
    const fromRotation = r.rotation;
    const fromX = r.x, fromY = r.y;
    const c = rectCenter(r);
    const rel = { x: c.x - pivot.x, y: c.y - pivot.y };
    const rotated = rotVec(rel.x, rel.y, stepDeg);
    const newCenter = { x: pivot.x + rotated.x, y: pivot.y + rotated.y };
    const toRotation = ((fromRotation + stepDeg) % 360 + 360) % 360;
    const preview = { ...r, rotation: toRotation };
    snapPositionForRotation(preview, newCenter);
    return { rect: r, fromRotation, fromX, fromY, toRotation, toX: preview.x, toY: preview.y };
  });

  lockForRotation();
  const startTime = performance.now();
  rectRotAnim = new Map(
    items.map((it) => [it.rect.id, { currentRotation: it.fromRotation, currentX: it.fromX, currentY: it.fromY }])
  );

  function step(now) {
    const t = Math.min(1, (now - startTime) / ROTATION_ANIM_MS);
    const e = easeInOutCubic(t);
    for (const it of items) {
      rectRotAnim.set(it.rect.id, {
        currentRotation: it.fromRotation + stepDeg * e,
        currentX: it.fromX + (it.toX - it.fromX) * e,
        currentY: it.fromY + (it.toY - it.fromY) * e,
      });
    }
    draw();
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      for (const it of items) {
        it.rect.rotation = it.toRotation;
        it.rect.x = it.toX;
        it.rect.y = it.toY;
      }
      rectRotAnim = null;
      unlockAfterRotation();
      draw();
    }
  }
  requestAnimationFrame(step);
}

// キャンバス全体の表示を90度単位で回転させるアニメーション。delta は +90 か -90。
// 画面中心が指しているワールド座標を回転の軸として固定する。
function animateCanvasRotation(delta) {
  if (rotationAnimActive) return;
  const fromRotation = state.viewRotation;
  const toRotation = ((fromRotation + delta) % 360 + 360) % 360;
  const c = screenCenter();
  const pivotWorld = screenToWorld(c.x, c.y);

  lockForRotation();
  const startTime = performance.now();

  function applyRotation(rotation) {
    state.viewRotation = rotation;
    const pre = rotateScreenPoint(c.x, c.y, -rotation);
    state.offsetX = pre.x - pivotWorld.x * state.scale;
    state.offsetY = pre.y - pivotWorld.y * state.scale;
  }

  function step(now) {
    const t = Math.min(1, (now - startTime) / ROTATION_ANIM_MS);
    const e = easeInOutCubic(t);
    applyRotation(fromRotation + delta * e);
    draw();
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      applyRotation(toRotation);
      unlockAfterRotation();
      draw();
    }
  }
  requestAnimationFrame(step);
}

/* ---------------------------------------------------------
   四角の右クリック/長押しメニュー
   (右へ回転 / 左へ回転 / 最前面に移動 / 最背面に移動 / コピー / 切り取り)
   複数選択中に、選択エリア内(四角の上以外も含む)で長押し/右クリックした
   場合は rect が null で開かれ、コピー/切り取りのみ選択全体に対して行える。
--------------------------------------------------------- */
const rectContextMenu = document.getElementById("rect-context-menu");
let contextMenuRectId = null;   // 個別操作(回転/前面/背面)の対象。単一四角クリック時のみ設定
let contextMenuGroupIds = [];   // コピー/切り取りの対象。複数選択中なら選択全体、それ以外は単一四角

const CONTEXT_MENU_SINGLE_ONLY_IDS = ["ctx-rotate-right", "ctx-rotate-left", "ctx-bring-front", "ctx-send-back"];

function openRectContextMenu(rect, screenX, screenY) {
  contextMenuRectId = rect ? rect.id : null;
  contextMenuGroupIds = rect
    ? (selection.has(rect.id) && selection.size > 1 ? [...selection] : [rect.id])
    : [...selection];

  CONTEXT_MENU_SINGLE_ONLY_IDS.forEach(id => {
    document.getElementById(id).classList.toggle("hidden", !contextMenuRectId);
  });

  rectContextMenu.classList.remove("hidden");
  const margin = 8;
  const menuRect = rectContextMenu.getBoundingClientRect();
  let left = Math.min(screenX, window.innerWidth - menuRect.width - margin);
  let top = Math.min(screenY, window.innerHeight - menuRect.height - margin);
  left = Math.max(margin, left);
  top = Math.max(margin, top);
  rectContextMenu.style.left = left + "px";
  rectContextMenu.style.top = top + "px";
}
function closeRectContextMenu() {
  rectContextMenu.classList.add("hidden");
  contextMenuRectId = null;
  contextMenuGroupIds = [];
}

function copyRectsToClipboard(ids) {
  const rects = ids.map(id => getRect(id)).filter(Boolean);
  if (!rects.length) return 0;
  clipboardRects = rects.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h, rotation: r.rotation, text: r.text }));
  return clipboardRects.length;
}

document.getElementById("ctx-rotate-right").addEventListener("click", () => {
  const r = getRect(contextMenuRectId);
  closeRectContextMenu();
  if (r) {
    pushHistory();
    animateRectRotation(r, 90);
  }
});
document.getElementById("ctx-rotate-left").addEventListener("click", () => {
  const r = getRect(contextMenuRectId);
  closeRectContextMenu();
  if (r) {
    pushHistory();
    animateRectRotation(r, -90);
  }
});
document.getElementById("ctx-bring-front").addEventListener("click", () => {
  const idx = state.rects.findIndex(r => r.id === contextMenuRectId);
  if (idx !== -1) {
    pushHistory();
    const [r] = state.rects.splice(idx, 1);
    state.rects.push(r);
    draw();
  }
  closeRectContextMenu();
});
document.getElementById("ctx-send-back").addEventListener("click", () => {
  const idx = state.rects.findIndex(r => r.id === contextMenuRectId);
  if (idx !== -1) {
    pushHistory();
    const [r] = state.rects.splice(idx, 1);
    state.rects.unshift(r);
    draw();
  }
  closeRectContextMenu();
});
document.getElementById("ctx-copy").addEventListener("click", () => {
  const ids = contextMenuGroupIds;
  closeRectContextMenu();
  const n = copyRectsToClipboard(ids);
  if (n) showHint(n > 1 ? `${n}個の四角をコピーしました` : "四角をコピーしました", 1600);
});
document.getElementById("ctx-cut").addEventListener("click", () => {
  const ids = contextMenuGroupIds;
  closeRectContextMenu();
  const n = copyRectsToClipboard(ids);
  if (!n) return;
  pushHistory();
  state.rects = state.rects.filter(r => !ids.includes(r.id));
  clearSelection();
  draw();
  showHint(n > 1 ? `${n}個の四角を切り取りました` : "四角を切り取りました", 1600);
});

/* ---------------------------------------------------------
   キャンバスの右クリック/長押しメニュー(四角のない場所)
   (キャンバスを右に90度回転 / 左に90度回転 / 貼り付け)
--------------------------------------------------------- */
const canvasContextMenu = document.getElementById("canvas-context-menu");
let canvasContextWorld = null; // 貼り付け先(メニューを開いた位置のワールド座標)

function openCanvasContextMenu(screenX, screenY) {
  canvasContextWorld = screenToWorld(screenX, screenY);
  document.getElementById("ctx-canvas-paste").classList.toggle("hidden", clipboardRects.length === 0);

  canvasContextMenu.classList.remove("hidden");
  const margin = 8;
  const menuRect = canvasContextMenu.getBoundingClientRect();
  let left = Math.min(screenX, window.innerWidth - menuRect.width - margin);
  let top = Math.min(screenY, window.innerHeight - menuRect.height - margin);
  left = Math.max(margin, left);
  top = Math.max(margin, top);
  canvasContextMenu.style.left = left + "px";
  canvasContextMenu.style.top = top + "px";
}
function closeCanvasContextMenu() {
  canvasContextMenu.classList.add("hidden");
}

function pasteClipboardRects(target) {
  if (!clipboardRects.length || !target) return;
  pushHistory();
  const g = state.gridSize;
  const anchor = { x: snap(target.x, g), y: snap(target.y, g) };
  let minX = Infinity, minY = Infinity;
  clipboardRects.forEach(r => { minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); });
  const newIds = [];
  clipboardRects.forEach(r => {
    const nr = {
      id: uid(),
      x: anchor.x + (r.x - minX),
      y: anchor.y + (r.y - minY),
      w: r.w, h: r.h, rotation: r.rotation, text: r.text,
    };
    state.rects.push(nr);
    newIds.push(nr.id);
  });
  selection = new Set(newIds);
  draw();
  showHint(newIds.length > 1 ? `${newIds.length}個の四角を貼り付けました` : "四角を貼り付けました", 1600);
}

document.getElementById("ctx-canvas-rotate-right").addEventListener("click", () => {
  closeCanvasContextMenu();
  animateCanvasRotation(90);
});
document.getElementById("ctx-canvas-rotate-left").addEventListener("click", () => {
  closeCanvasContextMenu();
  animateCanvasRotation(-90);
});
document.getElementById("ctx-canvas-paste").addEventListener("click", () => {
  const target = canvasContextWorld;
  closeCanvasContextMenu();
  pasteClipboardRects(target);
});

// サブメニュー(四角メニュー/キャンバスメニュー)以外の場所をタップしたら閉じる
document.addEventListener("pointerdown", (e) => {
  if (!rectContextMenu.classList.contains("hidden") && !rectContextMenu.contains(e.target)) {
    closeRectContextMenu();
  }
  if (!canvasContextMenu.classList.contains("hidden") && !canvasContextMenu.contains(e.target)) {
    closeCanvasContextMenu();
  }
});

// 長押し検出(タッチ/ペン想定。マウスは contextmenu イベント側で処理)
let longPressTimer = null;
let longPressStart = null; // {x,y,rect}
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_THRESH = 10;

function startLongPress(rect, x, y) {
  cancelLongPress();
  longPressStart = { x, y };
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    longPressStart = null;
    dragMode = null;
    // 既に複数選択されている四角の上での長押しは選択を維持し、
    // コピー/切り取りを選択全体に対して行えるようにする
    if (!(selection.has(rect.id) && selection.size > 1)) {
      selectOnly(rect.id);
    }
    draw();
    if (navigator.vibrate) navigator.vibrate(12);
    openRectContextMenu(rect, x, y);
  }, LONG_PRESS_MS);
}
// 複数選択エリア内(四角の上以外の空白部分)の長押し→選択全体のコピー/切り取りメニュー
function startSelectionLongPress(x, y) {
  cancelLongPress();
  longPressStart = { x, y };
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    longPressStart = null;
    dragMode = null;
    draw();
    if (navigator.vibrate) navigator.vibrate(12);
    openRectContextMenu(null, x, y);
  }, LONG_PRESS_MS);
}
// 四角のない場所(空白部分)の長押し→キャンバス回転メニュー
function startCanvasLongPress(x, y) {
  cancelLongPress();
  longPressStart = { x, y };
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    longPressStart = null;
    dragMode = null;
    draw();
    if (navigator.vibrate) navigator.vibrate(12);
    openCanvasContextMenu(x, y);
  }, LONG_PRESS_MS);
}
function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  longPressStart = null;
}

// 右クリック(デスクトップ)での同メニュー表示
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (isOverlayOpen()) return;
  cancelLongPress();
  const hit = hitTest(e.clientX, e.clientY);
  if (hit.type === "move") {
    dragMode = null;
    if (!(selection.has(hit.rect.id) && selection.size > 1)) {
      selectOnly(hit.rect.id);
    }
    draw();
    openRectContextMenu(hit.rect, e.clientX, e.clientY);
  } else if (hit.type === "create") {
    dragMode = null;
    draw();
    if (isSelectMode && selectionBoundsContainsScreenPoint(e.clientX, e.clientY)) {
      openRectContextMenu(null, e.clientX, e.clientY);
    } else {
      openCanvasContextMenu(e.clientX, e.clientY);
    }
  }
});

/* ---------------------------------------------------------
   削除ボタン・モード切り替えボタン
--------------------------------------------------------- */
document.getElementById("btn-delete").addEventListener("click", () => {
  if (selection.size === 0) {
    showHint("削除する四角を選択してください");
    return;
  }
  pushHistory();
  state.rects = state.rects.filter(r => !isSelected(r.id));
  clearSelection();
  draw();
});

document.getElementById("btn-mode").addEventListener("click", toggleModeMenu);

document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-redo").addEventListener("click", redo);

document.getElementById("btn-select-all").addEventListener("click", () => {
  if (!state.rects.length) {
    showHint("四角がありません");
    return;
  }
  if (editMode !== "select") setMode("select");
  selection = new Set(state.rects.map(r => r.id));
  showHint("全ての四角を選択しました", 1600);
  draw();
});

/* ---------------------------------------------------------
   保存 / 読み込み(保存ボタンの下にドロップダウン表示)
--------------------------------------------------------- */
const saveMenu = document.getElementById("save-menu");
const settingsPanel = document.getElementById("settings-panel");

function isSaveMenuOpen() {
  return !saveMenu.classList.contains("hidden");
}
function closeSaveMenu() {
  saveMenu.classList.add("hidden");
}
function openSaveMenu() {
  saveMenu.classList.remove("hidden");
  const btn = document.getElementById("btn-save");
  const margin = 8;
  const btnRect = btn.getBoundingClientRect();
  const menuRect = saveMenu.getBoundingClientRect();
  let left = Math.min(btnRect.left, window.innerWidth - menuRect.width - margin);
  left = Math.max(margin, left);
  let top = Math.min(btnRect.bottom + 6, window.innerHeight - menuRect.height - margin);
  top = Math.max(margin, top);
  saveMenu.style.left = left + "px";
  saveMenu.style.top = top + "px";
}
function toggleSaveMenu() {
  if (isSaveMenuOpen()) {
    closeSaveMenu();
  } else {
    openSaveMenu();
  }
}

document.getElementById("btn-save").addEventListener("click", toggleSaveMenu);

// メニュー以外の場所をタップ/クリックしたら閉じる
document.addEventListener("pointerdown", (e) => {
  if (!isSaveMenuOpen()) return;
  if (saveMenu.contains(e.target)) return;
  if (e.target.closest && e.target.closest("#btn-save")) return;
  closeSaveMenu();
});

document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.getElementById(btn.dataset.close).classList.add("hidden");
  });
});

document.getElementById("save-json").addEventListener("click", () => {
  const data = { type: "storemap", version: 1, gridSize: state.gridSize, rects: state.rects };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  downloadBlob(blob, `storemap-${timestamp()}.json`);
  closeSaveMenu();
});

document.getElementById("save-png").addEventListener("click", () => {
  exportPNG();
  closeSaveMenu();
});

document.getElementById("load-json").addEventListener("click", () => {
  closeSaveMenu();
  document.getElementById("file-input").click();
});

document.getElementById("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.rects)) throw new Error("invalid");
      pushHistory();
      state.rects = data.rects.map(r => ({
        id: uid(),
        x: r.x, y: r.y, w: r.w, h: r.h,
        rotation: r.rotation || 0,
        text: r.text || "",
      }));
      if (data.gridSize) {
        state.gridSize = data.gridSize;
        syncGridUI();
      }
      clearSelection();
      fitView();
      showHint("読み込みました");
    } catch (err) {
      showHint("読み込みに失敗しました");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportPNG() {
  const g = state.gridSize;
  const margin = g * 2;
  let minX = 0, minY = 0, maxX = g * 10, maxY = g * 10;
  if (state.rects.length) {
    minX = Math.min(...state.rects.map(r => r.x));
    minY = Math.min(...state.rects.map(r => r.y));
    maxX = Math.max(...state.rects.map(r => r.x + r.w));
    maxY = Math.max(...state.rects.map(r => r.y + r.h));
  }
  minX -= margin; minY -= margin; maxX += margin; maxY += margin;
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);

  const exportScale = 2;
  const off = document.createElement("canvas");
  off.width = Math.round(w * exportScale);
  off.height = Math.round(h * exportScale);
  const octx = off.getContext("2d");
  octx.fillStyle = "#fff";
  octx.fillRect(0, 0, off.width, off.height);

  octx.save();
  octx.scale(exportScale, exportScale);
  octx.strokeStyle = "#d7d7da";
  octx.lineWidth = 1;
  octx.beginPath();
  for (let x = Math.floor(minX / g) * g; x <= maxX; x += g) {
    octx.moveTo(x - minX, 0); octx.lineTo(x - minX, h);
  }
  for (let y = Math.floor(minY / g) * g; y <= maxY; y += g) {
    octx.moveTo(0, y - minY); octx.lineTo(w, y - minY);
  }
  octx.stroke();

  octx.translate(-minX, -minY);
  const savedCtx = ctx;
  // drawRect/drawText use module-level ctx; temporarily swap
  swapCtx(octx, () => {
    for (const r of state.rects) drawRectForExport(r, octx);
  });
  octx.restore();

  off.toBlob(blob => downloadBlob(blob, `storemap-${timestamp()}.png`), "image/png");
}

// drawRect relies on closures over ctx & state.scale; provide export-safe variant
let __ctxOverride = null;
function swapCtx(newCtx, fn) {
  __ctxOverride = newCtx;
  fn();
  __ctxOverride = null;
}
function drawRectForExport(r, octx) {
  const center = rectCenter(r);
  octx.save();
  octx.translate(center.x, center.y);
  octx.rotate((r.rotation * Math.PI) / 180);
  octx.fillStyle = "#ffffff";
  octx.strokeStyle = "#1a1a1a";
  octx.lineWidth = 2;
  octx.fillRect(-r.w / 2, -r.h / 2, r.w, r.h);
  octx.strokeRect(-r.w / 2, -r.h / 2, r.w, r.h);
  if (r.text) {
    const prevCtx = ctx;
    drawTextOn(octx, r);
  }
  octx.restore();
}
function drawTextOn(targetCtx, r) {
  // 書き出し画像はキャンバスの表示回転を含まない(常に真上から見た正規の向き)ため、
  // 四角自体の回転(r.rotation)のみを考慮する。
  const total = ((r.rotation % 360) + 360) % 360;
  const swapped = total === 90 || total === 270;
  const extraRotation = total === 90 ? -90 : total === 180 ? 180 : total === 270 ? 90 : 0;
  const boxW = swapped ? r.h : r.w;
  const boxH = swapped ? r.w : r.h;
  const isHorizontal = boxW >= boxH;
  const maxFont = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.floor(Math.min(r.w, r.h) / 3)));
  targetCtx.save();
  if (extraRotation) targetCtx.rotate((extraRotation * Math.PI) / 180);
  targetCtx.fillStyle = "#1a1a1a";
  targetCtx.textBaseline = "middle";
  if (isHorizontal) {
    const layout = layoutHorizontalWith(targetCtx, r.text, boxW, boxH, maxFont);
    if (!layout) { targetCtx.restore(); return; }
    targetCtx.font = `${layout.fontSize}px sans-serif`;
    targetCtx.textAlign = "center";
    const totalH = layout.lines.length * layout.lineHeight;
    let y = -totalH / 2 + layout.lineHeight / 2;
    for (const line of layout.lines) { targetCtx.fillText(line, 0, y, boxW - PAD * 2); y += layout.lineHeight; }
  } else {
    const layout = layoutVerticalWith(targetCtx, r.text, boxW, boxH, maxFont);
    if (!layout) { targetCtx.restore(); return; }
    targetCtx.font = `${layout.fontSize}px sans-serif`;
    targetCtx.textAlign = "center";
    const totalW = layout.columns.length * layout.colWidth;
    let x = totalW / 2 - layout.colWidth / 2;
    for (const col of layout.columns) {
      let y = -((col.length - 1) * layout.fontSize * 1.15) / 2;
      for (const ch of col) { fillVerticalChar(targetCtx, ch, x, y, layout.colWidth); y += layout.fontSize * 1.15; }
      x -= layout.colWidth;
    }
  }
  targetCtx.restore();
}
function layoutHorizontalWith(c, text, w, h, maxFont) {
  const paras = splitParagraphs(text);
  for (let fontSize = maxFont; fontSize >= MIN_FONT; fontSize--) {
    c.font = `${fontSize}px sans-serif`;
    const lineHeight = fontSize * 1.3;
    const maxWidth = w - PAD * 2;
    const lines = [];
    for (const para of paras) {
      if (para === "") { lines.push(""); continue; }
      let cur = "";
      for (const ch of para) {
        const test = cur + ch;
        if (c.measureText(test).width > maxWidth && cur !== "") { lines.push(cur); cur = ch; }
        else cur = test;
      }
      lines.push(cur);
    }
    const totalHeight = lines.length * lineHeight;
    if (totalHeight <= h - PAD * 2 || fontSize === MIN_FONT) return { fontSize, lineHeight, lines };
  }
}
function layoutVerticalWith(c, text, w, h, maxFont) {
  const paras = splitParagraphs(text);
  for (let fontSize = maxFont; fontSize >= MIN_FONT; fontSize--) {
    const colWidth = fontSize * 1.3;
    const maxCharsPerCol = Math.max(1, Math.floor((h - PAD * 2) / (fontSize * 1.15)));
    const columns = [];
    for (const para of paras) {
      if (para === "") { columns.push(""); continue; }
      let idx = 0;
      while (idx < para.length) { columns.push(para.slice(idx, idx + maxCharsPerCol)); idx += maxCharsPerCol; }
    }
    const totalWidth = columns.length * colWidth;
    if (totalWidth <= w - PAD * 2 || fontSize === MIN_FONT) return { fontSize, colWidth, columns };
  }
}

/* ---------------------------------------------------------
   設定パネル
--------------------------------------------------------- */
document.getElementById("btn-settings").addEventListener("click", () => {
  syncGridUI();
  settingsPanel.classList.remove("hidden");
});
const gridRange = document.getElementById("grid-size-range");
const gridValue = document.getElementById("grid-size-value");
function syncGridUI() {
  gridRange.value = state.gridSize;
  gridValue.textContent = state.gridSize + "px";
}
gridRange.addEventListener("input", () => {
  state.gridSize = parseInt(gridRange.value, 10);
  gridValue.textContent = state.gridSize + "px";
  draw();
});
document.getElementById("settings-clear").addEventListener("click", () => {
  if (confirm("キャンバス上のすべての四角を削除します。よろしいですか?")) {
    pushHistory();
    state.rects = [];
    clearSelection();
    settingsPanel.classList.add("hidden");
    draw();
  }
});

/* ---------------------------------------------------------
   ヘルプ(このアプリについて)
--------------------------------------------------------- */
document.getElementById("btn-help").addEventListener("click", () => {
  saveToLocalStorage();
  window.location.href = "about.html";
});

/* ---------------------------------------------------------
   フルスクリーン
--------------------------------------------------------- */
document.getElementById("btn-fullscreen").addEventListener("click", () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
});

/* ---------------------------------------------------------
   表示を全体にフィット
--------------------------------------------------------- */
function fitView() {
  state.viewRotation = 0;
  if (!state.rects.length) { state.scale = 1; state.offsetX = 40; state.offsetY = 90; draw(); return; }
  const margin = state.gridSize * 3;
  const minX = Math.min(...state.rects.map(r => r.x)) - margin;
  const minY = Math.min(...state.rects.map(r => r.y)) - margin;
  const maxX = Math.max(...state.rects.map(r => r.x + r.w)) + margin;
  const maxY = Math.max(...state.rects.map(r => r.y + r.h)) + margin;
  const w = window.innerWidth, h = window.innerHeight;
  const scaleX = w / (maxX - minX), scaleY = h / (maxY - minY);
  state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(scaleX, scaleY)));
  state.offsetX = -minX * state.scale;
  state.offsetY = -minY * state.scale;
  draw();
}

/* ---------------------------------------------------------
   自動保存(再起動時に編集内容を復元)
--------------------------------------------------------- */
const STORAGE_KEY = "storemap-autosave-v1";
let autosaveTimer = null;

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveToLocalStorage, 400);
}

function saveToLocalStorage() {
  try {
    const data = {
      version: 1,
      gridSize: state.gridSize,
      rects: state.rects,
      nextId: state.nextId,
      scale: state.scale,
      offsetX: state.offsetX,
      offsetY: state.offsetY,
      viewRotation: state.viewRotation,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (err) { /* 保存先が使えない場合は無視 */ }
}

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.rects)) return false;
    state.rects = data.rects;
    state.gridSize = data.gridSize || state.gridSize;
    const maxId = data.rects.reduce((m, r) => Math.max(m, r.id || 0), 0);
    state.nextId = Math.max(data.nextId || 1, maxId + 1);
    if (typeof data.scale === "number") state.scale = data.scale;
    if (typeof data.offsetX === "number") state.offsetX = data.offsetX;
    if (typeof data.offsetY === "number") state.offsetY = data.offsetY;
    if (typeof data.viewRotation === "number") state.viewRotation = ((data.viewRotation % 360) + 360) % 360;
    return true;
  } catch (err) {
    return false;
  }
}

// アプリが閉じられる/バックグラウンドに回る瞬間に確実に保存する
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveToLocalStorage();
});
window.addEventListener("pagehide", saveToLocalStorage);
window.addEventListener("beforeunload", saveToLocalStorage);

/* ---------------------------------------------------------
   PWAアップデート検知・確認ダイアログ
   GitHub Pages上のsw.jsが更新されると、ブラウザが新しいService
   Workerを「待機中」の状態でインストールする。ここではそれを検知し
   たら、ユーザーに今すぐ更新するかどうかを尋ねるダイアログを出す。
   「今すぐ更新」が押されたら待機中のワーカーへ skipWaiting を指示
   し、控えているコントローラー切り替わりを検知してページを再読込
   することで最新版を反映する。
--------------------------------------------------------- */
const updateDialog = document.getElementById("update-dialog");
let pendingRegistration = null;

function showUpdateDialog(reg) {
  pendingRegistration = reg;
  updateDialog.classList.remove("hidden");
}
function hideUpdateDialog() {
  updateDialog.classList.add("hidden");
}

document.getElementById("update-now").addEventListener("click", () => {
  if (pendingRegistration && pendingRegistration.waiting) {
    pendingRegistration.waiting.postMessage({ type: "SKIP_WAITING" });
  }
  hideUpdateDialog();
});
document.getElementById("update-later").addEventListener("click", () => {
  hideUpdateDialog();
});

function initServiceWorker() {
  if (!("serviceWorker" in navigator) || !(location.protocol === "https:" || location.hostname === "localhost")) return;

  navigator.serviceWorker.register("sw.js").then((reg) => {
    // 登録時点ですでに新しいバージョンが待機中だった場合(前回起動時に「後で」を選んだ場合など)
    if (reg.waiting && navigator.serviceWorker.controller) {
      showUpdateDialog(reg);
    }

    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        // controller が既に存在する = 初回インストールではなく更新である
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          showUpdateDialog(reg);
        }
      });
    });

    // アプリをフォアグラウンドに戻した際などに能動的に更新をチェック
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => {});

  // 「今すぐ更新」によって新しいワーカーがアクティブ化されたらページを再読込
  let hasReloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hasReloaded) return;
    hasReloaded = true;
    window.location.reload();
  });
}

/* ---------------------------------------------------------
   初期化
--------------------------------------------------------- */
function init() {
  const restored = loadFromLocalStorage();
  resizeCanvas();
  layoutToolbars();
  syncGridUI();
  updateUndoRedoButtons();
  updateModeButton();
  if (restored && state.rects.length) {
    showHint("前回の編集内容を復元しました", 2000);
  } else {
    showHint("キャンバスをスワイプして四角を配置", 2400);
  }
  initServiceWorker();
}
init();

})();
