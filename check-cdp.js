#!/usr/bin/env node
/**
 * xhs-note-health — CDP 版检测脚本
 *
 * 通过 CDP Fetch domain 拦截第一页 API 响应 + 捕获请求 headers，
 * 然后用 Node.js HTTP 直接请求后续分页（复用 cookies，每页重新签名由浏览器完成）。
 *
 * 分页策略：用 CDP 拦截首页，然后通过 page.evaluate 调用浏览器内部
 * 的 fetch（经过 qiankun 沙箱的签名中间件）获取后续页。
 */

const { chromium } = require('playwright');

function getCdpUrl() {
  const port = process.env.CDP_PORT || '18800';
  return `http://127.0.0.1:${port}`;
}

// ── Level 标签 ───────────────────────────────────────────────

const LEVEL_META = {
  4:    ['🟢 正常推荐', '笔记正常分发'],
  2:    ['🟡 基本正常', '轻微受限'],
  1:    ['⚪ 新帖初始', '刚发布，等待审核'],
  0:    ['⚪ 未知', '状态不明'],
  '-1': ['🔴 轻度限流', '推荐量明显下降'],
  '-5': ['🔴🔴 中度限流', '几乎无推荐'],
  '-102': ['⛔ 严重限流', '不可逆，需删除重发'],
};

function getLevelLabel(level) {
  if (level === undefined || level === null) return ['❓ 未知', '未返回 level 字段'];
  const key = String(level);
  if (LEVEL_META[key]) return LEVEL_META[key];
  if (level >= 4) return ['🟢 正常推荐', '笔记正常分发'];
  if (level >= 2) return [`🟡 L${level}`, '基本正常'];
  if (level <= -102) return ['⛔ 严重限流', '不可逆，需删除重发'];
  if (level <= -5) return [`🔴🔴 L${level}`, '中度限流'];
  if (level < 0) return [`🔴 L${level}`, '限流'];
  return [`L${level}`, '未知状态'];
}

// ── 参数解析 ─────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { cdpPort: '18800', json: false, throttledOnly: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cdp-port' && args[i + 1]) opts.cdpPort = args[++i];
    else if (args[i] === '--json') opts.json = true;
    else if (args[i] === '--throttled-only') opts.throttledOnly = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('用法: node check-cdp.js [--cdp-port PORT] [--json] [--throttled-only]');
      process.exit(0);
    }
  }
  opts.cdpPort = process.env.CDP_PORT || opts.cdpPort;
  return opts;
}

