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
  rects: [],           // {id,x,y,w,h,rotation,text,fontSize}
  nextId: 1,
};

let selection = new Set();   // 選択中の四角のID集合(通常モードでも0〜1個で利用)

/* ---------------------------------------------------------
   編集モード (hand / pencil / select)
--------------------------------------------------------- */
const MODE_ORDER = ["hand", "pencil", "select"];
let editMode = "pencil";
let isSelectMode = false;    // editMode === "select" と同期させておく(既存コード互換用)

const MODE_ICONS = {
  hand: `<svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l3 3" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19l-4 1z" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 7l3 3" fill="none" stroke-width="1.6"/></svg>`,
  select: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke-width="1.7" stroke-dasharray="3 2.4"/><circle cx="4" cy="4" r="1.6" fill="#fff" stroke="none"/><circle cx="20" cy="4" r="1.6" fill="#fff" stroke="none"/><circle cx="4" cy="20" r="1.6" fill="#fff" stroke="none"/><circle cx="20" cy="20" r="1.6" fill="#fff" stroke="none"/></svg>`,
};
const MODE_TITLES = {
  hand: "ハンドモード(タップで切替)",
  pencil: "ペンシルモード(タップで切替)",
  select: "範囲選択モード(タップで切替)",
};
const MODE_HINTS = {
  hand: "ハンドモード:1本指でキャンバスを移動できます",
  pencil: "ペンシルモード:1本指のスワイプで四角を作成できます",
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
  return { x: x * state.scale + state.offsetX, y: y * state.scale + state.offsetY };
}
function screenToWorld(x, y) {
  return { x: (x - state.offsetX) / state.scale, y: (y - state.offsetY) / state.scale };
}
function rotVec(x, y, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: x * c - y * s, y: x * s + y * c };
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

// 選択中の四角群を、外接矩形の中心を軸に stepDeg 度だけ一括回転する
function rotateGroup(rects, pivot, stepDeg) {
  const g = state.gridSize;
  for (const r of rects) {
    const c = rectCenter(r);
    const rel = { x: c.x - pivot.x, y: c.y - pivot.y };
    const rotated = rotVec(rel.x, rel.y, stepDeg);
    const newCenter = { x: pivot.x + rotated.x, y: pivot.y + rotated.y };
    r.x = snap(newCenter.x - r.w / 2, g);
    r.y = snap(newCenter.y - r.h / 2, g);
    r.rotation = ((r.rotation + stepDeg) % 360 + 360) % 360;
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

  drawGrid();

  ctx.save();
  ctx.translate(state.offsetX, state.offsetY);
  ctx.scale(state.scale, state.scale);
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

function drawGrid() {
  const g = state.gridSize;
  const w = canvas.width / DPR, h = canvas.height / DPR;
  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(w, h);

  const startX = Math.floor(topLeft.x / g) * g;
  const endX = Math.ceil(bottomRight.x / g) * g;
  const startY = Math.floor(topLeft.y / g) * g;
  const endY = Math.ceil(bottomRight.y / g) * g;

  ctx.save();
  ctx.strokeStyle = "#d7d7da";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x <= endX; x += g) {
    const sx = Math.round(worldToScreen(x, 0).x) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
  }
  for (let y = startY; y <= endY; y += g) {
    const sy = Math.round(worldToScreen(0, y).y) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
  }
  ctx.stroke();
  ctx.restore();
}

function drawRect(r) {
  const sel = isSelected(r.id);
  const groupSel = sel && (isSelectMode || selection.size > 1);
  const center = rectCenter(r);
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate((r.rotation * Math.PI) / 180);

  // 本体
  ctx.fillStyle = groupSel ? "rgba(43,108,246,0.14)" : "#ffffff";
  ctx.strokeStyle = sel ? "#2b6cf6" : "#1a1a1a";
  ctx.lineWidth = (sel ? 3 : 2) / state.scale;
  ctx.fillRect(-r.w / 2, -r.h / 2, r.w, r.h);
  ctx.strokeRect(-r.w / 2, -r.h / 2, r.w, r.h);

  if (r.text) drawText(r);

  ctx.restore();

  if (sel && !groupSel) drawHandles(r);
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

function drawText(r) {
  const isHorizontal = r.w >= r.h; // 正方形・横長 -> 横書き / 縦長 -> 縦書き
  const maxFont = Math.max(MIN_FONT, Math.min(24, Math.floor(Math.min(r.w, r.h) / 3)));

  ctx.fillStyle = "#1a1a1a";
  ctx.textBaseline = "middle";

  if (isHorizontal) {
    const layout = layoutHorizontal(r.text, r.w, r.h, maxFont);
    if (!layout) return;
    ctx.font = `${layout.fontSize}px sans-serif`;
    ctx.textAlign = "center";
    const totalH = layout.lines.length * layout.lineHeight;
    let y = -totalH / 2 + layout.lineHeight / 2;
    for (const line of layout.lines) {
      ctx.fillText(line, 0, y, r.w - PAD * 2);
      y += layout.lineHeight;
    }
  } else {
    const layout = layoutVertical(r.text, r.w, r.h, maxFont);
    if (!layout) return;
    ctx.font = `${layout.fontSize}px sans-serif`;
    ctx.textAlign = "center";
    const totalW = layout.columns.length * layout.colWidth;
    // 右から左に並べる(縦書きの慣習)
    let x = totalW / 2 - layout.colWidth / 2;
    for (const col of layout.columns) {
      let y = -((col.length - 1) * layout.fontSize * 1.15) / 2;
      for (const ch of col) {
        ctx.fillText(ch, x, y, layout.colWidth);
        y += layout.fontSize * 1.15;
      }
      x -= layout.colWidth;
    }
  }
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
    startTwoFingerGesture();
  }
}

function startSingleDrag(x, y) {
  if (editMode === "hand") {
    dragMode = "pan";
    dragData = { startScreenX: x, startScreenY: y, startOffsetX: state.offsetX, startOffsetY: state.offsetY };
    draw();
    return;
  }

  const hit = hitTest(x, y);
  const now = Date.now();

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
  dragMode = "pinch";
  dragData = {
    startDist: dist,
    startScale: state.scale,
    startOffsetX: state.offsetX,
    startOffsetY: state.offsetY,
    midWorld: screenToWorld(mid.x, mid.y),
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

  if (dragMode === "pan") {
    state.offsetX = dragData.startOffsetX + (e.clientX - dragData.startScreenX);
    state.offsetY = dragData.startOffsetY + (e.clientY - dragData.startScreenY);
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
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const factor = dist / dragData.startDist;
    let newScale = dragData.startScale * factor;
    newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    state.scale = newScale;
    state.offsetX = mid.x - dragData.midWorld.x * newScale;
    state.offsetY = mid.y - dragData.midWorld.y * newScale;
    draw();
    showZoom();
  } else if (dragMode === "rotate" && pointers.size >= 2) {
    const pts = [...pointers.values()];
    const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * (180 / Math.PI);
    let delta = ang - dragData.baseAngle;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    const THRESH = 42;
    if (Math.abs(delta) >= THRESH) {
      const step = delta > 0 ? 90 : -90;
      for (const r of dragData.rects) r.rotation = ((r.rotation + step) % 360 + 360) % 360;
      dragData.baseAngle = ang;
      draw();
      if (navigator.vibrate) navigator.vibrate(8);
    }
  } else if (dragMode === "rotate-group" && pointers.size >= 2) {
    const pts = [...pointers.values()];
    const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * (180 / Math.PI);
    let delta = ang - dragData.baseAngle;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    const THRESH = 42;
    if (Math.abs(delta) >= THRESH) {
      const step = delta > 0 ? 90 : -90;
      rotateGroup(dragData.rects, dragData.pivot, step);
      dragData.baseAngle = ang;
      draw();
      if (navigator.vibrate) navigator.vibrate(8);
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
  ctx.translate(state.offsetX, state.offsetY);
  ctx.scale(state.scale, state.scale);
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
  state.offsetX += e.clientX - after.x;
  state.offsetY += e.clientY - after.y;
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
         !document.getElementById("settings-panel").classList.contains("hidden");
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

document.getElementById("btn-mode").addEventListener("click", cycleMode);

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
   保存 / 読み込み
--------------------------------------------------------- */
const saveMenu = document.getElementById("save-menu");
const settingsPanel = document.getElementById("settings-panel");

document.getElementById("btn-save").addEventListener("click", () => {
  saveMenu.classList.remove("hidden");
});
document.getElementById("btn-load").addEventListener("click", () => {
  document.getElementById("file-input").click();
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
  saveMenu.classList.add("hidden");
});

document.getElementById("save-png").addEventListener("click", () => {
  exportPNG();
  saveMenu.classList.add("hidden");
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
  // 一時的にレイアウト計算用ctxを差し替え(measureTextのため)
  const globalCtxBackup = window.__measureCtx;
  const isHorizontal = r.w >= r.h;
  const maxFont = Math.max(MIN_FONT, Math.min(24, Math.floor(Math.min(r.w, r.h) / 3)));
  targetCtx.fillStyle = "#1a1a1a";
  targetCtx.textBaseline = "middle";
  if (isHorizontal) {
    const layout = layoutHorizontalWith(targetCtx, r.text, r.w, r.h, maxFont);
    if (!layout) return;
    targetCtx.font = `${layout.fontSize}px sans-serif`;
    targetCtx.textAlign = "center";
    const totalH = layout.lines.length * layout.lineHeight;
    let y = -totalH / 2 + layout.lineHeight / 2;
    for (const line of layout.lines) { targetCtx.fillText(line, 0, y, r.w - PAD * 2); y += layout.lineHeight; }
  } else {
    const layout = layoutVerticalWith(targetCtx, r.text, r.w, r.h, maxFont);
    if (!layout) return;
    targetCtx.font = `${layout.fontSize}px sans-serif`;
    targetCtx.textAlign = "center";
    const totalW = layout.columns.length * layout.colWidth;
    let x = totalW / 2 - layout.colWidth / 2;
    for (const col of layout.columns) {
      let y = -((col.length - 1) * layout.fontSize * 1.15) / 2;
      for (const ch of col) { targetCtx.fillText(ch, x, y, layout.colWidth); y += layout.fontSize * 1.15; }
      x -= layout.colWidth;
    }
  }
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
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
init();

})();
