/**
 * 通用模型状态条 —— 在 dsh-go 输入框上方常驻一行当前模型读数。
 *
 * 适配 WorkBuddy（峰谷/拥堵/积分）与 8 家官方 API（余额/资源包/错峰），
 * 表驱动扩展；读不到的项自动省略，不编造。名字里的 workbuddy 是历史原因。
 *
 * 早期设计：三帧轮转
 *
 * ## 为什么合成一个插件
 *
 * 之前拆成三个插件（各一条状态条），想让 App 按「峰谷→拥堵→积分→root桥」
 * 排。实测做不到：`plugins.seats` 只控制显示方式（native/island/web/hidden），
 * 没有顺序字段；bundles 数组顺序和 strip id 前缀都不改变 App 的轮转次序，
 * root 桥始终夹在中间，三条读数被拆散。
 *
 * 合成一个插件后，三帧在**插件内部**轮转，不经过 App 的跨插件调度，顺序由
 * 我们自己控制，也不会被别的条目插进来。
 *
 * ## 代价
 *
 * 一条状态条只有一种 `tone`，所以每帧单独着色、帧与帧之间可以不同色 —— 这
 * 正是我们要的：峰谷帧绿/红、拥堵帧绿/黄/红、积分帧默认色。同一帧内不能
 * 同时出两种颜色，但这三件事本来就不需要同帧。
 *
 * ## 三帧内容
 *
 *   峰谷期  谷 x0.06（绿） / 峰 x0.11（红） / 无规则 → 跳过该帧
 *   拥堵    空闲/正常（绿） / 轻微拥堵（黄） / 极度拥堵（红） / 无数据 → 跳过
 *   积分    积分:504（默认色） / 非 WorkBuddy 渠道 → 跳过
 *
 * 「跳过该帧」= 这一帧不参与轮转，而不是显示「无」。
 *
 * ## 数据来源
 *
 *   当前模型   `$DSH_HOME/storages/session_projcache/sessions/<id>.json`
 *              → record.rows.modelSelection.val.lastUsed
 *   倍率/折扣  WorkBuddy `/v3/config`（接口为准，本地缓存仅兜底）
 *              DeepSeek 官方走内置静态表（接口不返回促销）
 *   拥堵       WorkBuddy 国内版 `/v2/chat/busy`（国际版该路由 404）
 *   积分       `/v2/billing/meter/get-user-resource`
 *              + `/v2/billing/meter/checkin-activity-status`（判签到是否开着）
 *
 * 所有请求失败一次遇到 401/403 会丢缓存换 token 重试，不让读数卡住。
 */

import { readFile, readdir, stat, readdir as ls } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CN = 'https://copilot.tencent.com'
const GLOBAL = 'https://www.workbuddy.ai'
const UA = 'WorkBuddy/1.12.0 WorkBuddy/1.12.0 CLI/1.12.0'

const MODEL_MS = 5_000       // 跟随模型切换（只 stat 文件，命中缓存 0ms）
const CONFIG_MS = 60 * 60_000  // 倍率与折扣：1 小时（原 30 分钟，规则很少变）
const TOKEN_TTL = 10 * 60_000

/**
 * 拥堵与积分的刷新间隔不是固定值，而是**按空闲时长自适应**：
 * 刚操作过（<2 分钟）→ 密集查，保证手感；放着不动 → 逐步拉长，省电省流量。
 *
 * 为什么拥堵比积分查得勤：切换模型或发消息时，用户在意「现在要不要排队」，
 * 而积分是慢变量，3 分钟一次完全够。
 */
const BUSY_STEPS = [
  { idle: 0,          ms: 90_000 },        // 刚有操作：90 秒
  { idle: 2 * 60_000, ms: 5 * 60_000 },    // 静置 2 分钟：5 分钟
  { idle: 10 * 60_000, ms: 15 * 60_000 },  // 静置 10 分钟：15 分钟
  { idle: 30 * 60_000, ms: 30 * 60_000 },  // 静置 30 分钟：30 分钟
]
/**
 * 积分刷新。
 *
 * 用户希望「实时」，但逐秒轮询会撞腾讯限流（官方对余额接口有频率限制），
 * 也会明显耗电。折中：**活跃时 30 秒**——人在用时看到的数字基本是当下的，
 * 不会觉得「过时」；一旦闲置再逐步退避，最长 10 分钟。
 *
 * 这个 30 秒不是拍脑袋：余额接口本身很轻（返回几十字节），30 秒一次
 * = 每小时 120 次，仍在安全区间内；真正贵的是拥堵探针（要传 50 个模型 id）。
 */
const CREDIT_STEPS = [
  { idle: 0,           ms: 30_000 },        // 活跃：30 秒（接近实时）
  { idle: 2 * 60_000,  ms: 60_000 },        // 静置 2 分钟：1 分钟
  { idle: 10 * 60_000, ms: 5 * 60_000 },    // 静置 10 分钟：5 分钟
  { idle: 30 * 60_000, ms: 10 * 60_000 },   // 静置 30 分钟：10 分钟
]

/** 按空闲时长取当前该用的间隔。 */
function intervalOf(steps, idleMs) {
  let ms = steps[0].ms
  for (const step of steps) if (idleMs >= step.idle) ms = step.ms
  return ms
}

const JAM_LEVELS = new Set(['idle', 'normal', 'busy', 'congested'])

/**
 * DeepSeek 官方错峰规则（静态表）。
 *
 * 厂商 API 不返回促销信息，规则只在文档里，所以只能内置。时段按 UTC 计算：
 * 原文即 UTC，用本地时区算会在换时区时错。
 *
 * 出处：https://api-docs.deepseek.com/quick_start/pricing（核对 2026-11-27）
 * 原文：Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday,
 *       excluding Chinese public holidays. Off-peak rates are half of peak.
 */
/**
 * 官方 API 的分时峰谷规则表（表驱动，与余额适配器表风格一致）。
 *
 * 事实核查（2026-11-27）：目前只有 DeepSeek 公开了错峰半价时段；
 * Moonshot / 硅基流动 / 智谱等没有公开的错峰定价，所以这里只列 DeepSeek。
 * 以后哪家推出分时价，在表里加一项即可，显示逻辑不用改。
 */
const OFFPEAK_RULES = [
  {
    match: /^deepseek([-_]?(official|api))?$/,
    peakUtc: [[1 * 60, 4 * 60], [6 * 60, 10 * 60]],
    weekdayOnly: true,
    factor: 0.5,
    label: 'DeepSeek 错峰优惠',
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    checkedAt: '2026-11-27',
  },
]

// 兼容旧引用
const DEEPSEEK_OFFPEAK = OFFPEAK_RULES[0]

const st = {
  provider: '',
  model: '',
  modelAt: 0,

  rates: /** @type {Record<string, number>} */ ({}),
  names: /** @type {Record<string, string>} */ ({}),
  region: /** @type {Record<string, string>} */ ({}),
  ids: /** @type {string[]} */ ([]),
  promos: /** @type {Record<string, any[]>} */ ({ cn: [], global: [] }),
  cfgAt: 0,

  /**
   * 目录是否「退化」：上游只返回模型 id、不给倍率也不给促销。
   *
   * 实测（2026-11-28）：同一个 token 只换 User-Agent，`/v3/config` 返回
   *   短 UA `WorkBuddy/1.12.0`             → 39 个模型 / 0 个倍率 / 0 个促销
   *   完整 UA `WorkBuddy/1.12.0 … CLI/…`   → 58 个模型 / 36 个倍率 / 5 个促销
   * 也就是说上游按 UA 决定给不给价格信息。真遇到这种退化时，插件会**静默**
   * 只剩积分（因为 ids 不为 0，连本地目录兜底都不触发），用户以为峰谷坏了。
   * 这里记一笔，由面板显示成因；状态条不占字数。
   */
  degraded: false,
  degradedAt: 0,

  busy: /** @type {Record<string, string>} */ ({}),
  busyAt: 0,

  /** 外部官方 API 余额：{ provider, cny, at }，仅 provider 匹配时显示。 */
  apiBalance: /** @type {{ provider: string, cny: string, at: number } | null} */ (null),

  total: 0,
  packages: /** @type {any[]} */ ([]),
  checkin: /** @type {any} */ (null),
  creditRegion: '',
  creditAt: 0,

  /** 上一帧内容，做脏检查避免空转。 */
  lastText: '',
  lastTone: '',

  /**
   * 最后一次「用户在操作」的时刻，用于自适应省电。
   *
   * 初值必须是 `Date.now()` 而不是 0 —— 用 0 的话冷启动会被算成
   * 「已经闲置两万天」，直接套最省电的档位，用户打开 App 后要等半小时
   * 才看到真实数据。启动即视为「刚操作」，先用密集间隔把数据拉准。
   */
  activeAt: Date.now(),
  /** 是否已经成功拉到过一次数据（用于判断首轮是否完成）。 */
  primed: false,
}