// ── 主逻辑 ───────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const cdpUrl = `http://127.0.0.1:${opts.cdpPort}`;

  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (e) {
    console.error(`❌ 无法连接 CDP (${cdpUrl}): ${e.message}`);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page = await context.newPage();
  const client = await page.context().newCDPSession(page);

  const allNotes = [];
  let firstPageHasMore = true;

  // ── 步骤1: CDP Fetch 拦截第一页 ──────────────────────────

  await client.send('Fetch.enable', {
    patterns: [{ urlPattern: '*note/user/posted*', requestStage: 'Response' }],
  });

  client.on('Fetch.requestPaused', async (params) => {
    let rawBody = '';
    let responseCode = params.responseStatusCode || 200;
    let responseHeaders = params.responseHeaders || [];

    try {
      const resp = await client.send('Fetch.getResponseBody', {
        requestId: params.requestId,
      });
      // 保留原始 base64 body 用于回传
      rawBody = resp.body;
      const text = resp.base64Encoded
        ? Buffer.from(resp.body, 'base64').toString('utf8')
        : resp.body;
      const data = JSON.parse(text);
      const noteList = data.data && (data.data.notes || data.data.note_list);
      if (noteList && noteList.length > 0) {
        for (const note of noteList) {
          const nid = note.id || note.note_id;
          if (!allNotes.find(n => (n.id || n.note_id) === nid)) {
            allNotes.push(note);
          }
        }
        const totalCount = (data.data.tags && data.data.tags[0] && data.data.tags[0].notes_count) || 0;
        firstPageHasMore = allNotes.length < totalCount;
        if (!opts.json) process.stderr.write(`[CDP] 总数: ${totalCount}, 已获取: ${allNotes.length}\n`);
      }
    } catch (e) {
      console.error(`[CDP] 解析失败: ${e.message}`);
    }

    // 关键: 必须把真实的响应 body 回传给页面，否则页面收到空响应
    try {
      await client.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode,
        responseHeaders,
        body: rawBody,  // 原始 base64 编码的响应体
      });
    } catch {
      try { await client.send('Fetch.continueResponse', { requestId: params.requestId }); } catch {}
    }
  });

  if (!opts.json) process.stderr.write('[检测] 正在打开笔记管理页...\n');
  await page.goto('https://creator.xiaohongshu.com/new/note-manager', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(10000);

  if (!opts.json) process.stderr.write(`[检测] 第1页: ${allNotes.length} 篇, has_more: ${firstPageHasMore}\n`);

  // ── 步骤2: 保持 Fetch 拦截，用 CDP Input 滚轮事件触发分页加载 ──
  // XHR/fetch 从主 frame 调用缺少 X-S 签名头，只能让页面自己发请求
  // qiankun 微应用用 IntersectionObserver 监听加载指示器
  // 需要用 CDP Input.dispatchMouseEvent(mouseWheel) 触发真实滚动

  if (firstPageHasMore) {
    if (!opts.json) process.stderr.write('[检测] 通过 CDP 滚轮事件加载更多...\n');

    // 获取 div.content 的位置信息
    const contentBox = await page.evaluate(() => {
      const c = document.querySelector('div.content');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    });

    const scrollX = contentBox ? Math.round(contentBox.x) : 640;
    const scrollY = contentBox ? Math.round(contentBox.y) : 400;

    let stableCount = 0;
    let prevCount = allNotes.length;

    for (let i = 0; i < 50; i++) {
      // 派发真实鼠标滚轮事件
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: scrollX,
        y: scrollY,
        deltaX: 0,
        deltaY: 600,
      });

      await page.waitForTimeout(2000);

      if (allNotes.length > prevCount) {
        if (!opts.json) process.stderr.write(`\r[检测] 累计 ${allNotes.length} / ~41 篇`);
        prevCount = allNotes.length;
        stableCount = 0;
      } else {
        stableCount++;
        if (stableCount >= 5) break;
      }
    }
    if (!opts.json) process.stderr.write('\n');
  }

  if (!opts.json) process.stderr.write(`\n[检测] 完成，共 ${allNotes.length} 篇笔记\n\n`);

  // ── 输出 ───────────────────────────────────────────────────

  const results = allNotes.map(n => {
    const level = n.level !== undefined ? n.level : null;
    const [label, desc] = getLevelLabel(level);
    return {
      note_id: n.id || n.note_id || '',
      title: n.display_title || n.title || n.name || '(无标题)',
      level,
      level_label: label,
      level_desc: desc,
      likes: n.likes || 0,
      time: n.time || n.create_time || '',
    };
  });

  const filtered = opts.throttledOnly
    ? results.filter(n => n.level !== null && n.level < 0)
    : results;

  if (opts.json) {
    const levelDist = {};
    for (const n of results) {
      const lv = n.level === null ? 'unknown' : n.level;
      levelDist[lv] = (levelDist[lv] || 0) + 1;
    }
    console.log(JSON.stringify({
      total: results.length,
      checked_at: new Date().toISOString(),
      method: 'cdp-fetch',
      summary: {
        level_distribution: levelDist,
        throttled_count: results.filter(n => n.level !== null && n.level < 0).length,
      },
      notes: filtered,
    }, null, 2));
  } else {
    console.log('═'.repeat(60));
    console.log(`📊 小红书笔记健康报告  (${new Date().toLocaleString('zh-CN')})`);
    console.log(`   总笔记数: ${results.length}`);
    console.log('═'.repeat(60));

    const stats = {};
    for (const n of results) {
      const lv = n.level === null ? 'unknown' : n.level;
      stats[lv] = (stats[lv] || 0) + 1;
    }
    console.log('\n📈 Level 分布:');
    for (const lv of Object.keys(stats).sort((a, b) => Number(b) - Number(a))) {
      const [label] = getLevelLabel(lv === 'unknown' ? null : Number(lv));
      console.log(`   L${lv} ${label}: ${stats[lv]} 篇`);
    }

    const throttled = results.filter(n => n.level !== null && n.level < 0);
    if (throttled.length > 0) {
      console.log(`\n⚠️  限流笔记 (${throttled.length} 篇):`);
      console.log('-'.repeat(60));
      for (const n of throttled.sort((a, b) => a.level - b.level)) {
        console.log(`   ${n.level_label} | ${n.title}`);
        console.log(`   ID: ${n.note_id} | ${n.level_desc}`);
      }
    } else {
      console.log('\n✅ 无限流笔记');
    }

    if (!opts.throttledOnly) {
      const normal = results.filter(n => n.level === null || n.level >= 0);
      if (normal.length > 0) {
        console.log(`\n📋 正常笔记 (${normal.length} 篇):`);
        console.log('-'.repeat(60));
        for (const n of normal.sort((a, b) => (b.level || 0) - (a.level || 0))) {
          console.log(`   ${n.level_label} | ${n.title} | 赞: ${n.likes}`);
        }
      }
    }
    console.log('\n' + '═'.repeat(60));
  }

  await page.close();
  process.exit(0);
}

main().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
