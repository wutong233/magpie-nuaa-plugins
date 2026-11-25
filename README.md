# magpie-nuaa-plugins

两个 [magpie](https://magpie.im) 网关插件，修同一套上游（`token.nuaa.edu.cn`）的两个独立问题：一个在请求侧，被安全网关误拦；一个在响应侧，正常收尾后多报一条错误。

两者挂载在请求/响应的不同阶段，不共享状态，可以同时启用。

## waf-shim

**解决了什么问题现象**：上游的安全网关把 Python traceback 里的 `<module>` 判定为攻击特征，返回 HTTP 200 + `text/html` 的「访问禁止」页面。magpie 期待 JSON，拿到 HTML 就报 `answered 200 OK with a web page`。traceback 会留在对话历史里，因此一个会话只要出现过一次，之后每轮请求都会重发它，该会话持续报错。

**做法**：在请求发出前把匹配的文本替换成不会被拦的等价写法（`<module>` → `<module_>`），同时在会话里插入一条 system 说明，声明改了什么、原词是什么、改写是等价且无损的。

**边界**：没有命中时返回 `undefined`，请求原样发出；只处理对话文本字段，`model`、`tools`、`stream` 等原样透传；出现异常同样返回 `undefined`，不会让请求失败。

规则集中在一处 `DEFAULT_RULES`，增加被误拦的内容只需追加一条，详见 [waf-shim/README.md](waf-shim/README.md)。

## nuaa-responses-fix

**解决了什么问题现象**：`response.completed` 已经正常到达，上游关闭连接后 magpie 又补了一条 `responses.incomplete_stream`（`Upstream stream ended without a terminal Responses event`），客户端于是把一次已成功的回答当成失败。

**做法**：在完整收到一条合法的 `response.completed` 之后，丢弃那条特定的错误事件。判定条件是 Responses 协议、provider `nuaa`、模型 `deepseek-flash`、`response.id` 非空且 `output` 为数组、本轮未出现其它失败事件。

**边界**：任一条件不满足即放行，不掩盖真实错误。条件与已知限制见 [nuaa-responses-fix/README.md](nuaa-responses-fix/README.md)。

## 一览

| 插件 | 类型 | 挂载点 | 处理的问题 |
|---|---|---|---|
| [`waf-shim`](waf-shim/) | async gateway hook | `onRequest` | 改写被安全网关误拦的字面量，并向模型说明改写内容 |
| [`nuaa-responses-fix`](nuaa-responses-fix/) | gateway middleware | `onProvider` / `onEvent` | 在响应已正常收尾后，丢弃上游补发的错误事件 |

## 安装

```bash
git clone https://github.com/wutong233/magpie-nuaa-plugins
cd magpie-nuaa-plugins

magpie plugin add "$PWD/waf-shim/waf-shim.hooks.mjs"
magpie plugin add "$PWD/nuaa-responses-fix/nuaa-responses-fix.middleware.mjs"
magpie plugin list
```

`list` 里应出现：

```
waf-shim/waf-shim.hooks.mjs  on
  async gateway hook  onRequest
nuaa-responses-fix/nuaa-responses-fix.middleware.mjs  on
  gateway middleware  onProvider, onEvent
```

Windows 下路径用**单个反斜杠**：写双反斜杠会被当成转义，报 `no plugin "D:\\..."`。

卸载或临时关闭：

```bash
magpie plugin off <路径>
magpie plugin on  <路径>
magpie plugin rm  <路径>
```

## 适用范围

两个插件都是针对同一套上游的定向修复。上游没有这两个问题时，启用也不会影响其它流量：

- `waf-shim` 无命中即返回 `undefined`，请求不做任何修改；
- `nuaa-responses-fix` 的作用范围限定为 `responses` 协议 + provider `nuaa` + 模型 `deepseek-flash`，其它流量不经过它的判定。

两处范围都可以在各自的 README 里调整。

## 离线自测

两个插件都带离线测试，不联网、不消耗额度：

```bash
node waf-shim/waf-shim.test.mjs
node nuaa-responses-fix/nuaa-responses-fix.test.mjs
```

输出 `FAILED 0` 即通过。修改插件前先跑一遍，改完再跑一遍。

## 限制

- 都是**定向补丁**：规则与条件依据实测的失败现象确定，不是通用方案，上游行为改变后可能失效。
- `waf-shim` 的改写发生在传输层；会话记录、界面显示与模型理解以它插入的说明为准。
- 不含遥测、外部请求或凭据读写，两个插件都只在内存中处理已有的请求/响应对象。
- 未验证是否适用于其它 DNS、代理、账号或上游版本。

## License

[MIT](LICENSE)
