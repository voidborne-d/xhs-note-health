#!/usr/bin/env node
/**
 * xhs-note-health — CDP 版检测脚本
 *
 * 通过 Playwright CDP Fetch domain 拦截小红书创作者后台 API 响应，
 * 提取每篇笔记的隐藏 level 字段。
 *
 * 为什么不能直接 HTTP 请求？
 *   - 小红书 API 要求 X-S / X-T 等签名头，由前端 JS SDK 动态生成
 *   - 仅靠 cookie 请求会返回 {"code":-1,"success":false}
 *   - qiankun 微前端沙箱隔离 JS 全局变量，monkey-patch fetch/XHR 无效
 *   - Playwright 的 page.on('response') / page.route() 在 connectOverCDP 模式下不触发
 *   - 唯一可靠方案：CDP Fetch domain (requestStage: 'Response')
 *
 * 用法:
 *   node check-cdp.js [--cdp-port PORT] [--json] [--throttled-only]
 *
 * 前置条件:
 *   - Node.js + playwright 已安装
 *   - Chrome/Chromium 以 remote-debugging 启动（或通过 OpenClaw browser-lock.sh）
 *   - 已登录小红书创作者后台
 */

const { chromium } = require('playwright');

// ── 常量 ──────────────────────────────────────────────────────

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

// ── 参数解析 ──────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { cdpPort: '18800', json: false, throttledOnly: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cdp-port' && args[i + 1]) {
      opts.cdpPort = args[++i];
    } else if (args[i] === '--json') {
      opts.json = true;
    } else if (args[i] === '--throttled-only') {
      opts.throttledOnly = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`用法: node check-cdp.js [选项]

选项:
  --cdp-port PORT    CDP 端口 (默认: 18800, 或 CDP_PORT 环境变量)
  --json             JSON 格式输出
  --throttled-only   只显示限流笔记
  -h, --help         显示帮助`);
      process.exit(0);
    }
  }

  opts.cdpPort = process.env.CDP_PORT || opts.cdpPort;
  return opts;
}

// ── 主逻辑 ──────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const cdpUrl = `http://127.0.0.1:${opts.cdpPort}`;

  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (e) {
    console.error(`❌ 无法连接 CDP (${cdpUrl}): ${e.message}`);
    console.error('请确保 Chrome 以 --remote-debugging-port 启动，或使用 browser-lock.sh acquire');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page = await context.newPage();
  const client = await page.context().newCDPSession(page);

  const allNotes = [];
  let hasMore = true;
  let pagesReceived = 0;

  // CDP Fetch domain: 在 Response 阶段拦截 API 响应
  await client.send('Fetch.enable', {
    patterns: [{ urlPattern: '*note/user/posted*', requestStage: 'Response' }],
  });

  client.on('Fetch.requestPaused', async (params) => {
    try {
      const { body, base64Encoded } = await client.send('Fetch.getResponseBody', {
        requestId: params.requestId,
      });
      const text = base64Encoded
        ? Buffer.from(body, 'base64').toString('utf8')
        : body;

      const data = JSON.parse(text);
      // API 响应结构: data.notes[] (不是 data.note_list)
      // 笔记 ID 字段: id (不是 note_id)
      const noteList = data.data && (data.data.notes || data.data.note_list);
      if (noteList && noteList.length > 0) {
        for (const note of noteList) {
          const noteId = note.id || note.note_id;
          if (!allNotes.find(n => (n.id || n.note_id) === noteId)) {
            allNotes.push(note);
          }
        }
        hasMore = data.data.has_more !== false;
        pagesReceived++;
        if (!opts.json) {
          process.stderr.write(`\r[检测] 第 ${pagesReceived} 页, 累计 ${allNotes.length} 篇`);
        }
      }
    } catch (e) {
      console.error(`\n[CDP] 解析失败: ${e.message}`);
    }

    // 放行响应
    try {
      await client.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: params.responseStatusCode || 200,
        responseHeaders: params.responseHeaders || [],
        body: params.body || '',
      });
    } catch {
      try { await client.send('Fetch.continueResponse', { requestId: params.requestId }); }
      catch { try { await client.send('Fetch.continueRequest', { requestId: params.requestId }); } catch {} }
    }
  });

  // 导航到笔记管理页
  if (!opts.json) process.stderr.write('[检测] 正在打开笔记管理页...\n');
  await page.goto('https://creator.xiaohongshu.com/new/note-manager', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(10000);

  // 滚动加载更多笔记
  if (!opts.json) process.stderr.write('\n[检测] 滚动加载更多...\n');
  let stableCount = 0;
  let prevCount = allNotes.length;

  for (let i = 0; i < 25 && hasMore; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);

    if (allNotes.length > prevCount) {
      prevCount = allNotes.length;
      stableCount = 0;
    } else {
      stableCount++;
      if (stableCount >= 3) break;
    }
  }

  await page.waitForTimeout(2000);
  if (!opts.json) process.stderr.write(`\n[检测] 完成，共 ${allNotes.length} 篇笔记\n\n`);

  // 整理结果
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

  const filtered = opts.throttledOnly ? results.filter(n => n.level !== null && n.level < 0) : results;

  // 输出
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

    // 统计
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

    // 限流笔记
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

    // 正常笔记
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