const tokenCache = /** @type {Record<string, { token?: string, at: number }>} */ ({})

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

async function tokenOf(region, force = false) {
  const now = Date.now()
  const hit = tokenCache[region]
  if (!force && hit && now - hit.at < TOKEN_TTL) return hit.token

  const dir = join(dshHome(), 'workbuddy-vault', region)
  let token
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue
      const doc = JSON.parse(await readFile(join(dir, name), 'utf8'))
      const auth = doc?.auth
      if (!auth?.accessToken) continue
      const domain = String(auth.domain || '').toLowerCase()
      const isGlobal = domain.includes('workbuddy.ai') || domain.includes('codebuddy.ai')
      if (region === 'global' && !isGlobal) continue
      if (region === 'cn' && isGlobal) continue
      token = String(auth.accessToken)
      break
    }
  } catch {
    // 该区域没登录
  }
  tokenCache[region] = { token, at: now }
  return token
}

/**
 * 从 DSH 的 .credentials.yaml 里读一个 key 的明文值（只读 refs 段）。
 * 只取我们认识的 key 名，不解析整个 yaml。
 */
async function credentialKey(name) {
  try {
    const text = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8')
    // key 名容错：先精确匹配，再按厂商词干模糊匹配（适配 _2 / CUSTOM_ 前缀等变体）
    const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const read = (pattern) => {
      const m = new RegExp('^\\s*' + pattern + '\\s*:\\s*(.+)$', 'm').exec(text)
      if (!m) return undefined
      let v = m[1].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return v || undefined
    }
    const exact = read(esc(name))
    if (exact) return exact
    // 词干：DEEPSEEK_API_KEY → DEEPSEEK；CUSTOM_OPEN_BIGMODEL_2_API_KEY → BIGMODEL
    const stem = name.replace(/^(CUSTOM_|OPEN_)/, '').replace(/_API_KEY.*$/, '').split('_')[0]
    if (stem.length >= 4) {
      const fuzzy = read('[A-Z0-9_]*' + esc(stem) + '[A-Z0-9_]*_API_KEY[A-Z0-9_]*')
      if (fuzzy) return fuzzy
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 判断 provider 是否是需要显示官方 API 余额的渠道，返回它的 key 名。
 * 只认明确的官方 provider 名，避免中转站套用官方余额。
 */
/**
 * 官方 API 适配器表（表驱动，方便以后加厂商）。
 *
 * 每项：
 *   match   provider 名正则（规范化后匹配）
 *   key     .credentials.yaml refs 里的 key 名
 *   base + path + parse  查余额的接口与解析函数
 *
 * 只认明确的官方 provider 名；中转站（custom-xxx-proxy）不匹配，
 * 避免把别人的余额套到中转站模型上。
 */
/**
 * 官方 API 适配器表（覆盖所有主流厂商，表驱动）。
 *
 * 匹配策略：provider 名里包含厂商关键字就认（宽松匹配），
 * 这样 custom-xxx / xxx-api / xxx-official / 各种别名都能识别。
 * 只排除明显的代理/中转站（含 proxy/relay/forward 字样）。
 *
 * 每个厂商：key 名 + 真实余额/用量接口 + 解析函数。
 * key 加入了 .credentials.yaml 才生效；没加就跳过，不影响其他渠道。
 */
/**
 * 统一的「限流 / 无额度」判定，供所有官方 API 适配器复用。
 *
 * 各家错误码不同，但语义一致：
 *   余额/额度耗尽 → exhausted
 *   频率限制 / 排队 → throttled
 *   其他           → unknown
 *
 * 返回 undefined 表示这次探测没得出结论（网络错误等），调用方应保持上次状态。
 */
function classifyQuotaError(status, body) {
  const msg = String(body?.error?.message || body?.message || body?.msg || '')
  const code = body?.error?.code ?? body?.code ?? body?.error?.type
  const c = String(code ?? '')

  // 无额度 / 余额不足（各家措辞）
  if (status === 402
    || /余额不足|无可用资源包|欠费|insufficient|quota exceeded|exceeded your current quota/i.test(msg)
    || ['1113', 'insufficient_quota', 'billing_hard_limit_reached'].includes(c)) {
    return 'exhausted'
  }
  // 限流 / 排队（有额度但暂时用不了）
  if (status === 429
    || /访问量过大|请稍后再试|rate limit|too many requests|overloaded|try again later/i.test(msg)
    || ['1305', 'rate_limit_exceeded', 'rate_limit_error'].includes(c)) {
    return 'throttled'
  }
  return undefined
}

const API_ADAPTERS = [
  {
    match: /deepseek/i,
    key: 'DEEPSEEK_API_KEY',
    base: 'https://api.deepseek.com', path: '/user/balance',
    parse: (r) => {
      const n = Number((r?.balance_infos || [])[0]?.total_balance)
      return Number.isFinite(n) ? '¥' + n.toFixed(2) : undefined
    },
  },
  {
    // 智谱：账单接口在 bigmodel.cn 域；最新一条 deductAfter = 资源包剩余 token
    match: /(zhipu|bigmodel|\bglm\b)/i,
    key: 'CUSTOM_OPEN_BIGMODEL_2_API_KEY',
    custom: async (key, model) => {
      const m = String(model || 'glm-4.7-flash')

      // 先用账单接口拿「还剩多少」（可能滞后，但能给个数量）
      let remainText
      try {
        const month = new Date().toISOString().slice(0, 7)
        const bill = await fetchJson('https://bigmodel.cn',
          `/api/finance/expenseBill/expenseBillList?billingMonth=${month}&pageNum=1&pageSize=50`, key)
        const rows = bill?.rows || []
        const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')
        const modelKey = norm(String(m).replace(/-(legal|preview|exp|beta)$/i, ''))
        const modelBase = modelKey.replace(/(flash|pro|air|x)$/, '')
        // 找该模型对应的包，取最新时间窗内最大的正余额（成对记录里取可信值）
        const names = []
        for (const x of rows) {
          const n = String(x?.tokenResourceName || '')
          if (!n || names.includes(n)) continue
          const nn = norm(n)
          const hit = nn.includes(modelKey) || (modelBase.length >= 3 && nn.includes(modelBase))
          if (hit || /通用/.test(n)) names.push({ n, hit })
        }
        names.sort((a, b) => (b.hit ? 1 : 0) - (a.hit ? 1 : 0))
        for (const { n } of names) {
          const mine = rows.filter((x) => x?.tokenResourceName === n && x?.deductAfter != null)
          if (mine.length === 0) continue
          const win = mine[0].timeWindow
          let best
          for (const x of mine) {
            if (x.timeWindow !== win) continue
            const v = Number(x.deductAfter)
            if (Number.isFinite(v) && v > 0 && (best === undefined || v > best)) best = v
          }
          if (best === undefined) {
            for (const x of mine) {
              const v = Number(x.deductAfter)
              if (Number.isFinite(v) && v > 0 && (best === undefined || v > best)) best = v
            }
          }
          if (best !== undefined) {
            remainText = best >= 10000 ? (best / 10000).toFixed(1) + '万' : String(Math.round(best))
            break
          }
        }
      } catch { /* 账单失败不影响下面的探测 */ }

      // 再发一次最小真实请求，判断当前能不能用
      try {
        const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(15000),
        })
        if (res.ok) return remainText ? '资源包 ' + remainText : '可用'
        const body = await res.json().catch(() => undefined)
        const kind = classifyQuotaError(res.status, body)
        if (kind === 'exhausted') return '无额度'
        if (kind === 'throttled') return remainText ? '限流中 · 余 ' + remainText : '限流中'
        return remainText ? '资源包 ' + remainText : undefined
      } catch {
        return remainText ? '资源包 ' + remainText : undefined
      }
    },
  },
  {
    match: /(moonshot|\bkimi\b)/i,
    key: 'MOONSHOT_API_KEY',
    base: 'https://api.moonshot.cn', path: '/v1/users/me/balance',
    parse: (r) => {
      const n = Number(r?.data?.balance)
      return Number.isFinite(n) ? '¥' + n.toFixed(2) : undefined
    },
  },
  {
    match: /(siliconflow|silicon|硅基)/i,
    key: 'SILICONFLOW_API_KEY',
    base: 'https://api.siliconflow.cn', path: '/v1/user/info',
    parse: (r) => {
      const n = Number(r?.data?.balance)
      return Number.isFinite(n) ? '¥' + n.toFixed(2) : undefined
    },
  },
  {
    match: /openrouter/i,
    key: 'OPENROUTER_API_KEY',
    base: 'https://openrouter.ai', path: '/api/v1/credits',
    parse: (r) => {
      const n = Number(r?.data?.total_credits) - Number(r?.data?.total_usage || 0)
      return Number.isFinite(n) ? '$' + n.toFixed(2) : undefined
    },
  },
  {
    match: /(openai|chatgpt)/i,
    key: 'OPENAI_API_KEY',
    // ChatGPT 订阅额度接口；拿不到就隐藏，不做 chat 探测（避免误判限流）。
    base: 'https://chatgpt.com', path: '/backend-api/wham/usage',
    parse: (r) => {
      const n = Number(r?.rate_limit?.primary_window?.usedPercent)
      return Number.isFinite(n) ? (100 - n).toFixed(0) + '% 剩余' : undefined
    },
  },
  {
    match: /anthropic/i,
    key: 'ANTHROPIC_API_KEY',
    base: 'https://api.anthropic.com', path: '/api/oauth/usage',
    parse: (r) => {
      const n = Number(r?.five_hour?.utilization)
      return Number.isFinite(n) ? (100 - n).toFixed(0) + '% 剩余' : undefined
    },
  },
  {
    match: /(xai|grok)/i,
    key: 'XAI_API_KEY',
    base: 'https://api.x.ai', path: '/v1/me',
    parse: (r) => Number.isFinite(Number(r?.balance)) ? '¥' + Number(r.balance).toFixed(2) : undefined,
  },
]

/** 明显的代理/中转站不套官方余额（避免报错价）。 */
const PROXY_HINT = /(proxy|relay|forward|中转|代理)/i


function apiAdapterFor(provider) {
  const p = String(provider || '')
  if (!p || PROXY_HINT.test(p)) return undefined
  return API_ADAPTERS.find((a) => a.match.test(p))
}

function apiKeyNameFor(provider) {
  return apiAdapterFor(provider)?.key
}

/** 查官方 API 余额：按适配器表执行，查不到返回 undefined（不显示）。 */
async function fetchApiBalance(provider, model) {
  const a = apiAdapterFor(provider)
  if (!a?.key) return undefined
  const key = await credentialKey(a.key)
  if (!key) return undefined
  try {
    if (a.custom) return await a.custom(key, model)
    if (!a.base || !a.path || !a.parse) return undefined
    const r = await fetchJson(a.base, a.path, key)
    return a.parse(r)
  } catch {
    return undefined
  }
}

async function refreshApiBalance(force) {
  const keyName = apiKeyNameFor(st.provider)
  if (!keyName) { st.apiBalance = null; return }
  const now = Date.now()
  // 10 秒刷新（用户要求最短）；provider 没变又没到点就跳过
  if (!force && st.apiBalance && st.apiBalance.provider === st.provider && now - st.apiBalance.at < 10_000) return
  const cny = await fetchApiBalance(st.provider, st.model)
  st.apiBalance = cny === undefined ? null : { provider: st.provider, cny, at: now }
}

async function fetchJson(base, path, token, init) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      'user-agent': UA,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status)
    err.status = res.status
    throw err
  }
  return res.json()
}

