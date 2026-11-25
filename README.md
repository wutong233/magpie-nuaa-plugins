# magpie-nuaa-plugins

两个写给 [magpie](https://magpie.im) 网关的插件，修同一套上游（`token.nuaa.edu.cn`）的两个毛病：

1. **请求被安全网关误拦** —— 历史里出现某个字面量后，每个后续请求都返回一张写着「访问禁止」的 HTML 页。
2. **响应已完成却被报流中断** —— 回答完整显示出来了，末尾仍报 `responses.incomplete_stream`。

两者是配套的：一个管**请求出去**，一个管**响应回来**，不共享状态，可以同时开启。

## 目录

| 目录 | 插件类型 | 挂载点 | 做什么 |
|---|---|---|---|
| [`waf-shim/`](waf-shim/) | async gateway hook | `onRequest` | 请求发出前改写被误拦的字面量，并插入一条说明告诉模型改了什么 |
| [`nuaa-responses-fix/`](nuaa-responses-fix/) | gateway middleware | `onProvider` / `onEvent` | 在响应已正常收尾之后，吞掉上游多补的那条「流中断」错误 |

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

## 这是给谁用的

给**同一个上游**打交道的 magpie 用户。如果你的上游没有这两个毛病，装上也不会有副作用：

- `waf-shim` 在没有命中时返回 `undefined`，请求原封不动；
- `nuaa-responses-fix` 的作用范围写死为 `responses` 协议 + provider `nuaa` + 模型 `deepseek-flash`，其它流量完全不经过它。

两处范围都可以在各自 README 里改。

## 离线自测

两个插件都带离线测试，不联网、不消耗额度：

```bash
node waf-shim/waf-shim.test.mjs
node nuaa-responses-fix/nuaa-responses-fix.test.mjs
```

输出 `FAILED 0` 即通过。改插件之前先跑一遍，改完再跑一遍。

## 限制与免责

- 都是**针对性补丁**：规则和条件是照着实测的失败现象定的，不是通用方案。上游行为一变就可能失效。
- `waf-shim` 的改写是**传输层的**，会话记录、UI 显示、模型理解都以它插入的那条说明为准。
- 没有任何遥测、网络请求或凭据读写；两个插件都只在内存里处理已有的请求/响应对象。
- 不保证适用于你的 DNS、代理、账号或上游版本。

## License

[MIT](LICENSE)
