# zcode-thinking-kit

[English](./README.md)

给 [ZCode](https://zcode.z.ai) 自定义模型补上「思考强度」的本机回环代理。

ZCode 界面能给**主会话和子智能体**选思考档位。但对不少自定义 provider，这个值出不了站：HTTP 请求体里没有 `reasoning_effort` / `thinking`。本工具监听 `127.0.0.1`，转发到真实上游，并在缺失时注入对应字段。

需要 **Node.js 18+**，无第三方依赖。

## 原理

```
ZCode  --baseURL-->  127.0.0.1:38771  --注入-->  真实供应商
```

1. 把某个 provider 的 `baseURL` 改成本地代理，**路径前缀保持原样**。  
   例：`https://opencode.ai/zen/go/v1` → `http://127.0.0.1:38771/zen/go/v1`  
   请写 `127.0.0.1`，不要写 `localhost`。
2. 代理把请求头（含 `Authorization`）转到 `routes[].upstream`。
3. 若请求体已有思考字段，原样放行。
4. 档位优先级：内核日志按 `x-session-id` 命中 → 模型名后缀 `foo(high)` → 主会话最后一次日志事件 → `staticLevel`。

子智能体和主 Agent **同一套 HTTP 拼装**。该模型的 `baseURL` 指到本代理时，子智能体请求也会进来。子智能体**自己的** `thoughtLevel` 不在 kit 跟随的内核 jsonl 里；目前只能：日志里有对应会话事件、模型 id 带 `(档位)` 后缀，或退回主会话最后一档（接近「继承默认」，**不是**精确保证）。

## 快速开始

```bash
git clone https://github.com/Frisk239/zcode-thinking-kit.git
cd zcode-thinking-kit
copy thinking.config.example.json thinking.config.json
node cli.mjs suggest --write
node cli.mjs start
node cli.mjs doctor
node cli.mjs status
```

打开控制台 `http://127.0.0.1:38771/`（原生 HTML，无框架）或 `/health`。复制 proxied `baseURL`，贴进 ZCode（保留路径），再**新开会话**。页面由代理提供，没 `start` 就没有页面。

停止：`node cli.mjs stop`（确认 `/health` 是本工具后才杀进程）。前台：`node cli.mjs run`。

Windows 还可双击 `start.bat` / `stop.bat`。

## 配置

`thinking.config.json` 从 example 复制，不进 git。

| 字段 | 含义 |
| --- | --- |
| `listen.port` | 本地端口（host 始终强制 `127.0.0.1`） |
| `levelSource.followZcodeLog` | 跟随内核日志（**本地日历日**文件名） |
| `levelSource.staticLevel` | 还没有日志事件时的兜底 |
| `routes[].match` | 进站路径前缀；`/v1` **不会**配上 `/v10`。各前缀必须唯一 |
| `routes[].stripPrefix` | 可选。转发前去掉此前缀，用来区分两个都叫 `/v1` 的上游 |
| `routes[].upstream` | 只写 origin |
| `routes[].followSession` | 该路由跟随 UI / 会话表 |
| `routes[].defaultInject` | `chat/completions` / `responses` / `messages` |
| `routes[].models.<id>.levelMap` | 档位改名 |

模板里 `{level}` 换成档位，`{budget}` 换成按档位估算的 Anthropic thinking budget。`off` / `none` / `disabled` / `nothink` 不注入。

配置热加载只覆盖 **路由、注入模板、staticLevel**。改端口必须重启。

配置查找：`--config=`、`$ZCODE_THINKING_KIT_CONFIG`、当前目录、工具目录、`~/.zcode-thinking-kit/`。

环境变量：`ZCODE_THINKING_KIT_HOME`、`ZCODE_LOG_DIR`、`ZCODE_V2_CONFIG`。

审计：`~/.zcode-thinking-kit/audit.jsonl`，不记录 body、头、密钥。

## 安全

- 本进程位于模型请求路径上，请只运行你读过的代码。
- 只监听回环，不要把端口暴露到局域网。
- 回滚：把 `baseURL` 改回原值即可。

## License

MIT
