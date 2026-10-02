'use strict';

// 已发布图纸 1:1 分张打印核心（纯函数，只读）。
//
// 图纸坐标系：x 向右、y 向上，原点在窗框左下角（与拼片台一致）。
// SVG 坐标系：x 向右、y 向下，原点在纸张左上角；映射 X = margin + (x - covX0)，
// Y = marginTop + (covY1 - y)。所有 SVG 尺寸属性均为毫米数值，由根节点
// width/height（物理毫米）确定 1 用户单位 = 1 mm。
//
// 分张：列 x 优先从左到右、行从上到下（行 1 覆盖图纸顶部）。每张纸可打印区
// = 纸张减去四边留白；每页沿 x/y 前进 (可打印边长 - 重叠)，相邻页因此覆盖
// 一段相同图纸坐标，末页覆盖范围夹到窗框边界。

const MAX_PAGES = 200;
const MAX_PAPER_MM = 100000;

// ---------- 参数解析 ----------

function intField(src, key, { query = false } = {}) {
  if (src[key] === undefined || src[key] === null || src[key] === '') {
    return { missing: true };
  }
  const n = query ? Number(src[key]) : src[key];
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    return { bad: true };
  }
  return { value: n };
}

// 从 POST JSON 或 GET query 解析分张参数。
// 返回 { ok, params } 或 { ok:false, error }。
function parseParams(src, { query = false } = {}) {
  const fields = [
    ['paperWidth', '纸张宽度'],
    ['paperHeight', '纸张高度'],
    ['marginTop', '上边留白'],
    ['marginRight', '右边留白'],
    ['marginBottom', '下边留白'],
    ['marginLeft', '左边留白'],
    ['overlap', '相邻页重叠宽度'],
  ];
  const p = {};
  for (const [key, label] of fields) {
    const r = intField(src, key, { query });
    if (r.missing) return { ok: false, error: `缺少参数：${key}（${label}，整数毫米）` };
    if (r.bad) return { ok: false, error: `${label}必须是整数毫米（${key}）` };
    p[key] = r.value;
  }
  if (p.paperWidth <= 0 || p.paperHeight <= 0) {
    return { ok: false, error: '纸张宽高必须为正整数毫米' };
  }
  if (p.paperWidth > MAX_PAPER_MM || p.paperHeight > MAX_PAPER_MM) {
    return { ok: false, error: `纸张尺寸过大（单边上限 ${MAX_PAPER_MM} 毫米）` };
  }
  for (const [k, label] of [['marginTop', '上边留白'], ['marginRight', '右边留白'], ['marginBottom', '下边留白'], ['marginLeft', '左边留白']]) {
    if (p[k] < 0) return { ok: false, error: `${label}必须是不小于 0 的整数毫米` };
  }
  if (p.overlap <= 0) return { ok: false, error: '相邻页重叠宽度必须为正整数毫米' };

  const printableWidth = p.paperWidth - p.marginLeft - p.marginRight;
  const printableHeight = p.paperHeight - p.marginTop - p.marginBottom;
  if (printableWidth <= 0 || printableHeight <= 0) {
    return { ok: false, error: `可打印尺寸非正：${printableWidth} × ${printableHeight} mm（四边留白之和不得达到或超过纸张尺寸）` };
  }
  if (p.overlap >= printableWidth || p.overlap >= printableHeight) {
    return {
      ok: false,
      error: `重叠宽度 ${p.overlap} mm 必须小于任一可打印边长（可打印区 ${printableWidth} × ${printableHeight} mm）`,
    };
  }
  return { ok: true, params: { ...p, printableWidth, printableHeight } };
}

// ---------- 分页 ----------

// 单轴分页（0 基）：每页步长 = 可打印边长 - 重叠；末页起点回退到 total-printable，
// 保证整段被覆盖且末页可打印区不超出图纸。
function axisSpans(total, printable, overlap) {
  const step = printable - overlap;
  const spans = [];
  if (total <= printable) {
    spans.push({ index: 0, start: 0, end: total, cover: total });
    return spans;
  }
  let start = 0;
  let i = 0;
  while (start + printable < total) {
    spans.push({ index: i, start, end: start + printable, cover: printable });
    start += step;
    i += 1;
  }
  const lastStart = Math.max(0, total - printable);
  spans.push({ index: i, start: lastStart, end: total, cover: total - lastStart });
  return spans;
}

