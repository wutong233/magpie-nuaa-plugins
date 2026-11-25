# nuaa-responses-fix

magpie 网关中间件（gateway middleware，进程内）。在 Responses 流**已经正常收尾**之后，吞掉上游多出来的一条「流中断」错误，避免客户端把一次成功的回答当成失败。

## 问题

回答其实已经完整显示出来了，但会话末尾仍报错：

```
server_error: NUAA: Upstream stream ended without a terminal Responses event
        (responses.incomplete_stream)
```

或者客户端把它显示成「生成失败」「重试」—— 但内容明明已经在屏幕上。

## 原因

Responses 协议的正常收尾是最后一条 `response.completed`（`status` 为 `completed`，带完整 `output`）。

magpie 在这个状态之后仍会等连接安静下来。这条链路上，有时 `response.completed` 之后还会再冒出一条

```json
{"type":"error","error":{"code":"responses.incomplete_stream",
 "message":"Upstream stream ended without a terminal Responses event"}}
```

也就是说：**终止事件其实收到了**，但上游的连接关闭方式让 magpie 又补了一条「我没收到终止事件」。这条错误既不符合事实，也会覆盖掉已经成功的回答。

## 它做什么

### `onProvider(body, ctx)` —— 请求开始时

判断是否在管辖范围内，把三个状态位挂到 `ctx.state`：

```js
ctx.state.active = ctx.protocol === 'responses' && ctx.provider.id === 'nuaa'
  && ctx.provider.model === 'deepseek-flash';
ctx.state.completed = false;
ctx.state.failed = false;
```

三个条件缺一不可：**Responses 协议** + **provider `nuaa`** + **模型 `deepseek-flash`**。不在范围内，后续逻辑全部跳过。

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

## 调整适用范围

作用范围写死在 `onProvider` 第一行。三种常见改法：

```js
// 去掉模型限制，只认 provider
ctx.state.active = ctx.protocol === 'responses' && ctx.provider.id === 'nuaa';

// 所有 Responses 流量
ctx.state.active = ctx.protocol === 'responses';
```

如果上游偶尔改用别的收尾报错，可以把规则 2 的 `code` 判断放宽——但**不要**把 `message` 判断完全去掉（见上文）。

## 自测

```bash
node nuaa-responses-fix.test.mjs
```

39 项，覆盖：三个生效条件、`response.completed` 的五种不合法形态、精确匹配下吞掉收尾错误、错误码/消息不符时放行、未完成时放行、失败后不再采信 completion、每次请求重置状态，以及上面那条已知边界。