const authExpired = (e) => e && (e.status === 401 || e.status === 403)

/** 带 401 自动换 token 重试的 POST。 */
async function postWithRetry(region, path, body = '{}') {
  let token = await tokenOf(region)
  if (!token) return undefined
  const call = (tk) => fetchJson(region === 'cn' ? CN : GLOBAL, path, tk, { method: 'POST', body })
  try {
    return await call(token)
  } catch (first) {
    if (!authExpired(first)) throw first
    token = await tokenOf(region, true)
    if (!token) return undefined
    return await call(token)
  }
}

/**
 * 读当前模型。
 *
 * **两个来源，优先实时的那一个。**
 *
 * `storages/session_projcache/sessions/<id>.json` 是投影缓存，实测**延迟写**
 * —— 切完模型 3 分钟后它还可能停在旧值，用户看到的就是「切了智谱还显示
 * WorkBuddy 的数据」。
 *
 * `sessions/<workspace>/<id>/session.v4.jsonl.zstd` 是事件日志，每次
 * `model/selection` 都会立刻追加一条。它以 zstd 压缩存储（Node 24 的
 * `zstdDecompressSync` 能直接解），文件解压后几 MB，所以按 mtime 缓存，
 * 没变就不重读。
 */
/**
 * 匹配 `model/selection` 事件里的 provider 与 model。
 *
 * 早期版本把字段顺序写死成 `"data":{"provider":…,"model":…}`，上游只要在
 * 两者之间插入一个字段，整行就匹配不上 —— 结果是「当前模型永远读不到」，
 * 状态条只剩积分。
 *
 * 现在只锚定事件头，再在同一个 data 对象里分别找两个键，顺序无关。
 * 实测 27 个会话，新旧解析结果完全一致，只是不再依赖键序。
 */
const LOG_MARK = /"type":"model\/selection"/
const LOG_PROVIDER = /"provider":"([^"]+)"/
const LOG_MODEL = /"model":"([^"]+)"/

async function findSessionLog(sessionId) {
  const sessionsRoot = join(dshHome(), 'sessions')
  try {
    for (const ws of await ls(sessionsRoot)) {
      const dir = join(sessionsRoot, ws, sessionId)
      try {
        const info = await stat(join(dir, 'session.v4.jsonl.zstd'))
        return { file: join(dir, 'session.v4.jsonl.zstd'), mtimeMs: info.mtimeMs }
      } catch {
        continue
      }
    }
  } catch {
    // 没有 sessions 目录
  }
  return undefined
}

/**
 * 日志读取缓存。
 *
 * 实测：3.5 MB 的 zstd 文件解压成 9 MB 要 63 ms。每 5 秒做一次就是每分钟
 * 758 ms CPU —— 在手机上这是实打实的耗电与发热。所以按 (mtime, size) 判断
 * 文件有没有变：没变就直接用上次的结果，一次磁盘都不碰。
 *
 * 宿主只有在真的追加事件时才会改 mtime，所以「没变化」这个判断是可靠的。
 */
const logCache = {
  file: '',
  key: '',        // `${mtimeMs}:${size}`
  result: /** @type {{provider:string,model:string,at:number}|undefined} */ (undefined),
}

/** 从事件日志取最后一条 model/selection。 */
async function modelFromLog(sessionId) {
  const found = await findSessionLog(sessionId)
  if (found === undefined) return undefined

  let info
  try {
    info = await stat(found.file)
  } catch {
    return undefined
  }

  // 大日志保护：长会话的日志会一直长。超过 40 MB 就放弃解压（内存与 CPU
  // 都不划算），改由投影缓存兜底 —— 那条路径慢一点但不会拖垮插件。
  const MAX_LOG_BYTES = 40 * 1024 * 1024
  if (info.size > MAX_LOG_BYTES) return undefined
  const key = found.file + ':' + info.mtimeMs + ':' + info.size
  if (logCache.key === key && logCache.file === found.file) return logCache.result

  let result
  try {
    const raw = await readFile(found.file)
    const text = zstdDecompressSync(raw).toString('utf8')
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('model/selection')) continue
      if (!LOG_MARK.test(line)) continue
      const pv = LOG_PROVIDER.exec(line)
      const md = LOG_MODEL.exec(line)
      if (pv && md) { result = { provider: pv[1], model: md[1], at: info.mtimeMs }; break }
    }
  } catch {
    // 解压或读取失败：交给投影缓存兜底
  }

  logCache.key = key
  logCache.file = found.file
  logCache.result = result
  return result
}

/**
 * 统计本对话累计 token 消耗（输入 / 输出 / 缓存命中）。
 * 只在官方 API 渠道面板里显示 —— WorkBuddy 渠道已有积分读数，不重复。
 * 复用 modelFromLog 的日志解压结果思路，按 (mtime,size) 缓存。
 */
const tokenStatCache = { key: '', value: /** @type {any} */ (null) }

