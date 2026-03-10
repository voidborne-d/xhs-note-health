# xhs-note-health 📊

> 小红书笔记限流状态检测 — OpenClaw Agent Skill

让 AI agent 直接检测小红书创作者后台所有笔记的限流状态，无需浏览器扩展。

## 工作原理

小红书创作者后台 API 返回的每篇笔记包含一个 `level` 字段，表示推荐分发等级（社区逆向工程，非官方）：

| Level | 状态 | 说明 |
|-------|------|------|
| 4 🟢 | 正常推荐 | 笔记正常分发 |
| 2 🟡 | 基本正常 | 轻微受限 |
| 1 ⚪ | 新帖初始 | 刚发布，等待审核 |
| -1 🔴 | 轻度限流 | 推荐量明显下降 |
| -5 🔴🔴 | 中度限流 | 几乎无推荐 |
| -102 ⛔ | 严重限流 | 不可逆，需删除重发 |

## 两种检测方式

### 方式一：CDP 浏览器拦截（推荐）✅

通过 Playwright CDP Fetch domain 拦截浏览器内的 API 响应，绕过签名验证。

**优点**: 无需导出 cookies，无需处理 X-S 签名，100% 可靠
**前置条件**: Node.js + `playwright`，Chrome 以 remote-debugging 启动

```bash
# 通过 OpenClaw browser-lock.sh
./scripts/browser-lock.sh run check-cdp.js

# 或直接运行（需自行管理 Chrome CDP）
node check-cdp.js --cdp-port 9222

# JSON 输出
node check-cdp.js --json

# 只看限流笔记
node check-cdp.js --throttled-only
```

### 方式二：Cookie + HTTP 请求

直接用 Python requests 调用 API。**注意：XHS API 需要 X-S/X-T 签名头，纯 cookie 请求大概率返回 `{"code":-1}`**。此方式仅在 XHS 未严格校验签名时可用。

**前置条件**: Python 3 + `requests`，有效的 cookies JSON 文件

```bash
python3 check.py --cookies /path/to/cookies.json
python3 check.py --throttled-only
python3 check.py --json
```

## 功能

- **📊 全量检测** — 分页获取所有笔记，逐一检测 level 状态
- **⚠️ 敏感词检测** — 50+ 内置高危词（AI自动化、极限词、引流词等）（Python 版）
- **📛 标签风险** — 话题标签 >5 个自动提示（Python 版）
- **📋 Markdown 报告** — 按限流等级分组，一目了然
- **🤖 JSON 输出** — 适合 agent 程序化处理

## 安装

```bash
# 通过 ClawHub
clawhub install xhs-note-health

# 或手动
cp -r xhs-note-health ~/.openclaw/workspace/skills/
cd xhs-note-health && npm install playwright  # CDP 版
```

## 技术细节

### 为什么需要 CDP 方式？

小红书创作者后台使用了多层防护：

1. **X-S 签名头** — API 请求需要 `X-S`、`X-T` 等由前端 JS SDK 动态生成的签名头，仅靠 cookie 无法通过验证
2. **qiankun 微前端沙箱** — 创作者后台使用 qiankun 框架，全局 `fetch`/`XMLHttpRequest` 被沙箱隔离，无法通过 monkey-patch 拦截
3. **Playwright 限制** — 在 `connectOverCDP` 模式下，`page.on('response')` 和 `page.route()` 不会触发

**CDP Fetch domain** 工作在浏览器网络层，绕过所有 JS 层面的限制：

```
浏览器网络层 (CDP Fetch domain) ← 我们在这里拦截
    ↓
qiankun 沙箱 (隔离 JS 全局变量)
    ↓
微应用 fetch/XHR (带 X-S 签名)
    ↓
XHS API 服务器
```

### API 响应结构

```
endpoint: /api/galaxy/v2/creator/note/user/posted?tab=0&page=0
response.data.notes[]   ← 注意是 "notes" 不是 "note_list"
  .id                   ← 注意是 "id" 不是 "note_id"
  .level                ← 隐藏的推荐等级
  .display_title
  .likes
  .time
```

### CDP 拦截关键代码

```javascript
// 1. 启用 Fetch domain（Response 阶段拦截）
await client.send('Fetch.enable', {
  patterns: [{ urlPattern: '*note/user/posted*', requestStage: 'Response' }],
});

// 2. 监听 requestPaused 事件
client.on('Fetch.requestPaused', async (params) => {
  // 获取响应 body
  const { body, base64Encoded } = await client.send('Fetch.getResponseBody', {
    requestId: params.requestId,
  });
  // 解析 level 字段...

  // 放行响应（必须用 fulfillRequest，不是 continueRequest）
  await client.send('Fetch.fulfillRequest', {
    requestId: params.requestId,
    responseCode: params.responseStatusCode,
    responseHeaders: params.responseHeaders,
    body: params.body,
  });
});
```

> ⚠️ Response 阶段必须用 `Fetch.fulfillRequest` 放行，`Fetch.continueRequest` 仅适用于 Request 阶段。

## 致谢

- 限流检测原理参考 [jzOcb/xhs-note-health-checker](https://github.com/jzOcb/xhs-note-health-checker)（Chrome 扩展版）
- 隐藏 level 字段发现来源: [@xxx111god](https://x.com/xxx111god/status/2030837261516845106)

## License

MIT
