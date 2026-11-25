# nuaa-responses-fix

magpie 网关中间件（gateway middleware，进程内）。在 Responses 流**已经正常收尾**之后，吞掉上游多出来的一条「流中断」错误，避免客户端把一次成功的回答当成失败。

对**所有供应商、所有模型**生效，不限定 NUAA。

---

## 解决了什么问题现象

回答其实已经完整显示出来了，但会话末尾仍报错：

```
server_error: Upstream stream ended without a terminal Responses event
        (responses.incomplete_stream)
```

或者客户端把它显示成「生成失败」「重试」—— 但内容明明已经在屏幕上。

## 原因

Responses 协议的正常收尾是最后一条 `response.completed`（`status` 为 `completed`，带完整 `output`）。

magpie 在这个状态之后仍会等连接安静下来。有些上游关闭连接的方式会让 magpie 判断失误，于是在 `response.completed` 之后又补一条

```json
{"type":"error","error":{"code":"responses.incomplete_stream",
 "message":"Upstream stream ended without a terminal Responses event"}}
```

也就是说：**终止事件其实收到了**，但这条例外的错误既不符合事实，也会覆盖掉已经成功的回答。

## 它做什么

### `onProvider(body, ctx)` —— 请求开始时

只看协议，不看供应商和模型：

```js
ctx.state.active = ctx.protocol === 'responses';
ctx.state.completed = false;
ctx.state.failed = false;
```

要修的毛病是 Responses 协议的产物，跟哪家供应商、哪个模型无关，所以判定只保留协议这一条。请求里没有 `ctx.provider` 也能正常工作。

### `onEvent(event, ctx)` —— 收到流事件时

| # | 条件 | 动作 |
|---|---|---|
| 1 | `type === 'response.completed'` 且 `response.status === 'completed'`、`response.id` 是非空字符串、`response.output` 是数组、且此前没失败过 | 置 `completed = true`，事件**放行** |
| 2 | 已 `completed`，且 `type === 'error'`、`code === 'responses.incomplete_stream'`、消息正是 `Upstream stream ended without a terminal Responses event` | **返回 `null`：丢弃这条事件** |
| 3 | `type` 是 `error` / `response.failed` / `response.incomplete` | 置 `failed = true`，作为规则 1 的闸门 |

返回值语义：`null` → 丢弃；`undefined` → 原样放行。

## 为什么条件写得这么窄

这条修正本质上是「在上游报错时相信我们自己的判断」。放宽条件就会开始**掩盖真实的失败**：

- 不限 `code` 和 `message`，真正的流中断也会被吞，客户端拿到半截回答却以为成功。
- 不要求 `response.id` 非空、`output` 是数组，`status: completed` 可能只是个空壳。
- `failed` 是规则 1 的闸门：这一轮只要有任一失败事件，后面再来的 `response.completed` 就不算数。否则一次出错的半截响应也会被当成「完整回答」，然后连真错误一起吞掉。

三条规则合起来的意思是：**手上已经有一份完整、可用的回答，而且这一轮从没出过错，那么这条「没收到终止事件」的抱怨只能是噪音。**

### 已知边界

`completed` 一旦被采信，**之后再出现什么失败事件都不会撤回它**——`failed` 只挡规则 1，没挡规则 2。也就是 `completed → response.failed → 噪音` 这个序列里，噪音仍会被吞。

实际链路上 `response.completed` 之后不该再出现 `response.failed`，所以按现状够用；自测里有专门用例把这个现状钉住（标 `LIMITATION`）。

要更严格，在规则 2 的条件里补上 `!ctx.state.failed`：

```js
if (ctx.state.completed && !ctx.state.failed
    && event.type === 'error' && event.error
    && event.error.code === 'responses.incomplete_stream'
    && event.error.message === 'Upstream stream ended without a terminal Responses event') {
  return null;
}
```

## 安装

```bash
magpie plugin add /绝对路径/nuaa-responses-fix/nuaa-responses-fix.middleware.mjs
magpie plugin list      # 应显示  gateway middleware  onProvider, onEvent
```

改完文件需要让 magpie 重新加载插件。

## 判定范围

默认对**所有供应商、所有模型**生效，条件只有一条：请求走 Responses 协议。Chat Completions 等其它协议完全不经过它。

要收窄的话，改 `onProvider` 第一行：

```js
// 只认某个供应商
ctx.state.active = ctx.protocol === 'responses' && ctx.provider?.id === 'nuaa';

// 再叠加某个模型
ctx.state.active = ctx.protocol === 'responses'
  && ctx.provider?.id === 'nuaa' && ctx.provider?.model === 'deepseek-flash';
```

如果上游偶尔改用别的收尾报错，可以把规则 2 的 `code` 判断放宽——但**不要**把 `message` 判断完全去掉（见上文）。

## 和 waf-shim.hooks.mjs 的关系

两者是 magpie 的**两种不同插件**，处在不同阶段，互不影响：

| | `waf-shim.hooks.mjs` | `nuaa-responses-fix.middleware.mjs`（本插件） |
|---|---|---|
| 类型 | async gateway hook | gateway middleware（进程内） |
| 入口 | `onRequest` | `onProvider` / `onEvent` |
| 时机 | 请求发出**前** | 响应流处理**时** |
| 作用 | 改写字面量 + 插入提示 | 吞掉误报的收尾错误 |

一个管**请求出去**，一个管**响应回来**；不共享状态，可以同时开启。

## 离线自测

不联网、不消耗额度：

```bash
node nuaa-responses-fix.test.mjs
```

输出 `FAILED 0` 即通过（当前 43 项）。覆盖：协议判定（含无 `ctx.provider`、未知供应商、非 Responses 协议）、`response.completed` 的五种不合法形态、精确匹配下吞掉收尾错误、错误码/消息不符时放行、未完成时放行、失败后不再采信 completion、每次请求重置状态，以及上面那条已知边界。

## 排错

| 现象 | 处理 |
|---|---|
| 该吞的没吞 | 先确认 `ctx.protocol` 真是 `responses`；不是就完全不生效。再看这一轮是否真的收到过合法的 `response.completed` |
| 吞过头了（真错误也没了） | 有人放宽了规则 2 的条件；恢复成精确匹配 |
| `plugin list` 里没有 | 路径写错，或用了双反斜杠 |
| 有但显示 `off` | `magpie plugin on <路径>` |
| 改了代码没效果 | 没重载；`list` 只反映注册状态，不反映文件内容 |

## 文件清单

| 文件 | 作用 |
|---|---|
| `nuaa-responses-fix.middleware.mjs` | 插件本体，magpie 唯一加载的文件 |
| `nuaa-responses-fix.test.mjs` | 离线回归测试，改条件后跑 |
| `README.md` | 本手册 |