async function sessionTokenStat(sessionId, modelFilter) {
  if (!sessionId) return undefined
  const found = await findSessionLog(sessionId)
  if (found === undefined) return undefined
  let info
  try { info = await stat(found.file) } catch { return undefined }
  if (info.size > 40 * 1024 * 1024) return undefined
  // 缓存键含模型：不同模型的统计互不串
  const key = found.file + ':' + info.mtimeMs + ':' + info.size + ':' + (modelFilter || '')
  if (tokenStatCache.key === key) return tokenStatCache.value

  let value
  try {
    const raw = await readFile(found.file)
    const text = zstdDecompressSync(raw).toString('utf8')
    let input = 0, output = 0, cacheRead = 0, calls = 0
    for (const line of text.split('\n')) {
      if (!line.includes('"assistant/message"') || !line.includes('"usage"')) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      const u = o?.data?.usage
      if (!u) continue
      // 只统计当前模型（按 provider + model 过滤），切换模型后各自独立
      if (modelFilter) {
        const src = o?.data?.message?.source || {}
        const evKey = String(src.provider || '') + '/' + String(src.model || '')
        if (evKey !== modelFilter) continue
      }
      input += Number(u.inputTokens) || 0
      output += Number(u.outputTokens) || 0
      cacheRead += Number(u.cacheReadTokens) || 0
      calls += 1
    }
    value = { input, output, cacheRead, calls }
  } catch {
    value = tokenStatCache.value
  }
  tokenStatCache.key = key
  tokenStatCache.value = value
  return value
}

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

async function readCurrentModel(sessionId) {
  if (!sessionId) return false

  const fromLog = await modelFromLog(sessionId)
  if (fromLog !== undefined) {
    const changed = fromLog.model !== st.model || fromLog.provider !== st.provider
    if (changed) {
      st.model = fromLog.model
      st.provider = fromLog.provider
      st.modelAt = fromLog.at
    }
    return changed
  }

  // 兜底：日志不可读时用投影缓存
  const path = join(dshHome(), 'storages', 'session_projcache', 'sessions', sessionId + '.json')
  try {
    const info = await stat(path)
    if (info.mtimeMs <= st.modelAt) return false
    const doc = JSON.parse(await readFile(path, 'utf8'))
    const last = doc?.record?.rows?.modelSelection?.val?.lastUsed
    if (last && typeof last.model === 'string') {
      const changed = last.model !== st.model || String(last.provider || '') !== st.provider
      st.model = last.model
      st.provider = String(last.provider || '')
      st.modelAt = info.mtimeMs
      return changed
    }
  } catch {
    // 保持上次读数
  }
  return false
}

/**
 * 把会话里的模型 id 对到「当前 provider 所属目录」里的条目。
 *
 * 关键约束：**非 WorkBuddy 的 provider 一律不做目录匹配。**
 * 智谱的 `glm-5.3-flash`、免费的 `deepseek-v4.1-flash-free` 等名字和
 * WorkBuddy 目录里的模型高度重合，之前按前缀模糊匹配会把这些外部模型
 * 对到国内版条目上，于是拿腾讯的倍率/队列/积分去描述别人的模型 ——
 * 那不是「识别」，是张冠李戴。
 *
 * 所以匹配只在 provider 确实是 workbuddy* 时才做，且只在该 provider
 * 对应的区域目录里做（国际版目录里叫 `-sg` 后缀，前缀匹配就是为了这个）。
 */
function resolveModelId() {
  const m = st.model
  if (!m) return m

  const isWorkBuddy = st.provider.startsWith('workbuddy')
  if (!isWorkBuddy) return m          // 外部渠道：原样返回，不查 WorkBuddy 目录

  const wbRegion = st.provider.includes('global') ? 'global' : 'cn'
  if (st.rates[m] !== undefined && st.region[m] === wbRegion) return m

  const pool = st.ids.filter((id) => st.region[id] === wbRegion)
  const exact = pool.find((id) => id === m)
  if (exact !== undefined) return exact

  // 前缀匹配只用于「同一模型的不同写法」（国际版给 -sg 后缀），
  // 因此额外要求两边长度差 ≤ 8，避免 `glm-5.3` 误配到 `glm-5.3-flashx`
  // 这种只是共享前缀的另一个模型。
  const loose = pool.find((id) => {
    const prefixed = id.startsWith(m) || m.startsWith(id)
    return prefixed && Math.abs(id.length - m.length) <= 8
  })
  return loose ?? m
}

function regionOf() {
  const p = st.provider
  if (p.includes('global')) return 'global'
  if (p.startsWith('workbuddy')) return 'cn'
  return ''
}

/** 上游对 DeepSeek 只给文字，解析「N折」与高峰时段。 */
function parseTextRule(promo) {
  const text = String(promo?.hover?.textZh || promo?.hover?.textEn || '')
  const ids = Array.isArray(promo?.modelIds) ? promo.modelIds : []
  if (text === '' || ids.length === 0) return undefined

  const frac = text.match(/([0-9]+(?:\.[0-9]+)?)\s*折/)
  let factor
  if (frac) {
    factor = Number(frac[1]) / 10
  } else {
    const pct = text.match(/([0-9]+)\s*%\s*off/i)
    if (!pct) return undefined
    factor = 1 - Number(pct[1]) / 100
  }
  if (!Number.isFinite(factor) || factor <= 0 || factor >= 1) return undefined

  const peak = []
  const re = /([0-9]{1,2}):([0-9]{2})\s*[–\-—~至]\s*([0-9]{1,2}):([0-9]{2})/g
  let m
  while ((m = re.exec(text)) !== null) {
    peak.push([Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])])
  }
  if (peak.length === 0) return undefined

  const weekdayOnly = /周[一二三四五]至周[一二三四五]|工作日|weekday/i.test(text)
  return { ids, factor, peak, weekdayOnly, tz: promo?.schedule?.timezone }
}

/**
 * 按指定时区取「今天是周几」和「现在是当天第几分钟」。
 *
 * 为什么不能直接用 `new Date().getHours()`：上游促销规则里带着
 * `schedule.timezone: Asia/Shanghai`，而插件跑在设备本地时区上。设备时区
 * 一旦不是东八区（模拟器默认 UTC、用户出差改时区、容器里 TZ 没设），
 * 高峰与低谷就会整体判反 —— 明明是高峰却显示「谷 5 折」。
 * 实测 TZ=UTC 时 4 个时段判反 3 个。
 *
 * 没有时区或时区名非法时退回设备本地时区，行为与旧版一致。
 */
function zonedClock(tz, now = new Date()) {
  const fallback = { dow: now.getDay(), mins: now.getHours() * 60 + now.getMinutes() }
  if (!tz || typeof tz !== 'string') return fallback
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    })
    const bag = {}
    for (const p of fmt.formatToParts(now)) bag[p.type] = p.value
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const dow = dowMap[bag.weekday]
    // en-US + hour12:false 在午夜会给出 "24"，归一成 0
    const hh = Number(bag.hour) % 24
    const mm = Number(bag.minute)
    if (dow === undefined || !Number.isFinite(hh) || !Number.isFinite(mm)) return fallback
    return { dow, mins: hh * 60 + mm }
  } catch {
    return fallback
  }
}

function inPeakWindow(rule, now) {
  const { dow, mins } = zonedClock(rule.tz, now)
  if (rule.weekdayOnly && (dow === 0 || dow === 6)) return false
  return rule.peak.some(([s, e]) => mins >= s && mins < e)
}

function inDailyWindow(schedule) {
  if (!schedule) return true
  const now = new Date()
  if (schedule.validFrom && now < new Date(schedule.validFrom)) return false
  if (schedule.validUntil && now >= new Date(schedule.validUntil)) return false
  if (!Array.isArray(schedule.daily) || schedule.daily.length === 0) return true
  // 与峰谷同源：daily 时段按规则自带的时区判断，不跟设备时区走。
  const { mins } = zonedClock(schedule.timezone, now)
  for (const win of schedule.daily) {
    const [sh, sm] = String(win.start || '0:0').split(':').map(Number)
    const [eh, em] = String(win.end || '0:0').split(':').map(Number)
    const s = sh * 60 + (sm || 0)
    const e = eh * 60 + (em || 0)
    if (s <= e) {
      if (mins >= s && mins < e) return true
    } else if (mins >= s || mins < e) {
      return true
    }
  }
  return false
}

function promosFor(modelId) {
  const region = st.region[modelId]
  const own = region ? st.promos[region] ?? [] : []
  const other = region === 'cn' ? st.promos.global ?? [] : st.promos.cn ?? []
  return [...own, ...other]
}

/**
 * 带缓存的峰谷判定。
 *
 * 峰谷只跟「时刻」和「模型」有关，两者都没变就没有重算的必要。
 * 复用条件有两个，任一不满足就重算：
 *   - 模型换了
 *   - 现在已过上次算出的 nextChangeAt
 */
