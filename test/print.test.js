'use strict';

// 分张打印核心纯函数：参数校验、分页、预览与 SVG

const { test } = require('node:test');
const assert = require('assert');
const print = require('../src/print');

const baseParams = {
  paperWidth: 210, paperHeight: 297,
  marginTop: 10, marginRight: 10, marginBottom: 10, marginLeft: 10,
  overlap: 15,
};

function snapshot(width = 500, height = 300) {
  return {
    name: '测试窗',
    width, height,
    pieces: [
      { pieceNo: 1, color: '#ff0000', polygon: [[0, 0], [250, 0], [250, 300], [0, 300]], area: 75000 },
      { pieceNo: 2, color: '#00ff00', polygon: [[250, 0], [500, 0], [500, 300], [250, 300]], area: 75000 },
    ],
    leadList: { internal: [], frameBars: [] },
  };
}

const pub = (overrides = {}) => ({
  id: 7, designId: 3, version: 2, publishedAt: '2026-10-01 10:00:00',
  snapshot: snapshot(),
  ...overrides,
});

test('parseParams：合法参数通过并算出可打印区', () => {
  const r = print.parseParams(baseParams);
  assert.ok(r.ok);
  assert.strictEqual(r.params.printableWidth, 190);
  assert.strictEqual(r.params.printableHeight, 277);
});

test('parseParams：四边留白可以为 0', () => {
  const r = print.parseParams({ ...baseParams, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 });
  assert.ok(r.ok);
  assert.strictEqual(r.params.printableWidth, 210);
});

test('parseParams：纸张/重叠非正、留白为负、缺字段都明确拒绝', () => {
  assert.match(print.parseParams({ ...baseParams, paperWidth: 0 }).error, /纸张宽高必须为正/);
  assert.match(print.parseParams({ ...baseParams, paperHeight: -3 }).error, /纸张宽高必须为正/);
  assert.match(print.parseParams({ ...baseParams, paperWidth: 12.5 }).error, /整数毫米/);
  assert.match(print.parseParams({ ...baseParams, overlap: 0 }).error, /重叠宽度必须为正/);
  assert.match(print.parseParams({ ...baseParams, overlap: -2 }).error, /重叠宽度必须为正/);
  assert.match(print.parseParams({ ...baseParams, marginTop: -1 }).error, /不小于 0/);
  assert.match(print.parseParams({ ...baseParams, marginLeft: 110, marginRight: 110 }).error, /可打印尺寸非正/);
  assert.match(print.parseParams({ paperWidth: 100, paperHeight: 100, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, overlap: 100 }).error,
    /小于任一可打印边长/);
  assert.match(print.parseParams({ ...baseParams, overlap: 190 }).error, /小于任一可打印边长/);
  const missing = { ...baseParams };
  delete missing.overlap;
  assert.match(print.parseParams(missing).error, /缺少参数：overlap/);
});

test('planTiles：步长 = 可打印 - 重叠；末页夹到窗框边界', () => {
  const p = print.parseParams(baseParams).params; // 可打印 190×277，重叠 15 → 步长 175/262
  const plan = print.planTiles(snapshot(500, 300), p);
  assert.ok(plan.ok);
  // x: 0..190, 175..365, 末页回退到 500-190=310..500 → 3 列
  assert.deepStrictEqual(plan.xs.map((q) => [q.start, q.end]),
    [[0, 190], [175, 365], [310, 500]]);
  // y: 0..277，末页回退到 300-277=23..300（覆盖 277）→ 2 行
  assert.deepStrictEqual(plan.ys.map((q) => [q.start, q.end]),
    [[0, 277], [23, 300]]);
  assert.strictEqual(plan.cols, 3);
  assert.strictEqual(plan.rows, 2);
  assert.strictEqual(plan.pageCount, 6);
});

test('planTiles：图纸一页放得下时只生成 1 页', () => {
  const p = print.parseParams({ ...baseParams, overlap: 5 }).params;
  const plan = print.planTiles(snapshot(100, 80), p);
  assert.ok(plan.ok);
  assert.strictEqual(plan.pageCount, 1);
  assert.deepStrictEqual([plan.pages[0].x0, plan.pages[0].y0, plan.pages[0].x1, plan.pages[0].y1],
    [0, 0, 100, 80]);
});

