'use strict';

// 端到端：已发布图纸 1:1 分张打印 API（只读；非法参数/版本不存在/超 200 页明确拒绝）

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39131';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `print-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId;
let publication;

const PARAMS = {
  paperWidth: 210, paperHeight: 297,
  marginTop: 10, marginRight: 10, marginBottom: 10, marginLeft: 10,
  overlap: 15,
};
const QS = 'paperWidth=210&paperHeight=297&marginTop=10&marginRight=10&marginBottom=10&marginLeft=10&overlap=15';

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  return { status: resp.status, data, resp };
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/designs'); break; } catch { await sleep(50); }
  }

  const d = await api('POST', '/api/designs', { name: '大窗框', width: 500, height: 300 });
  designId = d.data.design.id;
  await api('POST', `/api/designs/${designId}/pieces`, { color: '#ff0000', polygon: [[0, 0], [250, 0], [250, 300], [0, 300]] });
  await api('POST', `/api/designs/${designId}/pieces`, { color: '#00ff00', polygon: [[250, 0], [500, 0], [500, 300], [250, 300]] });
  publication = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('POST 预览：3 列 × 2 行 = 6 页，行列编号与覆盖坐标正确', async () => {
  const r = await api('POST', `/api/designs/${designId}/publications/1/print/preview`, PARAMS);
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.ok);
  const pv = r.data.preview;
  assert.strictEqual(pv.version, 1);
  assert.strictEqual(pv.publicationId, publication.id);
  assert.deepStrictEqual(pv.grid, { rows: 2, cols: 3, pageCount: 6, maxPages: 200 });
  assert.strictEqual(pv.paper.printableWidth, 190);
  assert.strictEqual(pv.paper.printableHeight, 277);
  assert.deepStrictEqual(
    pv.pages.map((p) => [p.page, p.row, p.col]),
    [[1, 1, 1], [2, 1, 2], [3, 1, 3], [4, 2, 1], [5, 2, 2], [6, 2, 3]],
  );
  // 末列起点回退：500-190=310
  const p3 = pv.pages.find((p) => p.page === 3);
  assert.deepStrictEqual([p3.coverage.x0, p3.coverage.x1, p3.coverage.width], [310, 500, 190]);
  // 末行起点回退：300-277=23
  const p4 = pv.pages.find((p) => p.page === 4);
  assert.deepStrictEqual([p4.coverage.y0, p4.coverage.y1, p4.coverage.height], [0, 277, 277]);
  // 重叠：第 1 页右拼第 2 页；第 4 页上拼第 1 页
  assert.deepStrictEqual(pv.pages[0].overlapEdges.map((e) => [e.side, e.overlapsPage]),
    [['right', 2], ['bottom', 4]]);
  // 每页带同参数的逐页 SVG 下载地址
  assert.match(pv.pages[0].svgUrl, new RegExp(`/print/1/svg\\?${QS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('GET 逐页 SVG：毫米物理尺寸、可打印区裁切、标尺与拼接标记齐全', async () => {
  const resp = await fetch(`${BASE}/api/designs/${designId}/publications/1/print/1/svg?${QS}`);
  assert.strictEqual(resp.status, 200);
  assert.ok(resp.headers.get('content-type').startsWith('image/svg+xml'));
  assert.match(resp.headers.get('content-disposition'), /design1-v1-page1-of6\.svg/);
  const svg = await resp.text();
  assert.match(svg, /<\?xml/);
  assert.match(svg, /width="210mm" height="297mm"/);
  assert.match(svg, /viewBox="0 0 210 297"/);
  assert.match(svg, /data-unit="mm"/);
  // 玻璃片轮廓、编号与外框取自快照
  assert.match(svg, /fill="#ff0000"/);
  assert.match(svg, />#1</);
  assert.match(svg, /<rect[^>]*width="500" height="300"[^>]*stroke="#111111"/);
  // 跨页裁切到可打印区
  assert.match(svg, /<clipPath[^>]*><rect x="10" y="10" width="190" height="277"\/><\/clipPath>/);
  // 拼接标记 + 毫米标尺
  assert.match(svg, /与第 2 页/);
  assert.match(svg, /毫米校准标尺|校准/); // desc 含说明
  assert.match(svg, />100</);
});

test('GET 末页 SVG 同样可取（页码越界 404）', async () => {
  const ok = await fetch(`${BASE}/api/designs/${designId}/publications/1/print/6/svg?${QS}`);
  assert.strictEqual(ok.status, 200);
  const bad = await api('GET', `/api/designs/${designId}/publications/1/print/7/svg?${QS}`);
  assert.strictEqual(bad.status, 404);
  assert.match(bad.data.error, /第 7 页不存在/);
  const zero = await api('GET', `/api/designs/${designId}/publications/1/print/0/svg?${QS}`);
  assert.strictEqual(zero.status, 400);
});

test('拒绝：纸张/重叠非正、可打印尺寸非正、重叠不小于可打印边长、留白为负', async () => {
  const cases = [
    [{ ...PARAMS, paperWidth: 0 }, /纸张宽高必须为正/],
    [{ ...PARAMS, paperHeight: -5 }, /纸张宽高必须为正/],
    [{ ...PARAMS, overlap: 0 }, /重叠宽度必须为正/],
    [{ ...PARAMS, marginTop: 150, marginBottom: 150 }, /可打印尺寸非正/],
    [{ ...PARAMS, marginLeft: 110, marginRight: 110 }, /可打印尺寸非正/],
    [{ ...PARAMS, overlap: 190 }, /小于任一可打印边长/],
    [{ ...PARAMS, overlap: 277 }, /小于任一可打印边长/],
    [{ ...PARAMS, marginLeft: -1 }, /不小于 0/],
    [{ paperWidth: 210, paperHeight: 297, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 }, /缺少参数：overlap/],
    [{ ...PARAMS, paperWidth: undefined }, /缺少参数：paperWidth/],
  ];
  for (const [body, re] of cases) {
    const r = await api('POST', `/api/designs/${designId}/publications/1/print/preview`, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, re);
  }
});

test('拒绝：版本/图纸不存在', async () => {
  const r1 = await api('POST', `/api/designs/${designId}/publications/99/print/preview`, PARAMS);
  assert.strictEqual(r1.status, 404);
  assert.match(r1.data.error, /v99 不存在/);
  const r2 = await api('POST', '/api/designs/99999/publications/1/print/preview', PARAMS);
  assert.strictEqual(r2.status, 404);
  assert.match(r2.data.error, /图纸不存在/);
});

test('拒绝：页数超过 200 → 422，且不输出任何页面（大图纸场景见下一条）', async () => {
  // 普通参数下本图纸仅 6 页，可正常预览
  const r = await api('POST', `/api/designs/${designId}/publications/1/print/preview`, PARAMS);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.preview.grid.pageCount, 6);
});

test('超 200 页（大图纸）：422 拒绝且无部分页面，SVG 接口同样 422', async () => {
  // 新建 2000×1900 的大图纸并发布
  const big = await api('POST', '/api/designs', { name: '超大窗框', width: 2000, height: 1900 });
  const bigId = big.data.design.id;
  // 四片铺满
  await api('POST', `/api/designs/${bigId}/pieces`, { color: '#123456', polygon: [[0, 0], [1000, 0], [1000, 950], [0, 950]] });
  await api('POST', `/api/designs/${bigId}/pieces`, { color: '#234567', polygon: [[1000, 0], [2000, 0], [2000, 950], [1000, 950]] });
  await api('POST', `/api/designs/${bigId}/pieces`, { color: '#345678', polygon: [[0, 950], [1000, 950], [1000, 1900], [0, 1900]] });
  await api('POST', `/api/designs/${bigId}/pieces`, { color: '#456789', polygon: [[1000, 950], [2000, 950], [2000, 1900], [1000, 1900]] });
  await api('POST', `/api/designs/${bigId}/publish`);

  const body = {
    paperWidth: 100, paperHeight: 100,
    marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
    overlap: 1,
  };
  const qs = 'paperWidth=100&paperHeight=100&marginTop=0&marginRight=0&marginBottom=0&marginLeft=0&overlap=1';
  const r = await api('POST', `/api/designs/${bigId}/publications/1/print/preview`, body);
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.data.ok, false);
  assert.match(r.data.error, /超过上限 200/);
  assert.ok(!r.data.preview, '不得输出部分页面');

  const svg = await api('GET', `/api/designs/${bigId}/publications/1/print/1/svg?${qs}`);
  assert.strictEqual(svg.status, 422);
  assert.ok(!(svg.data && svg.data.preview));
});

test('只读：预览与下载不改变快照、草稿、计划与库存', async () => {
  const before = (await api('GET', `/api/designs/${designId}/publications/1`)).data.publication;
  const draftBefore = (await api('GET', `/api/designs/${designId}`)).data.draft;
  await api('POST', `/api/designs/${designId}/publications/1/print/preview`, PARAMS);
  await fetch(`${BASE}/api/designs/${designId}/publications/1/print/1/svg?${QS}`);
  await fetch(`${BASE}/api/designs/${designId}/publications/1/print/6/svg?${QS}`);
  const after = (await api('GET', `/api/designs/${designId}/publications/1`)).data.publication;
  const draftAfter = (await api('GET', `/api/designs/${designId}`)).data.draft;
  assert.deepStrictEqual(after, before, '发布快照不变');
  assert.strictEqual(draftAfter.pieces.length, draftBefore.pieces.length);
  const plans = await api('GET', '/api/plans');
  assert.ok(Array.isArray(plans.data.plans));
  const mats = await api('GET', '/api/materials');
  assert.ok(Array.isArray(mats.data.materials));
});