/**
 * 带缓存的「外部渠道」峰谷（DeepSeek 官方）。
 *
 * 与 discountStateCached 同一思路：规则是静态的，时刻没越过边界就不用重算。
 * 单独一份缓存键（provider 而不是 model），因为这类规则按渠道生效。
 */
function externalDiscountCached() {
  const now = Date.now()
  const c = st.extCache
  if (c && c.provider === st.provider && now < c.until) return c.result

  const result = externalDiscount()
  const boundary = result?.nextChangeAt
  const until = (typeof boundary === 'number' && boundary > now + 1_000)
    ? boundary
    : now + 10 * 60_000
  st.extCache = { provider: st.provider, until, result }
  return result
}

function discountStateCached(modelId) {
  const now = Date.now()
  const c = st.discCache
  if (c && c.model === modelId && now < c.until) return c.result

  const result = discountState(modelId)
  // 保护：nextChangeAt 必须严格晚于现在才拿来当过期时刻。
  // 万一算出的是过去（时段数据异常、系统时间被改动），退回 10 分钟兜底，
  // 否则缓存一写入就过期，每 5 秒重算一次，等于没有缓存。
  const boundary = result?.nextChangeAt
  const until = (typeof boundary === 'number' && boundary > now + 1_000)
    ? boundary
    : now + 10 * 60_000
  st.discCache = { model: modelId, until, result }
  return result
}

/**
 * 算出「下一次峰谷切换」的绝对时刻。
 *
 * 峰谷是固定时段（例如工作日 09:00–12:00、14:00–18:00 为峰），所以当前处于
 * 谷还是峰、以及这个状态会持续到几点，都是可以一次算清的。算出边界后，
 * 只要还没到那个时刻，就完全不用重新判断 —— 这正是用户提的「知道在谷底就
 * 一直显示谷」。
 *
 * 做法：把今天和明天所有边界（start 和 end）转成绝对时间戳，取第一个大于
 * 「现在」的。跨天与周末都在这里一并处理。
 *
 * @param {number[]} peaks 分钟区间数组，如 [[540,720],[840,1080]]
 * @param {boolean} weekdayOnly 是否只在工作日生效
 * @returns {number|undefined} 下一个边界的时间戳
 */
function toMins(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/**
 * 指定时区相对 UTC 的偏移（毫秒，东区为正）。
 *
 * 用 Intl 把某一时刻在该时区的墙上时间读出来，再当作 UTC 拼回去，两者之差
 * 就是偏移。这样不依赖设备时区，也不用维护夏令时表。
 */
function tzOffsetMs(tz, date) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const bag = {}
    for (const p of fmt.formatToParts(date)) bag[p.type] = p.value
    const asUTC = Date.UTC(
      Number(bag.year), Number(bag.month) - 1, Number(bag.day),
      Number(bag.hour) % 24, Number(bag.minute), Number(bag.second),
    )
    if (!Number.isFinite(asUTC)) return 0
    return asUTC - date.getTime()
  } catch {
    return 0
  }
}

function nextPeakBoundary(peaks, weekdayOnly, tz) {
  if (!Array.isArray(peaks) || peaks.length === 0) return undefined
  const now = new Date()
  // 有时区时，在「该时区的墙上时间」里算边界，最后再换算回绝对时刻。
  // 旧版直接用设备本地时区算，设备时区一变，边界就跟着错。
  const offset = tz ? tzOffsetMs(tz, now) : 0
  const shifted = new Date(now.getTime() + offset)
  const candidates = []
  // 看未来 8 天。为什么不是 3 天：周五晚上算边界时，周六周日都是周末被
  // 跳过，下周一落在第 3 天之外 → 算不出来 → 退回 10 分钟兜底，白算一整晚。
  // 8 天能跨过周末，也能覆盖「国庆」这类连续假期前后的工作日前移。
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const day = new Date(shifted.getTime())
    day.setUTCDate(day.getUTCDate() + dayOffset)
    const dow = day.getUTCDay()
    if (weekdayOnly && (dow === 0 || dow === 6)) continue
    for (const [startMin, endMin] of peaks) {
      for (const mins of [startMin, endMin]) {
        const t = new Date(day.getTime())
        t.setUTCHours(0, 0, 0, 0)
        t.setUTCMinutes(mins)
        const abs = t.getTime() - offset
        if (abs > now.getTime()) candidates.push(abs)
      }
    }
  }
  if (candidates.length === 0) return undefined
  return Math.min(...candidates)
}

/** 峰谷状态；undefined = 拿不到依据。 */
function discountState(modelId) {
  const base = st.rates[modelId]
  if (base === undefined) return undefined

  const now = new Date()
  let best
  let bestRule
  let sawTimed = false

  for (const promo of promosFor(modelId)) {
    if (promo?.enabled === false) continue
    const ids = Array.isArray(promo.modelIds) ? promo.modelIds : []
    if (!ids.includes(modelId)) continue

    const factor = promo?.discount?.factor
    if (typeof factor === 'number') {
      if (inDailyWindow(promo.schedule)) {
        const rate = base * factor
        if (best === undefined || rate < best) {
          best = rate
          const sched = promo.schedule
          // 有 daily → 按每日时段算边界；只有绝对有效期 → 用 validUntil
          let absolute
          if (!Array.isArray(sched?.daily) || sched.daily.length === 0) {
            if (sched?.validUntil) absolute = new Date(sched.validUntil).getTime()
          }
          bestRule = {
            source: 'factor',
            label: promo?.badge?.label,
            daily: sched?.daily,
            absolute,
            tz: sched?.timezone,
          }
        }
      }
      continue
    }

    const rule = parseTextRule(promo)
    if (!rule || !rule.ids.includes(modelId)) continue
    sawTimed = true
    if (!inPeakWindow(rule, now)) {
      const rate = base * rule.factor
      if (best === undefined || rate < best) {
        best = rate
        bestRule = { source: 'text', label: promo?.badge?.label, peak: rule.peak, tz: rule.tz }
      }
    } else if (bestRule === undefined) {
      const sched = promo.schedule
      const hasDaily = Array.isArray(sched?.daily) && sched.daily.length > 0
      const absolute = !hasDaily && sched?.validUntil ? new Date(sched.validUntil).getTime() : undefined
      bestRule = { source: 'text', label: promo?.badge?.label, peak: rule.peak, absolute, tz: rule.tz }
    }
  }

  // 把「下一次切换时刻」一起算出来，调用方据此避免重复判断。
  // 三种规则形态的边界来源不同，分别处理：
  //   ① 结构化折扣 + daily 时段（GLM-5.2 夜间 23:00–7:50 五折）
  //      → 边界就是 daily 里的 start / end
  //   ② 文字规则带高峰时段（DeepSeek「工作日 9-12、14-18 高峰」）
  //      → 边界是文案里解析出的高峰 start / end
  //   ③ 绝对有效期（Space Bunny 10/2–10/7）
  //      → 边界是 validFrom / validUntil
  let nextChangeAt
  if (bestRule?.source === 'factor' && Array.isArray(bestRule.daily) && bestRule.daily.length > 0) {
    const win = bestRule.daily.map((w) => [toMins(w.start), toMins(w.end)])
    nextChangeAt = nextPeakBoundary(win, false, bestRule.tz)
  } else if (bestRule?.peak) {
    nextChangeAt = nextPeakBoundary(bestRule.peak, true, bestRule.tz)
  } else if (bestRule?.absolute) {
    nextChangeAt = bestRule.absolute
  }

  if (best !== undefined && best < base) return { kind: 'valley', base, rate: best, rule: bestRule, nextChangeAt }
  if (sawTimed) return { kind: 'peak', base, rate: base, rule: bestRule, nextChangeAt }
  return { kind: 'flat', base, rate: base, rule: bestRule, nextChangeAt }
}

/** DeepSeek 官方等外部渠道的峰谷（静态规则）。 */
function externalDiscount() {
  const p = st.provider
  if (!p || p.startsWith('workbuddy') || p.includes('our-free-model')) return undefined

  // 按 provider 查峰谷规则表；只认明确的官方名，中转站不匹配（避免报错价）。
  const normalized = p.toLowerCase().replace(/^custom-/, '').replace(/^official-/, '')
  const rule = OFFPEAK_RULES.find((r) => r.match.test(normalized))
  if (!rule) return undefined

  const now = new Date()
  const weekend = now.getUTCDay() === 0 || now.getUTCDay() === 6
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes()
  const isPeak = !(rule.weekdayOnly && weekend)
    && rule.peakUtc.some(([s, e]) => mins >= s && mins < e)

  return {
    kind: isPeak ? 'peak' : 'valley',
    factor: rule.factor,
    weekend,
    label: rule.label,
    source: rule.source,
    checkedAt: rule.checkedAt,
    peakUtc: rule.peakUtc,
    // 下次切换的绝对时刻，同样用于缓存（按 UTC 算边界）
    nextChangeAt: nextUtcPeakBoundary(rule.peakUtc, rule.weekdayOnly),
  }
}