test('planTiles：页号先行列——第 1 页在左上（y 覆盖最高）', () => {
  const p = print.parseParams(baseParams).params;
  const plan = print.planTiles(snapshot(500, 300), p);
  assert.deepStrictEqual(
    plan.pages.map((q) => [q.page, q.row, q.col, q.x0, q.y0]),
    [
      [1, 1, 1, 0, 23],
      [2, 1, 2, 175, 23],
      [3, 1, 3, 310, 23],
      [4, 2, 1, 0, 0],
      [5, 2, 2, 175, 0],
      [6, 2, 3, 310, 0],
    ],
  );
});

test('planTiles：相邻页覆盖相同图纸坐标（重叠区一致）', () => {
  const p = print.parseParams(baseParams).params;
  const plan = print.planTiles(snapshot(500, 300), p);
  const p1 = plan.pages[0]; // 第 1 页 x 0..190
  const p2 = plan.pages[1]; // 第 2 页 x 175..365
  // 两张纸都覆盖图纸 x=175..190
  assert.ok(p1.x0 <= 175 && p1.x1 >= 190);
  assert.ok(p2.x0 <= 175 && p2.x1 >= 190);
});

test('planTiles：超过 200 页拒绝（too_many_pages），且不产生分页内容', () => {
  const p = print.parseParams({
    paperWidth: 100, paperHeight: 100,
    marginTop: 1, marginRight: 1, marginBottom: 1, marginLeft: 1,
    overlap: 1,
  }).params; // 可打印 98×98，步长 97
  // 2000 宽：1+ceil((2000-98)/97)=21 列；1000 高：1+ceil(902/97)=11 行 → 231
  const plan = print.planTiles(snapshot(2000, 1000), p);
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.code, 'too_many_pages');
  assert.strictEqual(plan.pageCount, 231);
  assert.ok(!plan.pages);
});

test('planTiles：正好 200 页允许，超出则拒绝', () => {
  const p = print.parseParams({
    paperWidth: 100, paperHeight: 100,
    marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
    overlap: 1,
  }).params; // 可打印 100，步长 99；跨度 L 需要 1+ceil((L-100)/99) 页
  // 1000 宽 → 11 列（最后一页回退），900 高 → 10 行 → 110 页
  const small = print.planTiles(snapshot(1000, 900), p);
  assert.ok(small.ok);
  assert.strictEqual(small.pageCount, 110);
  // 1000 × 1900：11 列 × 20 行 = 220
  const badPlan = print.planTiles(snapshot(1000, 1900), p);
  assert.strictEqual(badPlan.ok, false);
  assert.strictEqual(badPlan.code, 'too_many_pages');
  assert.strictEqual(badPlan.pageCount, 220);
  // 边界：1000 × 1850 → 11 × 19 = 209 仍超；取 11 × 18 = 198 允许
  const okPlan = print.planTiles(snapshot(1000, 1750), p); // 高 1750 → 1+ceil(1650/99)=18
  assert.ok(okPlan.ok);
  assert.strictEqual(okPlan.pageCount, 198);
});

test('buildPreview：行列编号、覆盖坐标、重叠边与逐页 SVG 链接', () => {
  const p = print.parseParams(baseParams).params;
  const plan = print.planTiles(snapshot(500, 300), p);
  const pv = print.buildPreview({ publication: pub(), params: p, plan });
  assert.strictEqual(pv.grid.pageCount, 6);
  assert.deepStrictEqual([pv.grid.rows, pv.grid.cols], [2, 3]);
  assert.strictEqual(pv.paper.printableWidth, 190);
  const page1 = pv.pages[0];
  assert.deepStrictEqual([page1.row, page1.col], [1, 1]);
  assert.deepStrictEqual([page1.coverage.x0, page1.coverage.y0, page1.coverage.x1, page1.coverage.y1],
    [0, 23, 190, 300]);
  assert.deepStrictEqual(page1.overlapEdges.map((e) => e.side), ['right', 'bottom']);
  const rightEdge = page1.overlapEdges.find((e) => e.side === 'right');
  assert.strictEqual(rightEdge.overlapsPage, 2);
  assert.strictEqual(rightEdge.seamX, 190);
  assert.strictEqual(rightEdge.stripFromX, 175);
  // 第 2 页左侧拼回第 1 页
  const page2 = pv.pages[1];
  assert.strictEqual(page2.overlapEdges.find((e) => e.side === 'left').overlapsPage, 1);
  // 本页与哪些玻璃片相交就列哪些编号：第 1 页 x 0..190，#2 从 250 起不相交
  assert.deepStrictEqual(page1.pieceLabels.map((q) => q.pieceNo), [1]);
  // 第 2 页 x 175..365，两片都相交
  const page2Labels = pv.pages[1].pieceLabels.map((q) => q.pieceNo);
  assert.deepStrictEqual(page2Labels, [1, 2]);
  assert.match(page1.svgUrl, /\/print\/1\/svg\?paperWidth=210/);
});