// 计算分张方案。返回 { ok, cols, rows, pageCount, xs, ys, pages }（page 含行/列号、覆盖坐标）
// 或 { ok:false, error, code }（code='too_many_pages' 时调用方返回 422）。
function planTiles(snapshot, params) {
  const width = Number(snapshot.width);
  const height = Number(snapshot.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, error: '发布快照缺少有效的窗框宽高', code: 'bad_snapshot' };
  }
  const xs = axisSpans(width, params.printableWidth, params.overlap);
  const ys = axisSpans(height, params.printableHeight, params.overlap);
  const cols = xs.length;
  const rows = ys.length;
  const pageCount = cols * rows;
  if (pageCount > MAX_PAGES) {
    return {
      ok: false,
      code: 'too_many_pages',
      error: `分张页数 ${pageCount}（${cols} 列 × ${rows} 行）超过上限 ${MAX_PAGES} 页，请改用更大纸张或减小重叠`,
      cols, rows, pageCount,
    };
  }
  const pages = [];
  let pageNo = 0;
  // 行 1 = 图纸顶部（y 覆盖最大的一行）
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = 0; c < cols; c++) {
      pageNo += 1;
      pages.push({
        page: pageNo,
        row: rows - r,
        col: c + 1,
        x0: xs[c].start,
        x1: xs[c].end,
        y0: ys[r].start,
        y1: ys[r].end,
        coverWidth: xs[c].cover,
        coverHeight: ys[r].cover,
      });
    }
  }
  return { ok: true, cols, rows, pageCount, xs, ys, pages };
}

function findPage(plan, page) {
  return plan.pages.find((q) => q.page === page) || null;
}

// 该页四条边是否与另一张纸拼接；无拼接为 null
function seamsForPage(plan, pg) {
  const left = pg.col > 1 ? plan.pages.find((q) => q.row === pg.row && q.col === pg.col - 1) : null;
  const right = pg.col < plan.cols ? plan.pages.find((q) => q.row === pg.row && q.col === pg.col + 1) : null;
  const above = pg.row > 1 ? plan.pages.find((q) => q.col === pg.col && q.row === pg.row - 1) : null;
  const below = pg.row < plan.rows ? plan.pages.find((q) => q.col === pg.col && q.row === pg.row + 1) : null;
  return { left, right, above, below };
}

// ---------- 几何小工具 ----------

// 多边形面积中心（图纸坐标）；退化时退回顶点均值
function centroid(poly) {
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const f = poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1];
    a2 += f;
    cx += (poly[i][0] + poly[j][0]) * f;
    cy += (poly[i][1] + poly[j][1]) * f;
  }
  if (Math.abs(a2) < 1e-9) {
    return [
      poly.reduce((s, q) => s + q[0], 0) / poly.length,
      poly.reduce((s, q) => s + q[1], 0) / poly.length,
    ];
  }
  return [cx / (3 * a2), cy / (3 * a2)];
}

// 多边形与轴对齐矩形（本页覆盖的图纸区域）求交（Sutherland–Hodgman）。
// 玻璃片跨页时用于得到“本页内那部分”的标签位置；入参整数，交点可为小数。
function clipPolygonRect(poly, x0, y0, x1, y1) {
  let out = poly.map((p) => p.slice());
  const inside = [
    ([x, y]) => x >= x0,
    ([x, y]) => x <= x1,
    ([x, y]) => y >= y0,
    ([x, y]) => y <= y1,
  ];
  const intersect = (a, b, side) => {
    const [ax, ay] = a;
    const [bx, by] = b;
    let t;
    if (side === 0) t = (x0 - ax) / (bx - ax);
    else if (side === 1) t = (x1 - ax) / (bx - ax);
    else if (side === 2) t = (y0 - ay) / (by - ay);
    else t = (y1 - ay) / (by - ay);
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  };
  for (let side = 0; side < 4; side++) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const cin = inside[side](cur);
      const pin = inside[side](prev);
      if (cin) {
        if (!pin) out.push(intersect(prev, cur, side));
        out.push(cur);
      } else if (pin) {
        out.push(intersect(prev, cur, side));
      }
    }
  }
  return out;
}

// ---------- 预览 JSON ----------