/**
 * DeepSeek 官方规则的下一次切换时刻。
 *
 * 与 {@link nextPeakBoundary} 同思路，但它的时段是 **UTC**：文档原文就是
 * UTC，用本地时区算会在换时区或跨时区机器上偏。所以这里全部按 UTC 分量
 * 计算候选时间戳。
 */
function nextUtcPeakBoundary(peaks, weekdayOnly) {
  if (!Array.isArray(peaks) || peaks.length === 0) return undefined
  const now = Date.now()
  const nowDate = new Date(now)
  const candidates = []
  // 同样取 8 天，理由见 nextPeakBoundary：周末会把 3 天窗口填满却一个也
  // 不命中，导致跨周末时算不出边界。
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const day = new Date(nowDate)
    day.setUTCDate(day.getUTCDate() + dayOffset)
    const dow = day.getUTCDay()
    if (weekdayOnly && (dow === 0 || dow === 6)) continue
    for (const [startMin, endMin] of peaks) {
      for (const m of [startMin, endMin]) {
        const t = Date.UTC(
          day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(),
          Math.floor(m / 60), m % 60, 0, 0,
        )
        if (t > now) candidates.push(t)
      }
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : undefined
}

async function readLocalCatalog() {
  const path = join(dshHome(), 'profiles', 'web', 'cordis.patch.yml')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return false
  }
  const at = text.indexOf('id: dsh-connect-workbuddy')
  if (at < 0) return false
  const tail = text.slice(at)

  const rates = /** @type {Record<string, number>} */ ({})
  const names = /** @type {Record<string, string>} */ ({})
  const region = /** @type {Record<string, string>} */ ({})
  const ids = /** @type {string[]} */ ([])
  let found = 0

  for (const reg of ['cn', 'global']) {
    const regAt = tail.indexOf('\n      ' + reg + ':')
    if (regAt < 0) continue
    const catAt = tail.indexOf('lastCatalog:', regAt)
    if (catAt < 0) continue
    const stop = tail.indexOf('\n        enabledModelIds:', catAt)
    const chunk = tail.slice(catAt, stop > 0 ? stop : catAt + 60_000)

    const re = /^          - id: (\S+)$/gm
    const starts = []
    let m
    while ((m = re.exec(chunk)) !== null) starts.push([m.index, m[1]])
    for (let k = 0; k < starts.length; k++) {
      const [idx, id] = starts[k]
      const end = k + 1 < starts.length ? starts[k + 1][0] : chunk.length
      const seg = chunk.slice(idx, end)
      const cm = seg.match(/^            creditMultiplier: ([0-9.]+)$/m)
      if (!cm) continue
      const nm = seg.match(/^            name: (.+)$/m)
      if (!(id in region)) {
        region[id] = reg
        ids.push(id)
        if (nm) names[id] = nm[1].trim()
      }
      if (reg === 'cn' || rates[id] === undefined) rates[id] = Number(cm[1])
      found++
    }
  }

  if (found === 0) return false
  st.rates = rates
  st.names = names
  st.region = region
  st.ids = ids
  return true
}

async function refreshConfig(force, forceToken = false) {
  const now = Date.now()
  if (force || forceToken) {
    await tokenOf('cn', true)
    await tokenOf('global', true)
  }
  if (!force && now - st.cfgAt < CONFIG_MS) return

  const rates = /** @type {Record<string, number>} */ ({})
  const names = /** @type {Record<string, string>} */ ({})
  const region = /** @type {Record<string, string>} */ ({})
  const ids = /** @type {string[]} */ ([])
  const promos = { cn: /** @type {any[]} */ ([]), global: /** @type {any[]} */ ([]) }

  for (const [name, base] of [['cn', CN], ['global', GLOBAL]]) {
    try {
      const cfg = await postWithRetryGet(name, '/v3/config')
      const data = cfg?.data ?? {}
      for (const m of data.models ?? []) {
        if (!m?.id) continue
        if (region[m.id] === undefined) {
          if (typeof m.name === 'string') names[m.id] = m.name
          region[m.id] = name
          ids.push(m.id)
        }
        const raw = m.credits
        if (typeof raw !== 'string') continue
        const num = Number(raw.replace(/^x/i, '').replace(/\s*credits$/i, ''))
        if (!Number.isFinite(num)) continue
        if (name === 'cn' || rates[m.id] === undefined) rates[m.id] = num
      }
      if (Array.isArray(data.modelPromotions)) promos[name] = data.modelPromotions
    } catch {
      // 单区域失败不影响另一个
    }
  }

  if (ids.length === 0 && await readLocalCatalog()) {
    st.cfgAt = now
    st.degraded = false
    st.degradedAt = 0
    return
  }

  // 有模型 id、但一个倍率都没拿到 → 上游没给价格（UA 被降级、或接口改了形态）。
  // 记下时间，面板据此说明「峰谷为什么是空的」，不再无声无息。
  const rateCount = Object.keys(rates).length
  st.degraded = ids.length > 0 && rateCount === 0
  st.degradedAt = st.degraded ? now : 0

  st.rates = rates
  st.names = names
  st.region = region
  st.ids = ids
  st.promos = promos
  st.cfgAt = now
}

/** /v3/config 是 GET，单独包一层（带 401 重试）。 */
async function postWithRetryGet(region, path) {
  let token = await tokenOf(region)
  if (!token) return undefined
  const base = region === 'cn' ? CN : GLOBAL
  try {
    return await fetchJson(base, path, token)
  } catch (first) {
    if (!authExpired(first)) throw first
    token = await tokenOf(region, true)
    if (!token) return undefined
    return await fetchJson(base, path, token)
  }
}

async function refreshBusy(force) {
  const now = Date.now()
  const idle = now - st.activeAt
  // 首轮（还没成功拉到过任何数据）必须查一次，不受间隔限制
  if (!force && st.primed && now - st.busyAt < intervalOf(BUSY_STEPS, idle)) return

  // 上游单次最多接收 50 个模型 id。之前只取 `slice(0, 50)`，而 hy4flash
  // 在目录里排第 57 位 → 从没被查询过 → 拥堵永远显示「没数据」。
  // 现在按 50 个一批发多次请求，覆盖全部模型（58 个 = 2 批）。
  const all = st.ids.filter((id) => st.region[id] === 'cn')
  if (all.length === 0) return
  try {
    const busy = /** @type {Record<string, string>} */ ({})
    for (let i = 0; i < all.length; i += 50) {
      const batch = all.slice(i, i + 50)
      const ans = await postWithRetry('cn', '/v2/chat/busy', JSON.stringify({ models: batch }))
      for (const row of ans?.data ?? []) {
        if (row?.model && row?.busy_level) busy[row.model] = String(row.busy_level)
      }
    }
    st.busy = busy
    st.busyAt = now
    st.primed = true
  } catch {
    // 探针失败保留上次
  }
}

