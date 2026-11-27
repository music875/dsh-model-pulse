# dsh-workbuddy-pulse

在 dsh-go 手机 App 的输入框上方显示一条状态条：**峰谷期 · 拥堵状态 · 积分余额**。

[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#)

## 它解决什么问题

用 WorkBuddy（CodeBuddy）的模型聊天时，有三件事看不见：

1. **现在贵不贵** —— 上游工作日 9-12、14-18 点是原价，其余时段打 5 折，但客户端不提示
2. **现在排不排队** —— 同一个模型凌晨可能秒回，白天可能排几百位
3. **还剩多少积分** —— 要翻设置页才能看到

这个插件把这三件事做成一条常驻状态条，用不着切页面。

## 显示效果

```
谷 0.06 • 空闲 • 474 (明574)
```

三段分别是：

| 段 | 含义 | 何时出现 |
|---|---|---|
| `谷 0.06` | 折扣后倍率。`谷`=折扣时段、`峰`=原价时段 | 模型有分时折扣规则时 |
| `空闲` | 排队等级：空闲 / 正常 / 轻微拥堵 / 极度拥堵 | 上游给出该模型的队列数据时 |
| `474 (明574)` | 当前积分（明日签到后预计） | WorkBuddy 渠道 |

**取不到的项直接省略**，不写「无」占位。三段都取不到时，整条状态条隐藏。

## 三种渠道的不同行为

| 渠道 | 峰谷 | 拥堵 | 积分 |
|---|---|---|---|
| WorkBuddy 国内版 | ✅ | ✅ | ✅ + 明日预计 |
| WorkBuddy 国际版 | — | — | ✅ 仅当前值 |
| DeepSeek 官方 API | ✅（内置静态规则） | — | — |
| 智谱 / Kimi / OpenRouter / 自建 | — | — | — |

表中 `—` 表示该渠道没有对应数据接口，不是插件缺陷：

- **国际版没有队列接口**：`/v2/chat/busy` 实测返回 404
- **国际版签到已下线**：`active: false`，所以不显示明日预计
- **其他厂商没有分时折扣与队列接口**：实测智谱、Moonshot、SiliconFlow、Groq、OpenRouter 均无

## 数据从哪来

全部来自本机已有的凭据，**只读**，不向任何第三方发送：

| 数据 | 接口 |
|---|---|
| 模型倍率与折扣规则 | `GET {region}/v3/config` |
| 拥堵等级 | `POST {CN}/v2/chat/busy`（一次最多 50 个模型） |
| 积分余额 | `POST {region}/v2/billing/meter/get-user-resource` |
| 签到状态 | `POST {region}/v2/billing/meter/checkin-activity-status` |
| 当前模型 | 本机会话日志 `sessions/<ws>/<id>/session.v4.jsonl.zstd` 的 `model/selection` 事件 |

国内版 `CN = https://copilot.tencent.com`，国际版 `https://www.workbuddy.ai`。

## 适用范围

本插件用 `composer.strip` 与 `panels` 两个槽位，它们由 **dsh-go 手机 App** 的
桥接服务（`dshGo`）提供。

| 环境 | 表现 |
|---|---|
| **dsh-go 手机 App**（v1.0.13 实测） | ✅ 状态条 + 面板正常显示 |
| 桌面 dsh / dsh-tui / 网页版 | 能装上、不报错，但没有界面元素 |
| dsh-mobile / dsh-pocket / mobile-remote 等 | 不适用——它们是网页适配或远程客户端，不在本机跑引擎 |

代码里用 `ctx.inject(['dshGo'], …)` 包住全部界面逻辑，所以没有桥接的宿主上
插件会静默跳过，不会报错、不影响其他功能。

核心逻辑（读凭据、查接口、算峰谷）与界面无关，想移植到别的宿主只需换掉
显示那一层。

## 安装

```sh
dsh plugin --profile web add https://github.com/music875/dsh-workbuddy-pulse
```

装完**重启引擎**（设置 › 本机引擎 › 重启），输入框上方出现状态条。

**前置条件**：本机已登录 WorkBuddy，凭据在 `$DSH_HOME/workbuddy-vault/<region>/*.json`。

凭据从哪来都行——`dsh-connect-workbuddy`、`dsh-workbuddy-connect` 扫码登的，或者手动导入的，只要文件在那个目录就能用。**本插件不依赖任何其他插件的代码**，只共用这个凭据目录。

没登录时状态条不会报错，它只是不显示。

## 实现要点

### 折扣规则有两种形态，都得解析

上游对 GLM 下发结构化的 `discount.factor` + `schedule.daily`，对 DeepSeek 系列**只给一句话**：

```
周一至周五 09:00–12:00、14:00–18:00 属高峰原价，非高峰期积分5折
```

只认 `factor` 会漏掉 DeepSeek，所以插件按上游自己的措辞解析「N折」与高峰时段。上游改文案后 30 分钟内自动跟上。

### 当前模型必须从实时日志读

`storages/session_projcache/` 是**延迟写**的投影缓存，实测切完模型 3 分钟后它还可能停在旧值。真实来源是事件日志里的 `model/selection`，每次切换立刻追加。

日志按 zstd 压缩，Node 24 的 `zstdDecompressSync` 可直接解。为避免每 5 秒解压 3.5MB（约 63ms），按 `(mtime, size)` 缓存：没变就直接用上次结果，0ms。

### 同名模型不能串数据

智谱官方的 `glm-5.3-flash` 和 WorkBuddy 目录里的 `glm-5.3-flash` 是**两个不同的东西**。插件先看 `provider`：

- `workbuddy*` → 才去对应区域目录查倍率
- 其他 → 不查目录，不套用任何 WorkBuddy 数据

### 一条状态条只能一种颜色

协议里 `composer.strip.tone` 是单个枚举。三项合成一句时，颜色取最紧急的：**极度拥堵红 > 峰期红 > 轻微拥堵黄 > 谷期绿**。

### 拥堵等级对照

来自上游客户端 bundle 的枚举，不是自造：

| 上游值 | 显示 | 颜色 |
|---|---|---|
| `idle` | 空闲 | 绿 |
| `normal` | 正常 | 绿 |
| `busy` | 轻微拥堵 | 黄 |
| `congested` | 极度拥堵 | 红 |
| `unavailable` | — | 不显示 |
| `unknown` | — | 不显示 |

`unknown` 表示上游没公开该模型的队列数据，**不等于空闲**，所以不显示而非显示「空闲」。

## 已知限制

- **只对 WorkBuddy 完整生效**。其他厂商没有公开的队列/折扣接口，插件不会猜，会直接不显示。
- **「轻微拥堵」「极度拥堵」两个等级来自官方词表，但作者实测未触发**。凌晨连续采样 180 次只得到 `idle` / `normal`，推测高峰期才会出现。
- **DeepSeek 官方错峰规则是静态表**（核对于 2026-11-27，出处见代码注释）。厂商调价需要更新插件。
- **积分显示的是接口返回值，不是估算**。活跃时 30 秒查一次（接近实时），
  闲置后逐步退避到 10 分钟省电；切换模型或打开面板立即重查。拥堵与倍率同样
  按空闲时长自适应。不是逐秒轮询：积分变化慢，高频查询只会撞限流、耗电。

## 开发

```sh
# 检查清单与代码
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" . --load --lang zh
```

无第三方依赖，只用 Node 内置模块。

## 如果你是从 dsh-connect-workbuddy 的 issue #327 过来的

这个插件只做一件事：**把原本要在设置页里翻的读数，变成输入框上方的一行常驻显示**。

上游插件的模型选择器已经能显示「夜间折扣 / 限时免费」徽标（桌面/Web 端），
但 dsh-go 手机原生界面是 App 自己画的，不走那套 badge 绘制，所以看不到。
这个插件用 `composer.strip` 在输入框上方补上这个位置。

三分钟上手：

```sh
# 1. 装（先用上游插件登录 WorkBuddy）
dsh plugin --profile web add https://github.com/music875/dsh-workbuddy-pulse

# 2. 重启引擎：设置 › 本机引擎 › 重启

# 3. 看输入框上方，切到不同模型时读数会跟着变
```

看到 `谷 0.06 • 空闲 • 397 (明497)` 就是装好了。

**为什么有时只显示积分、或部分内容**：没有分时折扣的模型（如 `hy4flash` 固定 x0.03）
不显示峰谷；国际版没有队列接口不显示拥堵；非 WorkBuddy 渠道整条隐藏。
这些是上游没提供数据，不是故障。

有问题直接开 issue，模板会引导你填模型名和渠道。

## License

MIT
