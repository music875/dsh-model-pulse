# dsh-model-pulse

**在 dsh-go 手机 App 的输入框上方，常驻一行当前模型的关键读数。**

这是一个**通用的模型状态条**：不管你用 WorkBuddy、DeepSeek 官方 API、智谱、Moonshot、OpenRouter 还是别的渠道，只要能查到数据，就在输入框上方显示；查不到就自动省略，绝不编造。

```
正常 • 积分 • 220           ← WorkBuddy 国内版
峰 • 原价 • ¥0.00           ← DeepSeek 官方 API（错峰时段 + 余额）
限流中 · 余 76.7万           ← 智谱 GLM（有额度但排队）
积分 • 329                  ← WorkBuddy 国际版
```

WorkBuddy 等渠道只是其中一种适配。

## 它显示什么

一条状态条，最多 24 字，从三类数据里取能拿到的，拼成一行：

| 读数 | 含义 | 什么时候有 |
|---|---|---|
| **峰谷** | 当前是不是折扣时段 | WorkBuddy 目录促销 / DeepSeek 官方错峰表 |
| **拥堵** | 模型排队等级 | 只有 WorkBuddy 国内版有 `/v2/chat/busy` 接口 |
| **积分 / 余额 / 资源包** | 还能花多少 | 各渠道的余额或额度接口 |

缺项直接省略，不写「无」。整条都没数据就隐藏。颜色取最该注意的一个：极度拥堵/峰期红 > 轻微拥堵黄 > 空闲/谷期绿。

## 支持的渠道

### WorkBuddy（数据最全）

| 项 | 说明 |
|---|---|
| 峰谷 | 解析 `/v3/config` 的促销规则。国内版 58 个模型里 8 个有折扣（DeepSeek 全系、GLM-5.2、hy4flash-free、space-bunny），国际版 1 个；其余固定价模型不显示峰谷 |
| 拥堵 | `/v2/chat/busy`，分批查全部模型。实测 58 个里 19 个返回真实等级，其余 `unknown` 不显示 |
| 积分 | 当前积分，接口实查，活跃时 30 秒刷新 |
| 区域 | 国内版 `workbuddy` / 国际版 `workbuddy-global`，切区域立即重查 |

### 官方 API 渠道（表驱动，8 家预置）

| 厂商 | 键值 | 显示什么 |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | 错峰峰谷 + `¥0.00` 现金余额 |
| 智谱 BigModel | `CUSTOM_OPEN_BIGMODEL_2_API_KEY` | 真实探测：可用 / 限流中·余量 / 无额度 |
| Moonshot / Kimi | `MOONSHOT_API_KEY` | 现金余额 |
| 硅基流动 | `SILICONFLOW_API_KEY` | 现金余额 |
| OpenRouter | `OPENROUTER_API_KEY` | 美元额度 |
| OpenAI / ChatGPT | `OPENAI_API_KEY` | 订阅剩余百分比 |
| Anthropic / Claude | `ANTHROPIC_API_KEY` | 用量剩余百分比 |
| xAI / Grok | `XAI_API_KEY` | 余额 |

**加 key 即生效**：把 key 存进 `$DSH_HOME/.credentials.yaml` 的 `refs` 段，重启引擎即可，不用改代码。key 名有 `_2`、`CUSTOM_` 前缀等变体也能识别。

**只认官方渠道**：provider 名含 `proxy` / `relay` / `中转` / `代理` 的一律不套官方余额，避免把官方价格套到中转站上。

**没有的机制就不显示**：官方 API 都没有队列接口，所以不显示拥堵；除 DeepSeek 外没有可靠的公开错峰时段表，所以不显示峰谷。

## 显示效果举例

```
正常 • 积分 • 220           国内版 hy4flash，无折扣，有拥堵和积分
峰 • 0.11 • 空闲 • 积分 • 220  国内版 DeepSeek 高峰时段
谷 • 0.06 • 空闲 • 积分 • 220  国内版 DeepSeek 折扣时段
峰 • 原价 • ¥0.00           DeepSeek 官方 API，高峰 + 现金余额
谷 • 5 折 • ¥0.00           DeepSeek 官方 API，错峰 + 现金余额
限流中 · 余 76.7万           智谱 GLM，有额度但被限流
无额度                      智谱 GLM，包已用尽
积分 • 329                  WorkBuddy 国际版
```

（状态条只有 24 字，太长时先去掉次要段落。）

## 数据从哪来