async function refreshCredits(force, forceToken = false) {
  const now = Date.now()
  const region = regionOf()

  // 区域变了（国内版↔国际版）就必须立刻重查：缓存里存的是**另一个区域**的
  // 余额，直接返回会把旧数字一直显示到 TTL 到期 —— 那正是「切了国际版还
  // 显示国内版积分」的原因。
  const regionChanged = region !== st.creditRegion
  if (force || forceToken || regionChanged) {
    await tokenOf('cn', true)
    await tokenOf('global', true)
  }
  // 区域切换（含切到非 WorkBuddy）时清掉旧区域的拥堵数据。
  // busy map 只来自国内版接口，切到国际版/智谱后若留着，compose 里虽然
  // 有 provider 守卫不会显示，但面板和用户态仍可能短暂读到旧值 —— 清掉更干净。
  if (regionChanged) {
    st.busy = {}
    st.busyAt = 0
  }
  const idle = now - st.activeAt
  // 首轮必须查：否则打开 App 看到的是空值或旧值
  if (!force && st.primed && !regionChanged && now - st.creditAt < intervalOf(CREDIT_STEPS, idle)) return

  st.creditRegion = region
  if (region === '') {
    st.total = 0
    st.packages = []
    st.checkin = null
    st.creditAt = now
    return
  }

  try {
    const bal = await postWithRetry(region, '/v2/billing/meter/get-user-resource')
    const accounts = bal?.data?.Response?.Data?.Accounts ?? []
    let total = 0
    for (const a of accounts) total += Number(a.CycleCapacityRemain ?? a.CapacityRemain ?? 0)
    st.total = total
    st.packages = accounts.map((a) => ({
      name: String(a.PackageName || ''),
      size: Number(a.CapacitySize || 0),
      used: Number(a.CycleCapacityUsed ?? a.CapacityUsed ?? 0),
      remain: Number(a.CycleCapacityRemain ?? a.CapacityRemain ?? 0),
      until: String(a.CycleEndTime || a.ExpiredTime || ''),
    }))
  } catch {
    // 保留上次
  }

  try {
    const ci = await postWithRetry(region, '/v2/billing/meter/checkin-activity-status')
    const d = ci?.data ?? null
    st.checkin = d === null ? null : {
      active: d.active === true,
      checkedToday: d.today_checked_in === true,
      daily: Number(d.daily_credit || 0),
      streak: Number(d.streak_days || 0),
      bonus: Number(d.credit_bonus ?? d.streak_bonus_credit ?? 0),
    }
  } catch {
    st.checkin = null
  }

  st.creditAt = now
  st.primed = true
}

/** 明天签到后的总积分；签到没开返回 undefined。 */
function tomorrowTotal() {
  const ci = st.checkin
  if (!ci || ci.active !== true || ci.daily <= 0) return undefined
  // 国际版的签到活动已下线（active=false），即使 daily_credit 有值也不算。
  // 这里再按区域兜一层，防止上游哪天把 active 又写成 true 但实际签不到。
  if (st.creditRegion === 'global') return undefined
  return st.total + ci.daily
}

function busyLabel(level) {
  switch (level) {
    case 'idle': return '空闲'
    case 'normal': return '正常'
    case 'busy': return '轻微拥堵'
    case 'congested': return '极度拥堵'
    default: return ''
  }
}

function busyTone(level) {
  switch (level) {
    case 'idle':
    case 'normal': return 'good'
    case 'busy': return 'warn'
    case 'congested': return 'bad'
    default: return undefined
  }
}

/**
 * 把三项合成一句话，一次显示完。
 *
 * 为什么不再轮转：App 自己会在插件之间轮转（pulse → root桥 → pulse …），
 * 插件内部再轮转就变成两层叠加，观感是「谷 → 空闲 → root桥 → 积分」四段
 * 交错。合成一句后 App 只剩两段：这句话 ↔ root桥，顺序稳定。
 *
 * 缺项直接略过（不写「无」）。颜色按严重程度取一个：拥堵红 > 峰红 >
 * 轻微拥堵黄 > 谷绿 > 默认 —— 一条状态条只能有一种颜色，取最该被注意的那个。
 */
function compose() {
  const id = resolveModelId()
  const parts = []
  let tone

  // 关键：只有 provider 真的是 workbuddy* 时，才把这些读数当作 WorkBuddy 的。
  // 智谱的 glm-5.3-flash 与 WorkBuddy 国内版目录里的模型**同名**，之前会被
  // 误认成国内版模型，于是显示本不属于它的峰谷/拥堵/积分。
  const isWorkBuddy = st.provider.startsWith('workbuddy')
  const wbRegion = isWorkBuddy ? (st.provider.includes('global') ? 'global' : 'cn') : ''

  // 非 WorkBuddy 渠道：只剩外部静态规则（DeepSeek 官方错峰）可能生效，
  // 其余一段都不显示。
  const isGlobal = wbRegion === 'global'

  // 峰谷（仅 WorkBuddy 国内版查目录；外部渠道走静态规则；国际版跳过）
  const disc = (wbRegion === 'cn') ? discountStateCached(id) : undefined
  const ext = isGlobal ? undefined : (disc === undefined ? externalDiscountCached() : undefined)

  // 外部官方 API：余额替换峰谷位（用户要求）。
  // 有峰谷机制（DeepSeek 官方错峰）就「峰/谷 + 余额」一起显示；
  // 没有峰谷机制就只显示余额。余额绿色，峰红谷绿。
  const apiKey = apiKeyNameFor(st.provider)
  const bal = apiKey ? st.apiBalance : null
  const balText = bal && bal.provider === st.provider && bal.cny !== undefined ? bal.cny : undefined

  if (apiKey) {
    // 峰谷段（如果有）
    if (ext !== undefined) {
      if (ext.kind === 'valley') {
        parts.push('谷 • ' + (ext.factor * 10) + ' 折')
        tone = 'good'
      } else {
        parts.push('峰 • 原价')
        if (tone === undefined) tone = 'bad'
      }
    }
    // 余额段着色：无额度红 > 限流黄 > 可用绿
    if (balText !== undefined) {
      parts.push(balText)
      if (/无额度|已用完/.test(balText)) tone = 'bad'
      else if (/限流/.test(balText)) {
        if (tone !== 'bad') tone = 'warn'
      } else if (tone === undefined || tone === 'good') tone = 'good'
    }
  } else if (disc !== undefined && disc.kind === 'valley') {
    parts.push('谷 • ' + disc.rate.toFixed(2))
    tone = 'good'
  } else if (disc !== undefined && disc.kind === 'peak') {
    parts.push('峰 • ' + disc.base.toFixed(2))
    tone = 'bad'
  } else if (disc === undefined && ext !== undefined) {
    if (ext.kind === 'valley') {
      parts.push('谷 • ' + (ext.factor * 10) + ' 折')
      tone = 'good'
    } else {
      parts.push('峰 • 原价')
      tone = 'bad'
    }
  }

  // 拥堵
  const level = st.busy[id]
  if (wbRegion === 'cn' && JAM_LEVELS.has(level)) {
    parts.push(busyLabel(level))
    const jt = busyTone(level)
    // 红 > 黄 > 绿；只有当前没有更强信号时才设绿
    if (jt === 'bad') tone = 'bad'
    else if (jt === 'warn' && tone !== 'bad') tone = 'warn'
    else if (jt === 'good' && tone === undefined) tone = 'good'
  }

  // 积分：统一写成「积分:xxx」。国内/国际版一致；明日预计只在面板里保留，状态条不显示。
  // 积分归零也要显示（0 是有效状态，直接隐藏会让人以为插件坏了）
  if (isWorkBuddy && st.creditRegion !== '') {
    const next = tomorrowTotal()
    if (st.creditRegion === 'global') {
      // 国际版单独方案：没有签到、没有拥堵、没有峰谷，只报一个实时余额。
      parts.push('积分 • ' + st.total)
      if (tone === undefined) tone = 'good'
    } else {
      // 国内版：与国际版统一为「积分:xxx」，不显示明日预计。
      parts.push('积分 • ' + st.total)
      // 积分 0 = 用不了，红色警示（优先级高于拥堵的黄色）
      if (st.total <= 0) tone = 'bad'
      else if (tone === undefined) tone = 'good'
    }
  }

  if (parts.length === 0) return null
  // 24 字上限：超了就先砍积分那一段（它最不紧急）
  // 超长时的降级顺序：先去掉「(明xxx)」只留当前积分，再整段去掉积分。
  // 这样「预计」被牺牲，当前余额尽量保住。
  let text = parts.join(' • ')
  if (text.length > 24) {
    for (let i = 0; i < parts.length; i++) {
      const stripped = parts[i].replace(/\s*•\s*\(明\d+\)$/, '')
      if (stripped !== parts[i]) {
        const trial = [...parts]
        trial[i] = stripped
        const t = trial.join(' • ')
        if (t.length <= 24) {
          parts[i] = stripped
          text = t
          break
        }
      }
    }
  }
  while (text.length > 24 && parts.length > 1) {
    parts.pop()
    text = parts.join(' • ')
  }
  return { text: text.slice(0, 24), tone }
}

function pad(mins) {
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0')
}

