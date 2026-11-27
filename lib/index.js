/**
 * WorkBuddy 脉搏 —— 一条状态条，三帧轮转：峰谷期 → 拥堵状态 → 积分。
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
 *   积分    504 · 明日604（默认色） / 非 WorkBuddy 渠道 → 跳过
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
const DEEPSEEK_OFFPEAK = {
  peakUtc: [[1 * 60, 4 * 60], [6 * 60, 10 * 60]],
  weekdayOnly: true,
  factor: 0.5,
  label: 'DeepSeek 错峰优惠',
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  checkedAt: '2026-11-27',
}

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

  busy: /** @type {Record<string, string>} */ ({}),
  busyAt: 0,

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
const LOG_MARK = /"type":"model\/selection"[^\n]*"data":\{"provider":"([^"]+)","model":"([^"]+)"/

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
      const m = LOG_MARK.exec(line)
      if (m) { result = { provider: m[1], model: m[2], at: info.mtimeMs }; break }
    }
  } catch {
    // 解压或读取失败：交给投影缓存兜底
  }

  logCache.key = key
  logCache.file = found.file
  logCache.result = result
  return result
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
  return { ids, factor, peak, weekdayOnly }
}

function inPeakWindow(rule, now) {
  if (rule.weekdayOnly && (now.getDay() === 0 || now.getDay() === 6)) return false
  const mins = now.getHours() * 60 + now.getMinutes()
  return rule.peak.some(([s, e]) => mins >= s && mins < e)
}