function buildPreview({ publication, params, plan }) {
  const s = publication.snapshot;
  const pages = plan.pages.map((pg) => {
    const seams = seamsForPage(plan, pg);
    const pieces = [];
    for (const pc of s.pieces) {
      const clipped = clipPolygonRect(pc.polygon, pg.x0, pg.y0, pg.x1, pg.y1);
      if (clipped.length < 3) continue;
      const [cx, cy] = centroid(clipped);
      pieces.push({ pieceNo: pc.pieceNo, labelAt: [round3(cx), round3(cy)] });
    }
    const overlapEdges = [];
    if (seams.left) overlapEdges.push({ side: 'left', overlapsPage: seams.left.page, seamX: pg.x0, stripToX: pg.x0 + params.overlap });
    if (seams.right) overlapEdges.push({ side: 'right', overlapsPage: seams.right.page, seamX: pg.x1, stripFromX: pg.x1 - params.overlap });
    if (seams.above) overlapEdges.push({ side: 'top', overlapsPage: seams.above.page, seamY: pg.y1, stripFromY: pg.y1 - params.overlap });
    if (seams.below) overlapEdges.push({ side: 'bottom', overlapsPage: seams.below.page, seamY: pg.y0, stripToY: pg.y0 + params.overlap });
    return {
      page: pg.page,
      row: pg.row,
      col: pg.col,
      coverage: { x0: pg.x0, y0: pg.y0, x1: pg.x1, y1: pg.y1, width: pg.coverWidth, height: pg.coverHeight },
      pieceLabels: pieces,
      overlapEdges,
      svgUrl: `/api/designs/${publication.designId}/publications/${publication.version}/print/${pg.page}/svg?` +
        `paperWidth=${params.paperWidth}&paperHeight=${params.paperHeight}` +
        `&marginTop=${params.marginTop}&marginRight=${params.marginRight}` +
        `&marginBottom=${params.marginBottom}&marginLeft=${params.marginLeft}&overlap=${params.overlap}`,
    };
  });
  return {
    designId: publication.designId,
    version: publication.version,
    publicationId: publication.id,
    publishedAt: publication.publishedAt,
    designName: s.name,
    drawing: { width: s.width, height: s.height },
    paper: {
      width: params.paperWidth,
      height: params.paperHeight,
      marginTop: params.marginTop,
      marginRight: params.marginRight,
      marginBottom: params.marginBottom,
      marginLeft: params.marginLeft,
      printableWidth: params.printableWidth,
      printableHeight: params.printableHeight,
    },
    overlap: params.overlap,
    grid: { rows: plan.rows, cols: plan.cols, pageCount: plan.pageCount, maxPages: MAX_PAGES },
    pages,
  };
}

// ---------- SVG 单页渲染 ----------