export const name = 'dsh-model-pulse'

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.strip('pulse', (scope, emit) => {
      let stopped = false
      const sessionId = scope?.sessionId

      const paint = (force = false) => {
        if (stopped) return
        const c = compose()
        if (c === null) {
          // 三项都没数据 → 整条隐藏
          if (st.lastText !== '' || force) {
            st.lastText = ''
            st.lastTone = ''
            emit({ text: null })
          }
          return
        }
        const tone = c.tone ?? ''
        // force 用于模型切换：即使文本恰好相同（比如两个模型都「空闲」），
        // 也要重新 emit 一次，让 App 立刻感知到读数已属于新模型。
        if (!force && c.text === st.lastText && tone === st.lastTone) return
        st.lastText = c.text
        st.lastTone = tone
        emit({
          text: c.text,
          icon: 'chart',
          ...(tone === '' ? {} : { tone }),
        })
      }

      let running = false
      const tick = async () => {
        if (stopped) return
        // 模型检测不受 running 锁阻挡：即使上一轮网络还没回来，
        // 也要先检测切换并把旧读数从屏幕上抹掉。
        const flipped = await readCurrentModel(sessionId)
        if (flipped) {
          st.activeAt = Date.now()
          // 切换瞬间：先让旧读数彻底消失
          st.lastText = ''
          st.lastTone = ''
          emit({ text: null })

          // 三个数据源并行拉取，全部到齐后一次性显示。
          // 之前 150ms 就先画：峰谷读本地缓存很快、拥堵要发网络请求，
          // 结果「峰谷先出、拥堵后补」，时序错位。改为 Promise.all 并行，
          // 既最快，又保证三项同步出现。
          ;(async () => {
            if (running) return
            running = true
            try {
              await Promise.all([
                refreshConfig(false, true),
                refreshBusy(true),
                refreshCredits(true, true),
                refreshApiBalance(true),
              ])
              if (!stopped) paint(true)
            } finally {
              running = false
            }
          })()
          return
        }

        // 正常轮次：上一轮没跑完就跳过，避免请求堆叠
        if (running) return
        running = true
        try {
          await refreshConfig(false, false)
          await refreshBusy(false)
          await refreshCredits(false, false)
          await refreshApiBalance(false)
          if (stopped) return
          paint()
        } finally {
          running = false
        }
      }

      void tick()
      // 只有一个定时器：数据与显示同步更新，不存在两层轮转
      const timer = setInterval(() => void tick(), MODEL_MS)
      return () => {
        stopped = true
        clearInterval(timer)
      }
    })

    ctx.dshGo.panel('pulse-panel', {
      view: () => ({
        type: 'stack',
        title: 'WorkBuddy 脉搏',
        children: [
          {
            type: 'keyValue',
            items: [
              ['当前模型', { $: 'data.cur' }],
              ['峰谷期', { $: 'data.valley' }],
              ['拥堵状态', { $: 'data.jam' }],
              ['余额 / 积分', { $: 'data.credits' }],
              ['判定依据', { $: 'data.basis' }],
            ],
          },
          { type: 'table', columns: ['积分包', '剩余', '已用', '到期'], rows: { $: 'data.pkgs' } },
          { type: 'text', text: { $: 'data.hint' }, tone: 'muted' },
          { type: 'actions', items: [{ label: '刷新', action: 'reload' }] },
        ],
      }),
      data: (scope, emit) => {
        let stopped = false
        st.activeAt = Date.now()   // 打开面板算一次操作，接下来几分钟密集刷新
        const push = async () => {
          if (stopped) return
          await readCurrentModel(scope?.sessionId)
          await refreshConfig(false)
          await refreshBusy(false)
          // 不能传 true：那是「强制」，会绕过节流。打开面板时 activeAt 已重置，
          // 首轮自然走密集间隔；后续按 CREDIT_STEPS 退避。
          await refreshCredits(false)
          await refreshApiBalance(false)
          if (stopped) return

          const id = resolveModelId()
          const isWorkBuddy = st.provider.startsWith('workbuddy')
          const disc = discountStateCached(id)
          const ext = disc === undefined ? externalDiscountCached() : undefined

          const valley = disc !== undefined
            ? (disc.kind === 'valley' ? '谷 x' + disc.rate.toFixed(2) + '（省钱中）'
              : disc.kind === 'peak' ? '峰 x' + disc.base.toFixed(2) + '（高峰原价）'
              : '无（该模型没有分时折扣）')
            : ext !== undefined
              ? (ext.kind === 'valley' ? '谷 • ' + ext.factor * 10 + ' 折（错峰优惠中）' : '峰 • 原价（高峰时段）')
              : (st.degraded && isWorkBuddy)
                // 有模型、没倍率：上游没给价格（UA 被降级或接口改形态）。
                // 必须同时是 WorkBuddy 渠道才这么说 —— 否则拿 Moonshot、
                // 智谱这些本来就没有 WorkBuddy 目录的渠道，也会被提示
                // 「上游目录没返回倍率」，那是误报。
                ? '无（上游目录没返回倍率，拿不到折扣依据）'
                : '无（该渠道没有公开的分时规则）'

          const level = st.busy[id]
          const isGlobal = st.region[id] === 'global'
          const jam = isGlobal ? '无（国际版没有队列接口）'
            : JAM_LEVELS.has(level) ? busyLabel(level)
            : '无（上游没给这个模型的队列数据）'

          const next = tomorrowTotal()
          let credits
          if (st.creditRegion === '') {
            // 官方 API 渠道：显示余额；tokenSuffix 在 emit 前拼上
            const apiBal = apiKeyNameFor(st.provider) ? st.apiBalance : null
            credits = (apiBal && apiBal.provider === st.provider && apiBal.cny !== undefined)
              ? apiBal.cny : '无可用余额接口'
          } else {
            credits = String(st.total) + (next === undefined ? '（签到未开启）' : '，明日签到后 ' + next)
          }

          let basis
          if (disc !== undefined) {
            if (disc.kind === 'flat') basis = '目录里没有作用于它的折扣规则'
            else if (disc.rule?.source === 'factor') basis = '结构化折扣 ' + (disc.rule.label || '') + '（schedule 命中）'
            else if (disc.rule?.source === 'text') {
              const w = (disc.rule.peak || []).map(([s, e]) => pad(s) + '–' + pad(e)).join('、')
              basis = '上游文案规则：高峰 ' + w + '，此刻' + (disc.kind === 'peak' ? '在峰内' : '在峰外')
            } else basis = '—'
          } else if (ext !== undefined) {
            const w = ext.peakUtc.map(([s, e]) => pad(s) + '–' + pad(e) + ' UTC').join('、')
            basis = ext.label + '（静态表，核对于 ' + ext.checkedAt + '）：高峰 ' + w
              + '，此刻' + (ext.kind === 'peak' ? '在峰内' : '在峰外')
              + (ext.weekend ? '；周末全时段错峰' : '')
          } else basis = '该模型既不在 WorkBuddy 目录，该渠道也没有公开的分时规则'

          // 本对话 token 消耗：并进「余额/积分」同一栏，只给非 WorkBuddy 渠道。
          // WorkBuddy 有积分读数，不重复显示 token，避免那一栏太长。
          let tokenSuffix = ''
          if (!isWorkBuddy) {
            const ts = await sessionTokenStat(scope?.sessionId, st.provider + '/' + st.model)
            if (ts && ts.calls > 0) {
              tokenSuffix = `；本对话 Token 输入 ${fmtTokens(ts.input)} · 输出 ${fmtTokens(ts.output)} · 缓存 ${fmtTokens(ts.cacheRead)}（${ts.calls} 次）`
            }
          }

          credits = credits + tokenSuffix
          emit({
            cur: (st.names[id] || id || '未知') + (st.provider ? ' · ' + st.provider : ''),
            valley,
            jam,
            credits,
            basis,
            pkgs: st.packages.length > 0
              ? st.packages.map((p) => [p.name, String(p.remain), String(p.used), p.until || '—'])
              : [['—', '—', '—', '—']],
            hint: '峰谷＝积分折扣时段（贵不贵）；拥堵＝排队人数（快不快），两者无关。数据来自官方接口；闲置时会自动拉长查询间隔省电，切模型或开面板立即刷新。',
          })
        }
        void push()
        // 不用固定 setInterval：面板可能开很久，间隔要随时长退避。
        // 每轮结束后按当前空闲时长重排下一次。
        let timer
        const schedule = () => {
          if (stopped) return
          const ms = intervalOf(CREDIT_STEPS, Date.now() - st.activeAt)
          timer = setTimeout(async () => {
            await push()
            schedule()
          }, ms)
        }
        schedule()
        return () => {
          stopped = true
          if (timer) clearTimeout(timer)
        }
      },
      actions: {
        reload: async () => {
          await refreshConfig(true, true)
          await refreshBusy(true)
          await refreshCredits(true, true)
          st.lastText = ''
          return { refresh: true, toast: '已刷新' }
        },
      },
    })
  })
}
