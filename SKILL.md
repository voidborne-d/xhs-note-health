---
name: xhs-note-health
version: "1.1.0"
description: "检测小红书笔记限流状态。通过 CDP Fetch domain 拦截创作者后台 API，获取隐藏的 level 字段判断推荐等级。"
author: "d (voidborne)"
---

# 小红书笔记健康检测 (xhs-note-health)

检测小红书创作者后台所有笔记的限流状态，无需浏览器扩展。

## 原理

小红书创作者后台 API `/api/galaxy/v2/creator/note/user/posted` 返回的每篇笔记包含隐藏的 `level` 字段，表示推荐分发等级：

| Level | 状态 | 说明 |
|-------|------|------|
| 4 🟢 | 正常推荐 | 笔记正常分发 |
| 2 🟡 | 基本正常 | 轻微受限 |
| 1 ⚪ | 新帖初始 | 刚发布，等待审核 |
| -1 🔴 | 轻度限流 | 推荐量明显下降 |
| -5 🔴🔴 | 中度限流 | 几乎无推荐 |
| -102 ⛔ | 严重限流 | 不可逆，需删除重发 |

## 两种检测方式

### 方式一：CDP 浏览器拦截（推荐）

通过 Playwright CDP Fetch domain 在 Response 阶段拦截 API 响应，绕过 X-S 签名验证和 qiankun 沙箱。

**前置条件:**
- Node.js + `playwright`
- Chrome 以 remote-debugging 启动（或 OpenClaw 管理的浏览器）
- 已登录小红书创作者后台

```bash
# OpenClaw 环境
./scripts/browser-lock.sh run <skill_dir>/check-cdp.js

# 手动指定 CDP 端口
node <skill_dir>/check-cdp.js --cdp-port 9222

# JSON 输出
node <skill_dir>/check-cdp.js --json

# 只看限流笔记
node <skill_dir>/check-cdp.js --throttled-only
```

### 方式二：Cookie + HTTP 请求（不推荐）

直接用 Python requests 调用 API。XHS API 通常需要 X-S/X-T 签名头，此方式仅在签名未严格校验时可用。

**前置条件:**
- Python 3 + `requests`
- Cookies JSON 文件（从浏览器导出）

```bash
python3 <skill_dir>/check.py --cookies /path/to/cookies.json
python3 <skill_dir>/check.py --json
python3 <skill_dir>/check.py --throttled-only
```

## Agent 使用指南

当用户要求检测小红书笔记限流状态时：

1. **优先使用 CDP 版** (`check-cdp.js`)，需要浏览器可用
2. 如果浏览器不可用，退回 Python 版 (`check.py`)，提醒用户可能因签名失败
3. 汇总报告：总笔记数、各 level 分布、限流笔记列表
4. 对限流笔记给出建议（删除重发 / 检查内容 / 等待）

### 技术要点

- **API 响应结构**: `data.notes[]`（不是 `data.note_list`）
- **笔记 ID 字段**: `id`（不是 `note_id`）
- **CDP 拦截**: 必须用 `Fetch.enable` + `requestStage: 'Response'` + `Fetch.fulfillRequest` 放行
- **不可行方案**: JS monkey-patch（qiankun 沙箱隔离）、page.route()（CDP 连接模式不触发）、直接 fetch（缺签名头）

## 敏感词检测（Python 版）

内置 50+ 高危敏感词，覆盖：AI/自动化、极限词、虚假承诺、医疗功效夸大、站外引流、诱导互动、营销限时词。

## 致谢

- 限流检测原理参考 [jzOcb/xhs-note-health-checker](https://github.com/jzOcb/xhs-note-health-checker)
- 隐藏 level 字段发现: [@xxx111god](https://x.com/xxx111god/status/2030837261516845106)