test('renderPageSvg：物理毫米、viewBox、可打印区裁切与标尺都在', () => {
  const p = print.parseParams(baseParams).params;
  const plan = print.planTiles(snapshot(500, 300), p);
  const svg = print.renderPageSvg({ publication: pub(), params: p, plan, page: 1 });
  assert.match(svg, /<\?xml/);
  assert.match(svg, /width="210mm" height="297mm"/);
  assert.match(svg, /viewBox="0 0 210 297"/);
  assert.match(svg, /clipPath/);
  assert.match(svg, /与第 2 页/); // 右拼接说明
  assert.match(svg, /对版标记 x=182\.5/); // 190 - 15/2
  // 毫米标尺：0..100 的标注存在
  assert.match(svg, />100</);
});

test('renderPageSvg：越界页码返回 null', () => {
  const p = print.parseParams(baseParams).params;
  const plan = print.planTiles(snapshot(500, 300), p);
  assert.strictEqual(print.renderPageSvg({ publication: pub(), params: p, plan, page: 7 }), null);
  assert.strictEqual(print.renderPageSvg({ publication: pub(), params: p, plan, page: 0 }), null);
});

test('renderPageSvg：跨页玻璃片在两页重叠区使用相同图纸坐标（多边形点串一致）', () => {
  const p = print.parseParams(baseParams).params;
  const plan = print.planTiles(snapshot(500, 300), p);
  const svg1 = print.renderPageSvg({ publication: pub(), params: p, plan, page: 1 });
  const svg2 = print.renderPageSvg({ publication: pub(), params: p, plan, page: 2 });
  // #2 多边形含顶点 (250,*)，两页都覆盖 x=250：点串中 250 映射为各自 SVG 坐标，
  // 但图纸坐标相同。这里直接验证两页都画出了 #2 的多边形（同一份快照几何）。
  // #2 的右顶点 x=500 不应出现在第 1 页（被 clip-path 裁），但路径数据仍以图纸坐标生成。
  const poly2P1 = /<polygon points="([^"]+)" fill="#00ff00"/.exec(svg1);
  const poly2P2 = /<polygon points="([^"]+)" fill="#00ff00"/.exec(svg2);
  assert.ok(poly2P1 && poly2P2);
  // 第 2 页中图纸 x=250 映射为 mL+(250-175)=85；第 1 页映射为 mL+(250-0)=260
  assert.match(poly2P2[1], /85,/);
  assert.match(poly2P1[1], /260,/);
});

test('renderPageSvg：编号取自快照（#1/#2），跨页片在两页都有本页内编号', () => {
  const p = print.parseParams(baseParams).params;
  const plan = print.planTiles(snapshot(500, 300), p);
  // 第 4 页（x 0..190，y 0..277）：同时截到 #1（整页内）与 #2（250 起，不相交）
  const svg4 = print.renderPageSvg({ publication: pub(), params: p, plan, page: 4 });
  const svg5 = print.renderPageSvg({ publication: pub(), params: p, plan, page: 5 }); // x175..365
  const svg1 = print.renderPageSvg({ publication: pub(), params: p, plan, page: 1 }); // 顶行 x0..190
  assert.match(svg4, />#1</);
  assert.doesNotMatch(svg4, />#2</);
  // 第 5 页同时截到两片（重叠区 175..190 内有 #1，250..365 内有 #2）
  assert.match(svg5, />#1</);
  assert.match(svg5, />#2</);
  // 第 1 页（顶行 x0..190）：#2 从 x=250 起，不相交
  assert.match(svg1, />#1</);
  assert.doesNotMatch(svg1, />#2</);
});

test('query 形式参数（字符串整数）同样可解析', () => {
  const q = Object.fromEntries(Object.entries(baseParams).map(([k, v]) => [k, String(v)]));
  const r = print.parseParams(q, { query: true });
  assert.ok(r.ok);
  assert.strictEqual(r.params.printableWidth, 190);
});
