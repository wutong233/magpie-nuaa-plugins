# waf-shim

magpie 网关插件（async gateway hook）。在请求发往上游之前，把会被安全网关误拦的字面量替换成不会被拦的等价写法，同时在会话里插入一条说明，让模型知道"这里被改过、改成什么、原意是什么"。

## 问题

上游 `token.nuaa.edu.cn` 前面的安全网关把 **`<module>`** 当成攻击特征，直接返回一张写着「访问禁止」的 HTML 页面，HTTP 状态却是 200。magpie 期待 JSON，拿到 HTML，于是报：

```
server_error: NUAA: answered 200 OK with a web page (text/html), not an API reply:
"访问禁止" (HTTP 502, bad_gateway)
```

麻烦在于它会**污染会话**。Python 报错时 traceback 里必然出现

```
  File "<string>", line 1, in <module>
```

这一行一旦进了对话历史，之后每轮请求都会把它重新发出去，于是**该会话永久报错**，只有新开会话才正常。

实测（同一份 432 KB 请求体，只改这一个词）：

| 请求体内容 | 上游响应 |
|---|---|
| 原样含 `<module>` | 200 + `text/html`「访问禁止」 |
| 改成 `<module_>` | 200 + 正常 JSON |

其它尖括号写法（`<string>`、`<div>`、`<script>`、`<foo>`、`a < b > c`）都不被拦，签名非常具体。

## 它做什么

1. **改写**：所有匹配规则的文本替换成不会被拦的写法（默认 `<module>` → `<module_>`）。
2. **告知**：如果这次请求确实改过东西，在对话里插入一条 system 说明：

```
[magpie waf-shim] The upstream security gateway rewrites a few harmless literals
in this request. Read "<module_>" for the word "module" wrapped in angle brackets
(the Python traceback frame marker). The rewrite is literal and lossless: the
replacement means exactly the original token, and nothing else in this request
was altered.
```

这样模型不会把 `<module_>` 当成用户真写的内容，需要复述时也知道该还原成什么。

改写是**无损的、可逆的**：它只发生在传输层。

## 安装

```bash
magpie plugin add /绝对路径/waf-shim/waf-shim.hooks.mjs
magpie plugin list      # 应显示  async gateway hook  onRequest
```

改完文件需要让 magpie 重新加载插件。

## 扩展：再加一条规则

所有规则都在文件顶部的 `DEFAULT_RULES` 里。加一条 = 加一个对象，**其它代码一行都不用动**。

```js
const DEFAULT_RULES = [
  {
    id: 'python-module-frame',
    match: LT + 'module' + GT,        // <module>
    flags: 'gi',
    replace: LT + 'module_' + GT,     // <module_>
    legend: 'the word "module" wrapped in angle brackets (the Python traceback frame marker)',
  },
  {
    id: 'my-new-rule',                // 稳定名，出现在日志与 ctx.report 里
    match: '被拦截的字面量',            // 正则**源串**（字符串），不是 RegExp 对象
    flags: 'gi',                      // 默认 'gi'
    replace: '替换后的写法',            // 模型最终看到的内容
    legend: '怎么向模型描述原文',        // 见下方注意事项
  },
];
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 建议 | 稳定标识，缺省取 `match` |
| `match` | 是 | 正则**字符串**。空串的规则会被忽略 |
| `flags` | 否 | 默认 `'gi'`。**必须带 `g`**，否则只替换第一处 |
| `replace` | 是 | 替换文本；`$1`、`$&` 会被 `String.replace` 解释 |
| `legend` | 否 | 给模型看的「原文是什么」，缺省用 `replace` |

### 四条硬约束

1. **`legend` 不能包含被屏蔽的字面量本身**，否则说明文字自己也会被拦。
   代码里有 `clean` 守卫：提示文本一旦命中任一规则，整条提示不注入（改写照做）。
2. **`replace` 不能再次命中任何规则**，否则会反复替换。
3. **替换结果要「像原文」**：优先挑只差一两个字符的写法（如 `<module>` → `<module_>`），模型最不容易误解。
4. **不要引入会被 JSON / HTTP 层误解的字符**：引号、反斜杠、控制字符别用。

`LT` / `GT` 用 `String.fromCharCode` 拼出尖括号，是为了让这个字面量不出现在源码里——这样即使整个插件文件被读取并重新发给上游，也不会触发同一个规则。

### 怎么找新的被屏蔽字面量

客户端报「访问禁止」时用二分法：把请求体切成两半分别重放，看哪一半触发；对那一半继续二分，定位到具体几字节后补一条规则。

## 选项

不用改代码就能覆盖行为：

```bash
magpie plugin options /绝对路径/waf-shim/waf-shim.hooks.mjs '<json>'
```

| 选项 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `rules` | 数组 | 空 | 给定时**整体替换** `DEFAULT_RULES` |
| `notice` | 布尔 | `true` | `false` 表示只改写、不插入说明 |
| `providers` | 字符串数组 | 全部 | 只对列出的 provider id 生效 |

例：只对 nuaa 生效并静默改写 —— `{"providers": ["nuaa"], "notice": false}`

## 它不碰什么

- `model`、`stream`、`tools`、`tool_choice`、`functions`、`toolConfig` 原样传递（magpie 禁止 hook 修改这些字段）。
- 只改这些文本字段：`instructions`、`input`、`messages`、`content`、`text`、`output`、`arguments`、`reasoning`、`summary`。其余字段整棵子树不动。
- 没有命中时返回 `undefined`，请求原封不动。
- 任何异常都被吞掉并返回 `undefined`：插件不会把正常请求搞挂。

### 提示为什么插在 `input` 里

实测上游**忽略**顶层 `instructions`（它用自己的默认系统提示词回答），但**认** `input` 数组里 `{role: 'system', content}` 这一项。所以提示作为 `input` 第一项插入：

- `input` 是数组 → 前插一条 system
- `input` 是字符串 → 包装成 `[system, user]`
- 只有 `messages`（Chat 形态）→ 前插一条 system
- 都没有 → 退回到 `instructions`

## 自测

```bash
node waf-shim.test.mjs
```

覆盖：改写、提示注入位置、`tools`/`stream` 不被改动、`notice:false`、自定义规则、`providers` 限定、空输入与数组输入、content 数组形态。