function inDailyWindow(schedule) {
  if (!schedule) return true
  const now = new Date()
  if (schedule.validFrom && now < new Date(schedule.validFrom)) return false
  if (schedule.validUntil && now >= new Date(schedule.validUntil)) return false
  if (!Array.isArray(schedule.daily) || schedule.daily.length === 0) return true
  const mins = now.getHours() * 60 + now.getMinutes()
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

function nextPeakBoundary(peaks, weekdayOnly) {
  if (!Array.isArray(peaks) || peaks.length === 0) return undefined
  const now = new Date()
  const candidates = []
  // 看未来 8 天。为什么不是 3 天：周五晚上算边界时，周六周日都是周末被
  // 跳过，下周一落在第 3 天之外 → 算不出来 → 退回 10 分钟兜底，白算一整晚。
  // 8 天能跨过周末，也能覆盖「国庆」这类连续假期前后的工作日前移。
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const day = new Date(now)
    day.setDate(day.getDate() + dayOffset)
    const dow = day.getDay()
    if (weekdayOnly && (dow === 0 || dow === 6)) continue
    for (const [startMin, endMin] of peaks) {
      for (const mins of [startMin, endMin]) {
        const t = new Date(day)
        t.setHours(0, 0, 0, 0)
        t.setMinutes(mins)
        if (t.getTime() > now.getTime()) candidates.push(t.getTime())
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
        bestRule = { source: 'text', label: promo?.badge?.label, peak: rule.peak }
      }
    } else if (bestRule === undefined) {
      const sched = promo.schedule
      const hasDaily = Array.isArray(sched?.daily) && sched.daily.length > 0
      const absolute = !hasDaily && sched?.validUntil ? new Date(sched.validUntil).getTime() : undefined
      bestRule = { source: 'text', label: promo?.badge?.label, peak: rule.peak, absolute }
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
    nextChangeAt = nextPeakBoundary(win, false)
  } else if (bestRule?.peak) {
    nextChangeAt = nextPeakBoundary(bestRule.peak, true)
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

  // 只认「明确是 DeepSeek 官方」的 provider 名。
  // 之前用 /deepseek/i 模糊匹配，`custom-deepseek-proxy` 这类中转站也会被套上
  // DeepSeek 官方的错峰规则 —— 中转站的价格体系未必跟官方一致，套了就报错价。
  // 现在要求名字以 deepseek 开头或等于 deepseek，才认为是官方。
  const normalized = p.toLowerCase().replace(/^custom-/, '').replace(/^official-/, '')
  if (!/^deepseek([-_]?(official|api))?$/.test(normalized)) return undefined

  const now = new Date()
  const weekend = now.getUTCDay() === 0 || now.getUTCDay() === 6
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes()
  const isPeak = !(DEEPSEEK_OFFPEAK.weekdayOnly && weekend)
    && DEEPSEEK_OFFPEAK.peakUtc.some(([s, e]) => mins >= s && mins < e)

  return {
    kind: isPeak ? 'peak' : 'valley',
    factor: DEEPSEEK_OFFPEAK.factor,
    weekend,
    label: DEEPSEEK_OFFPEAK.label,
    source: DEEPSEEK_OFFPEAK.source,
    checkedAt: DEEPSEEK_OFFPEAK.checkedAt,
    peakUtc: DEEPSEEK_OFFPEAK.peakUtc,
    // 下次切换的绝对时刻，同样用于缓存（按 UTC 算边界）
    nextChangeAt: nextUtcPeakBoundary(DEEPSEEK_OFFPEAK.peakUtc, DEEPSEEK_OFFPEAK.weekdayOnly),
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
    return
  }

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
  if (disc !== undefined && disc.kind === 'valley') {
    parts.push('谷 ' + disc.rate.toFixed(2))
    tone = 'good'
  } else if (disc !== undefined && disc.kind === 'peak') {
    parts.push('峰 ' + disc.base.toFixed(2))
    tone = 'bad'
  } else if (disc === undefined && ext !== undefined) {
    if (ext.kind === 'valley') {
      parts.push('谷 ' + (ext.factor * 10) + ' 折')
      tone = 'good'
    } else {
      parts.push('峰原价')
      tone = 'bad'
    }
  }

  // 拥堵
  const level = st.busy[id]
  if (wbRegion === 'cn' && JAM_LEVELS.has(level)) {
    parts.push(busyLabel(level))
    const jt = busyTone(level)
    if (jt === 'bad') tone = 'bad'
    else if (jt === 'warn' && tone !== 'bad') tone = 'warn'
  }

  // 积分：写成「积分:504」。只有签到真的开着（active===true）才加明日预计。
  // 国际版 active=false（活动已下线），daily_credit 仍返回 100 —— 不能拿它算。
  if (isWorkBuddy && st.creditRegion !== '' && st.total > 0) {
    const next = tomorrowTotal()
    if (st.creditRegion === 'global') {
      // 国际版单独方案：没有签到、没有拥堵、没有峰谷，只报一个实时余额。
      parts.push('积分:' + st.total)
      if (tone === undefined) tone = 'good'
    } else {
      // 国内版保持原样：504 (明604)，颜色跟随峰谷/拥堵
      parts.push(next === undefined ? String(st.total) : st.total + ' (明' + next + ')')
    }
  }

  if (parts.length === 0) return null
  // 24 字上限：超了就先砍积分那一段（它最不紧急）
  // 超长时的降级顺序：先去掉「(明xxx)」只留当前积分，再整段去掉积分。
  // 这样「预计」被牺牲，当前余额尽量保住。
  let text = parts.join(' • ')
  if (text.length > 24) {
    for (let i = 0; i < parts.length; i++) {
      const stripped = parts[i].replace(/\s*\(明\d+\)$/, '')
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

export const name = 'dsh-workbuddy-pulse'

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.strip('pulse', (scope, emit) => {
      let stopped = false
      const sessionId = scope?.sessionId

      const paint = () => {
        if (stopped) return
        const c = compose()
        if (c === null) {
          // 三项都没数据 → 整条隐藏
          if (st.lastText !== '') {
            st.lastText = ''
            st.lastTone = ''
            emit({ text: null })
          }
          return
        }
        const tone = c.tone ?? ''
        if (c.text === st.lastText && tone === st.lastTone) return
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
        // 上一轮还没跑完（网络慢、解压大日志）就跳过本轮，避免请求堆叠
        if (running) return
        running = true
        try {
        const flipped = await readCurrentModel(sessionId)
        // 模型切换 = 用户正在操作：重置活跃时间，让接下来一段时间密集刷新
        if (flipped) st.activeAt = Date.now()
        await refreshConfig(false, flipped)
        await refreshBusy(flipped)
        await refreshCredits(false, flipped)
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
              ['积分', { $: 'data.credits' }],
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
          await refreshCredits(true)
          if (stopped) return

          const id = resolveModelId()
          const disc = discountStateCached(id)
          const ext = disc === undefined ? externalDiscountCached() : undefined

          const valley = disc !== undefined
            ? (disc.kind === 'valley' ? '谷 x' + disc.rate.toFixed(2) + '（省钱中）'
              : disc.kind === 'peak' ? '峰 x' + disc.base.toFixed(2) + '（高峰原价）'
              : '无（该模型没有分时折扣）')
            : ext !== undefined
              ? (ext.kind === 'valley' ? '谷 ' + ext.factor * 10 + '折（错峰优惠中）' : '峰 原价（高峰时段）')
              : '无（该渠道没有公开的分时规则）'

          const level = st.busy[id]
          const isGlobal = st.region[id] === 'global'
          const jam = isGlobal ? '无（国际版没有队列接口）'
            : JAM_LEVELS.has(level) ? busyLabel(level)
            : '无（上游没给这个模型的队列数据）'

          const next = tomorrowTotal()
          const credits = st.creditRegion === ''
            ? '无（非 WorkBuddy 渠道）'
            : String(st.total) + (next === undefined ? '（签到未开启）' : '，明日签到后 ' + next)

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
        const timer = setInterval(() => void push(), intervalOf(CREDIT_STEPS, Date.now() - st.activeAt))
        return () => {
          stopped = true
          clearInterval(timer)
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