function xmlEscape(v) {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// 渲染单页 SVG 字符串；page 越界返回 null。
function renderPageSvg({ publication, params, plan, page }) {
  const pg = findPage(plan, page);
  if (!pg) return null;
  const s = publication.snapshot;
  const P = params;

  const W = P.paperWidth;
  const H = P.paperHeight;
  const mL = P.marginLeft;
  const mR = P.marginRight;
  const mT = P.marginTop;
  const mB = P.marginBottom;
  const pw = P.printableWidth;
  const ph = P.printableHeight;

  // 图纸坐标 -> SVG（毫米）
  const X = (x) => round3(mL + (x - pg.x0));
  const Y = (y) => round3(mT + (pg.y1 - y));

  const clipId = `printclip-${pg.page}`;
  const out = [];
  out.push(
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" ` +
      `data-unit="mm" data-page="${pg.page}" data-row="${pg.row}" data-col="${pg.col}">`,
    `<title>${xmlEscape(s.name)} v${publication.version} · 第 ${pg.page}/${plan.pageCount} 页（${pg.col}列${pg.row}行）</title>`,
    `<desc>1:1 分张打印：SVG 用户单位即毫米；全部图纸内容裁切在 ${pw} × ${ph} mm 可打印区内，并含毫米校准标尺。</desc>`,
  );

  // 纸张背景与边界
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  out.push(`<rect x="0.5" y="0.5" width="${round3(W - 1)}" height="${round3(H - 1)}" fill="none" stroke="#d9d9d9" stroke-width="0.2"/>`);

  // 可打印区：浅界 + 内容裁切
  out.push(`<defs><clipPath id="${clipId}"><rect x="${mL}" y="${mT}" width="${pw}" height="${ph}"/></clipPath></defs>`);
  out.push(`<rect x="${mL}" y="${mT}" width="${pw}" height="${ph}" fill="none" stroke="#9aa0a6" stroke-width="0.25" stroke-dasharray="1.2 1"/>`);

  out.push(`<g clip-path="url(#${clipId})">`);
  out.push(`<rect x="${mL}" y="${mT}" width="${pw}" height="${ph}" fill="#fbfaf7"/>`);

  // ---- 玻璃片（跨页由 clip-path 裁到可打印区）----
  for (const pc of s.pieces) {
    const pts = pc.polygon.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ');
    out.push(
      `<polygon points="${pts}" fill="${pc.color}" fill-opacity="0.62" stroke="#262626" stroke-width="0.35" stroke-linejoin="round"/>`,
    );
  }

  // ---- 拼接标记（先于外框/编号/标尺，保证最上层可读）----
  const seams = seamsForPage(plan, pg);
  appendSeams(out, { pg, seams, X, Y, overlap: P.overlap });

  // ---- 外框（快照）；出界部分同样被裁 ----
  const fx = X(0), fy = Y(s.height);
  out.push(
    `<rect x="${fx}" y="${fy}" width="${s.width}" height="${s.height}" fill="none" stroke="#111111" stroke-width="0.7"/>`,
  );

  // ---- 玻璃片编号：编号取自快照；该片跨页时，以“本页内那部分”的面积中心定位 ----
  for (const pc of s.pieces) {
    const clipped = clipPolygonRect(pc.polygon, pg.x0, pg.y0, pg.x1, pg.y1);
    if (clipped.length < 3) continue;
    const [cx, cy] = centroid(clipped);
    const tx = X(cx);
    const ty = Y(cy);
    const label = `#${pc.pieceNo}`;
    const fs = Math.min(5, Math.max(2.6, Math.min(pw, ph) / 16));
    out.push(
      `<text x="${tx}" y="${ty}" font-family="sans-serif" font-size="${round3(fs)}" font-weight="bold" ` +
        `text-anchor="middle" dominant-baseline="central" fill="#111111" stroke="#ffffff" stroke-width="0.9" ` +
        `paint-order="stroke">${xmlEscape(label)}</text>`,
    );
  }

  // ---- 页眉 ----
  appendHeader(out, { pg, plan, publication, snapshot: s, params: P });

  out.push(`</g>`);

  // ---- 可打印区四角切齐标记（L 形，位于区域内侧）----
  appendCornerMarks(out, { mL, mT, pw, ph });

  // ---- 毫米校准标尺（位于可打印区内）----
  appendRuler(out, { mL, mT, pw, ph });

  out.push(`</svg>`);
  return out.join('\n');
}

// 拼接缝与对版标记。纸边虚线是本页裁切/对齐边；菱形放在重叠区正中的同一图纸
// 坐标上，两张纸按重叠区对齐时菱形彼此重合。
function appendSeams(out, { pg, seams, X, Y, overlap }) {
  const drawVertical = (neighbor, seamX, dir /* 'left' | 'right' */) => {
    if (!neighbor) return;
    const yTop = pg.y1;
    const yBot = pg.y0;
    out.push(
      `<line x1="${X(seamX)}" y1="${Y(yTop)}" x2="${X(seamX)}" y2="${Y(yBot)}" ` +
        `stroke="#c0281c" stroke-width="0.3" stroke-dasharray="2 1.2"/>`,
    );
    // 对版菱形：重叠区中线的同一图纸坐标，y 方向 1/3、2/3 各一枚
    const regX = dir === 'right' ? seamX - overlap / 2 : seamX + overlap / 2;
    for (const f of [1 / 3, 2 / 3]) {
      appendDiamond(out, X(regX), Y(yBot + (yTop - yBot) * f), 1.4);
    }
    // 重叠带内的小字：标明对贴页、重叠区的图纸坐标范围与对版标记坐标
    const inset = Math.min(overlap / 2, Math.max(2, overlap - 1.5));
    const labelX = dir === 'right' ? seamX - inset : seamX + inset;
    const range = dir === 'right' ? `${seamX - overlap}–${seamX}` : `${seamX}–${seamX + overlap}`;
    const txt = `与第 ${neighbor.page} 页（${neighbor.col}列${neighbor.row}行）对贴 · 重叠区 x=${range} mm · 对版标记 x=${round3(regX)}`;
    out.push(
      `<text x="${X(labelX)}" y="${round3(Y(yTop) + 2.6)}" font-family="sans-serif" font-size="2.2" ` +
        `text-anchor="${dir === 'right' ? 'end' : 'start'}" fill="#c0281c">${xmlEscape(txt)}</text>`,
    );
  };

  const drawHorizontal = (neighbor, seamY, dir /* 'top' | 'bottom' */) => {
    if (!neighbor) return;
    const xL = pg.x0;
    const xR = pg.x1;
    out.push(
      `<line x1="${X(xL)}" y1="${Y(seamY)}" x2="${X(xR)}" y2="${Y(seamY)}" ` +
        `stroke="#c0281c" stroke-width="0.3" stroke-dasharray="2 1.2"/>`,
    );
    const regY = dir === 'top' ? seamY - overlap / 2 : seamY + overlap / 2;
    for (const f of [1 / 3, 2 / 3]) {
      appendDiamond(out, X(xL + (xR - xL) * f), Y(regY), 1.4);
    }
    const inset = Math.min(overlap / 2, Math.max(2, overlap - 1.5));
    const labelY = dir === 'top' ? seamY - inset : seamY + inset;
    const range = dir === 'top' ? `${seamY - overlap}–${seamY}` : `${seamY}–${seamY + overlap}`;
    const txt = `与第 ${neighbor.page} 页（${neighbor.col}列${neighbor.row}行）对贴 · 重叠区 y=${range} mm · 对版标记 y=${round3(regY)}`;
    out.push(
      `<text x="${round3(X(xL) + 1.5)}" y="${Y(labelY)}" font-family="sans-serif" font-size="2.2" ` +
        `text-anchor="start" fill="#c0281c">${xmlEscape(txt)}</text>`,
    );
  };

  if (seams.right) drawVertical(seams.right, pg.x1, 'right');
  if (seams.left) drawVertical(seams.left, pg.x0, 'left');
  if (seams.above) drawHorizontal(seams.above, pg.y1, 'top');
  if (seams.below) drawHorizontal(seams.below, pg.y0, 'bottom');
}

function appendDiamond(out, cx, cy, r) {
  const pts = `${round3(cx)},${round3(cy - r)} ${round3(cx + r)},${cy} ${cx},${round3(cy + r)} ${round3(cx - r)},${cy}`;
  out.push(`<polygon points="${pts}" fill="#ffffff" fill-opacity="0.85" stroke="#c0281c" stroke-width="0.3"/>`);
}

// 页眉：图纸名/版本/行列页码/覆盖坐标/纸张与重叠参数（留白为 0 时也在可打印区内）
function appendHeader(out, { pg, plan, publication, snapshot, params }) {
  const pw = params.printableWidth;
  const ph = params.printableHeight;
  const x = params.marginLeft + 2;
  const y = params.marginTop + 2;
  const compact = Math.min(pw, ph) < 60;
  const lines = compact
    ? [
        `${snapshot.name} v${publication.version}`,
        `${pg.page}/${plan.pageCount}（${pg.col}列${pg.row}行） x${pg.x0}-${pg.x1} y${pg.y0}-${pg.y1}`,
      ]
    : [
        `${snapshot.name} · 已发布 v${publication.version}（不可变快照）`,
        `第 ${pg.page} / ${plan.pageCount} 页　第 ${pg.col} 列 · 第 ${pg.row} 行（共 ${plan.cols} 列 × ${plan.rows} 行）`,
        `本页图纸坐标：x ${pg.x0}–${pg.x1} mm，y ${pg.y0}–${pg.y1} mm（覆盖 ${pg.coverWidth} × ${pg.coverHeight} mm）`,
        `纸张 ${params.paperWidth}×${params.paperHeight} mm；可打印区 ${pw}×${ph} mm；相邻页重叠 ${params.overlap} mm`,
      ];
  const fs = compact ? 2.4 : 2.8;
  const lh = fs + 0.9;
  const boxH = lines.length * lh + 1.6;
  out.push(`<rect x="${round3(x - 1)}" y="${round3(y - 1)}" width="${round3(Math.max(20, pw - 2))}" height="${round3(boxH)}" fill="#ffffff" fill-opacity="0.78"/>`);
  lines.forEach((line, i) => {
    out.push(
      `<text x="${x}" y="${round3(y + fs * 0.7 + i * lh)}" font-family="sans-serif" font-size="${fs}" fill="#333333">${xmlEscape(line)}</text>`,
    );
  });
}

// 四角切齐标记：位于可打印区四角内侧的 L 形
function appendCornerMarks(out, { mL, mT, pw, ph }) {
  const a = Math.min(4, Math.min(pw, ph) / 4);
  const sw = 0.35;
  const corners = [
    [mL, mT, 1, 1],
    [mL + pw, mT, -1, 1],
    [mL, mT + ph, 1, -1],
    [mL + pw, mT + ph, -1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    out.push(
      `<path d="M ${round3(x + sx * a)} ${y} L ${x} ${y} L ${x} ${round3(y + sy * a)}" ` +
        `fill="none" stroke="#111111" stroke-width="${sw}"/>`,
    );
  }
}

// 毫米校准标尺：位于可打印区内（左下内侧），水平主尺 + 竖直尾尺（校验纵横比）
function appendRuler(out, { mL, mT, pw, ph }) {
  const compact = Math.min(pw, ph) < 55;
  const x0 = mL + 3;
  const y0 = mT + ph - (compact ? 3 : 4);
  const candidates = [500, 300, 200, 100, 50, 30, 20, 10];
  let len = candidates.find((v) => v <= pw - 6);
  if (len === undefined) len = Math.max(5, Math.floor(pw - 6));
  const fs = compact ? 1.8 : 2.2;

  // 底衬
  out.push(`<rect x="${round3(x0 - 1.2)}" y="${round3(y0 - (compact ? 4 : 7))}" width="${round3(len + 8)}" height="${compact ? 7 : 11}" fill="#ffffff" fill-opacity="0.82"/>`);

  // 主尺线
  out.push(`<line x1="${x0}" y1="${y0}" x2="${round3(x0 + len)}" y2="${y0}" stroke="#111111" stroke-width="0.3"/>`);
  const minorStep = compact ? 5 : (len >= 100 ? 10 : 5);
  for (let mm = 0; mm <= len; mm++) {
    let tick = 0;
    if (mm % 10 === 0) tick = compact ? 1.6 : 2.4;
    else if (mm % minorStep === 0) tick = compact ? 1 : 1.5;
    else if (!compact) tick = 0.7;
    if (tick > 0) {
      out.push(`<line x1="${round3(x0 + mm)}" y1="${y0}" x2="${round3(x0 + mm)}" y2="${round3(y0 - tick)}" stroke="#111111" stroke-width="0.2"/>`);
    }
  }
  const labelStep = compact ? (len >= 20 ? 10 : 5) : (len >= 100 ? 50 : len >= 30 ? 10 : 5);
  for (let mm = 0; mm <= len; mm += labelStep) {
    out.push(
      `<text x="${round3(x0 + mm)}" y="${round3(y0 + fs + 0.8)}" font-family="sans-serif" font-size="${fs}" ` +
        `text-anchor="middle" fill="#111111">${mm}</text>`,
    );
  }

  // 竖直尾尺（同一起点），校验两个方向的物理缩放
  if (ph >= (compact ? 10 : 16) && pw >= 12) {
    const vLen = compact ? Math.min(5, ph - 6) : 20;
    out.push(`<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${round3(y0 - vLen)}" stroke="#111111" stroke-width="0.3"/>`);
    for (let mm = 1; mm <= vLen; mm++) {
      const tick = mm % 5 === 0 ? 1.6 : 0.9;
      out.push(`<line x1="${x0}" y1="${round3(y0 - mm)}" x2="${round3(x0 + tick)}" y2="${round3(y0 - mm)}" stroke="#111111" stroke-width="0.2"/>`);
    }
    out.push(
      `<text x="${round3(x0 + 1)}" y="${round3(y0 - vLen - 0.6)}" font-family="sans-serif" font-size="${fs}" fill="#111111">mm</text>`,
    );
  } else {
    out.push(
      `<text x="${round3(x0 + len + 1)}" y="${round3(y0 - 0.6)}" font-family="sans-serif" font-size="${fs}" fill="#111111">mm</text>`,
    );
  }
}

module.exports = {
  MAX_PAGES,
  parseParams,
  planTiles,
  findPage,
  seamsForPage,
  centroid,
  clipPolygonRect,
  buildPreview,
  renderPageSvg,
};