| 数据 | 来源 | 刷新 |
|---|---|---|
| 当前模型 | 会话事件日志 `session.v4.jsonl.zstd` 的最后一条 `model/selection`，投影缓存兜底 | 5 秒检测切换 |
| WorkBuddy 倍率/折扣 | `/v3/config` | 1 小时 |
| WorkBuddy 拥堵 | `/v2/chat/busy` | 活跃 90 秒起，闲置退避 |
| WorkBuddy 积分 | `/v2/billing/meter/get-user-resource` | 活跃 30 秒，闲置退避 |
| 官方 API 余额 | 各厂商真实接口（见适配器表） | 10 秒 |
| 峰谷边界 | 促销时段解析后算出下次切换时刻，到点前不重算 | 事件驱动 |

所有请求失败一次 401/403 会丢 token 缓存重试，不让读数卡住。切模型时三个数据源并行拉取，全部到齐后一次性显示，不会「峰谷先出、拥堵后补」。

峰谷时段按促销规则自带的 `schedule.timezone` 判断（国内版是 `Asia/Shanghai`），不跟设备时区走 —— 手机时区改到别的地区也不会把高峰显示成谷期。

## 适用范围

dsh-go 手机 App 的原生界面（v1.3 实测）。用的是 `composer.strip` + `panels`，由 App 的桥接服务提供。

| 环境 | 表现 |
|---|---|
| **dsh-go 手机 App** | ✅ 状态条 + 面板正常显示 |
| 桌面 dsh / dsh-tui / 网页版 | 能装上、不报错，但没有原生界面元素 |

本插件是 **dsh-go 原生插件**，不是 Cordis bundle。目录在 `$DSH_HOME/dsh-go/plugins/`，用 `dsh plugin --profile web add` 装。

## 安装

```sh
dsh plugin --profile web add https://github.com/music875/dsh-model-pulse
```

装完在 App 里**重启本机引擎**（设置 › 本机引擎 › 重启）生效。

**前置条件**：要显示 WorkBuddy 数据，本机得登录 WorkBuddy（凭据在 `$DSH_HOME/workbuddy-vault/<region>/*.json`，由 `dsh-connect-workbuddy` 等插件扫码登录或手动导入）。要显示官方 API 余额，把对应 key 存进 `$DSH_HOME/.credentials.yaml`。

没登录/没 key 时状态条只是不显示对应数据，不会报错，也不依赖任何其它插件的代码。

## 面板

点状态条打开「WorkBuddy 脉搏」面板，能看到：

- 当前模型 + 渠道
- 峰谷判断依据（目录规则原文 / 静态表出处）
- 拥堵等级与原因
- 积分余额 + 明日签到后预计
- 积分包明细

## 已知限制

- **只有 dsh-go 原生界面显示**，网页/桌面版看不到。
- **官方 API 峰谷只有 DeepSeek**：其它厂商没有可靠的公开错峰时段数据，不编造。
- **智谱用真实请求探测状态**：它的账单接口会返回滞后/失真的余额（包已失效仍显示历史数字），所以改成发一次 `max_tokens=1` 的最小请求，按返回判断「可用 / 限流中 / 无额度」。每 10 秒一次，几乎不耗额度。
- **拥堵只有 WorkBuddy 国内版有**：官方 API 没有公开的队列接口。
- **余额查询有频率限制**：10 秒刷新已经是很短的间隔，再短只会撞限流、耗电，余额本身变化也慢。
- **积分显示的是接口返回值**，不是估算；明日预计只在面板里，状态条只显示当前积分。
- **上游可能不给价格信息**：`/v3/config` 按 User-Agent 决定返回内容，实测短 UA 只给 39 个模型、0 个倍率。真遇到这种情况，状态条会只剩积分，面板「峰谷期」一行会写明「上游目录没返回倍率」，而不是假装没有分时规则。

## 开发

```sh
# 检查清单与代码
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" . --load --lang zh
```

无第三方依赖，只用 Node 内置模块。新增厂商只需在 `API_ADAPTERS` 表里加一项（match + key + 接口 + 解析函数），显示逻辑不用动。

## 从 dsh-connect-workbuddy 的 issue #327 过来

上游插件的模型选择器已经能显示促销徽标（桌面/Web 端），但 dsh-go 手机原生界面是 App 自己画的、不走那套 badge 绘制，所以看不到。这个插件用 `composer.strip` 在输入框上方补上这个位置，顺带把其它官方 API 渠道也一起显示了。

## License

MIT
