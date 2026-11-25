# magpie-nuaa-plugins

两个写给 [magpie](https://magpie.im) 网关的小插件，修同一套上游（`token.nuaa.edu.cn`）的两个小毛病。

## 用大白话说

### 插件一：waf-shim —— 让被「安检」扣下的请求能过去

上游门口有一道安检，会把对话里的某个词当成危险品。只要对话里出现过一次，之后**每一次**带着它的请求都会被整张退回，只返回一张写着「访问禁止」的网页。于是这个会话就废了，只能新开一个。

更麻烦的是，那个词是 Python 报错时自动生成的。只要你用代码工具跑过脚本、脚本报过一次错，它就会永久躺在对话历史里，之后每轮请求都把它重新发出去。

这个插件干的事很朴素：**在请求递到安检之前，把那个词换成一个安检不管的写法**，相当于给它"描了个边"。同时在对话里贴一张便条，告诉模型：

> 这个词我改过了。改后的写法跟原文完全等价，原文是"被尖括号包住的 module"。

这样安检放行，模型也不会把改过的写法当成你真的写了那样。

### 插件二：nuaa-responses-fix —— 让「已经收完的货」不被报成丢件

回答明明已经完整显示在屏幕上了，末尾却冒一条错误：「上游的流没有正常结束」。客户端于是把它当成失败，弹重试。

实际上终止信号是收到了的——只是上游关连接的方式让网关多疑，又补发了一条「我没收到终止信号」。

这个插件干的事也很朴素：**在确认"东西确实已经完整到手"之后，把这条假警报拦下来**。

判断写得很严，四个条件全满足才拦：

1. 是 Responses 协议；
2. provider 是 `nuaa`；
3. 完整收到过一条合法的「已完成」事件（有 id、有 output）；
4. 这一轮从头到尾没出过错。

只要有一条不满足就原样放行——宁可不修，也不盖住真正的错误。

## 一句话版本

| 插件 | 一句话 | 好比 |
|---|---|---|
| `waf-shim` | 请求发出前，把会被误拦的词换成等价写法，并告诉模型改了什么 | 过安检前把会被扣的东西换个合规包装，再贴张说明 |
| `nuaa-responses-fix` | 响应已经完整收到后，吞掉上游补发的假「流中断」错误 | 快递已签收，把系统误弹的「配送失败」提示划掉 |

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
