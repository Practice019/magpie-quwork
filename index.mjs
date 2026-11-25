// index.mjs 插件入口 —— 只做「组装」。
//
// # magpie 怎么认插件
//
// 入口模块的**每个具名导出**都会被当成独立插件调用。所以这里只导出一个插件
// 函数（本插件没有页面服务，不需要第二个导出）。
//
// # 钩子集合（与 magpie-loomy 同构）
//
//	config            给宿主看的供应商配置
//	auth.methods      登录方式（本上游是**粘贴 token**，见下）
//	auth.loader       请求代理（改写 URL / 鉴权）
//	auth.usage        额度卡片
//	provider.models   模型目录
//
// # 刻意不实现
//
//	auth.refresh   续期由 loader 的旁路完成（`src/refresh.mjs`），没有独立 refresh token
//
// # auth.import（T-33）
//
// 「添加提供商」里的「从文件导入」是 magpie **自己的**钩子（OpenCode 忽略）。
// 缺它时界面干脆不画这一行 —— 真机核对过 loomy / officeace / codearts 都有，
// 只有 quwork 没有。形状见 `src/importer.mjs`（单对象 / 数组 / `version:1` 容器 /
// NDJSON 都认，`llmToken` 必需）。
//
// # auth.checkin（T-32 修正）
//
// 早先的注释写「签到强制绑微信，做了也拿不到」——**只对了一部分**。真机实测
// （`plugin-checkin.json` 的 quwork 条目）三个号里有一个能签，另两个回
// `wechat_bind_required`。所以钩子**必须写**，且必须把三种结局分开报：
//
//	已签到   → `outcome:"done"`（**成功态**，绝不能报 failed，否则卡片显示失败）
//	可签到   → 真打 `/api/user/daily-reward/claim` → `outcome:"claimed"` + `credit`
//	需绑微信 → `outcome:"ineligible"` + 明确说「需先绑定微信」
//
// 形状真源：`host-acc034d984c6.js` 的 `checkinOf()`（约 3393-3411 行）——
// `{outcome, credit?, streak?, message?, until?}`，`outcome` 必须是
// `claimed|done|ineligible|inactive|captcha|failed` 之一，否则宿主自己拼
// 「the plugin answered …」并判 failed。旧实现返回 `{ok, message}` 正是
// 真机「quwork's plugin doesn't check in」的直接原因。
//
// # auth.options（T-32 新增）
//
// 形状真源：`host-acc034d984c6.js` 的 `optionsOf()`（约 2360-2382 行）。
// **严格 schema**（多写字段会被静默丢弃，改少写字段会被读成默认）：
//
//	{ key, label, description?, default?, confirm?, labels?, descriptions?,
//	  confirms?, filtersModels?, placement? }
//
//  ・`key`    必须 `^[a-z0-9_-]{1,40}$`，最多 16 个，重复/非法 key 直接跳过
//  ・`label`  必填、≤60 字；没有 label 就**整项不出现**
//  ・`default` 只认 `=== true`（即「布尔开关」；写 "yes"/1 一律当 false）
//  ・`placement:"top"` = 画在账号区下方、Routing 上方；其余位置 = 画在模型下方
//  ・插件里读当前值用 `input.magpie.option(provider, key)`（`host.js:2455`）
//
// ⚠ `package.json` 的 `magpie.options` 是另一回事（页面服务的**默认值表**，
//   宿主侧 `declared()` 只从里面读 `maxConcurrency`/`maxAccounts`），
//   它**不会**在界面上变成开关。界面开关只有 `auth.options` 这一条通道。
//
// # 为什么登录方式是「粘贴」
//
// 注册链路卡在阿里云滑块（§1），本插件自动化不了；而 `llmToken` 与会话解耦、
// 可长期使用（§4.3）。所以最诚实的交互是：让用户/上游脚本把 token 贴进来。

import { DEFAULT_BODY_MODE, DEFAULT_MODEL_ID, MODEL_BASE_URL, PLATFORM_BASE_URL, PROVIDER } from "./src/constants.mjs"
import { makeLoaderHook } from "./src/hooks/loader.mjs"
import { makeModelsHook } from "./src/hooks/models.mjs"
import { makeUsageHook } from "./src/hooks/usage.mjs"
import { makeRefresher } from "./src/refresh.mjs"
import { upsertAccount } from "./src/auth-store.mjs"
import { PHONE_RE, CODE_RE, deviceIdentifierFrom, sendVerifyCode, loginWithCode, isCodeError } from "./src/login.mjs"
import { readLocalCredential, pollForNewCredential } from "./src/browser-login.mjs"
import { WEB_LOGIN_URL } from "./src/launch-client.mjs"
import { defaultOpenExternal } from "./src/open-url.mjs"
import { compact, accountIdOf } from "./src/identity.mjs"
import { ICON } from "./src/icon.mjs"
import { claimDailyReward, fetchDailyRewardStatus } from "./src/invite.mjs"
import { collectResults, makeImportHook } from "./src/importer.mjs"
import { makePasteImportMethod } from "./src/paste-import.mjs"

/**
 * `config` 钩子：声明供应商本身与模型基址，**不发请求**。
 *
 * # ⚠ 必须原地改，不能返回新对象（真机事故 2026-11-21）
 *
 * 宿主是这样调它的（`host.js` L1567-1571）：
 *
 *	await inTime(() => h.hooks.config(config), …)   // ← 返回值被丢弃
 *	ownConfig.set(ownKey(h.spec, id), config.provider?.[id])   // ← 读的是入参本身
 *
 * 所以「返回一个新对象」= 白写：这次的 quilt 一直没进 magpie 的供应商配置。
 * magpie 能正常发请求，是因为 `provider.models` 返回的模型条目自带 `api.url`，
 * 恰好绕过了这个缺失 —— 界面上 quwork 的 API 地址一直是空的。
 *
 * 正确写法与 loomy / officeace / codearts 三家一致：改 `cfg.provider[PROVIDER]`。
 * 用 `??=` / 展开旧值，是为了不覆盖用户在 plugins.json 里手写的条目。
 */
function makeConfigHook(opts = {}) {
  const api = String(opts.modelBaseUrl ?? "").trim() || MODEL_BASE_URL
  return (cfg) => {
    if (!cfg || typeof cfg !== "object") return
    cfg.provider ??= {}
    // ⚠ 不整体替换：用户可能已经在 plugins.json 里写了 name / npm / 其它字段
    const prior = cfg.provider[PROVIDER] ?? {}
    cfg.provider[PROVIDER] = {
      ...prior,
      name: prior.name || "QuWork",
      baseURL: api,
      options: { ...(prior.options ?? {}), baseURL: api },
    }
  }
}

/**
 * `auth.methods`：**数组**，每项一种登录方式（真实契约，实测自 magpie-loomy 的装载结果）。
 *
 * # 真机报错（这条注释就是防止再犯的）
 *
 *	magpie: (auth.methods ?? []).map is not a function
 *
 * magpie 直接把 `auth.methods` 当数组 `map`。返回对象/函数都会炸。
 *
 * # 三项（按现实可行性排序）
 *
 *	① 手机号 + 短信验证码  —— 真登录。⚠ 发码要过阿里云滑块（服务端强校验），
 *	                          没票据时会在 `instructions` 里如实告知走 ②
 *	② 浏览器登录（读取本机客户端会话）—— 最现实的路径：客户端登录一次即可
 *	③ 粘贴 llm_token        —— 最后兜底，任何情况下都能用
 *
 * # 契约（host 源码语义）
 *
 *	{ type: "oauth", label, labels?, prompts?, authorize(inputs, {signal}), callback(code?, {signal}) }
 *
 *	`authorize` → { method: "code", callback, instructions? }（method==="code" 时
 *	               magpie 会问用户输入验证码，填完调 `callback(code, …)`）
 *	`callback`  → { type: "success", access, refresh, expires, accountId?, metadata? }
 *	              ⚠ `access` 必须是 **llm_token**（loader 拿它调模型）；
 *	                 平台 `token` 放 `refresh`（magpie 的 keptAs 看到它就保留）
 *
 * @param {{platformBaseUrl?: string, configDir?: string, log?: any,
 *   fetchImpl?: typeof fetch, readLocal?: () => any, client?: any}} [opts]
 *   `client`：宿主的 `client.auth.set` 通道（批量导入时第 2..N 条靠它落盘）。
 * @returns {Array<object>}
 */
function makeMethods(opts = {}) {
  const platformBaseUrl = String(opts.platformBaseUrl ?? "").trim() || PLATFORM_BASE_URL
  const log = opts.log ?? console
  const fetchImpl = opts.fetchImpl
  const readLocal = typeof opts.readLocal === "function" ? opts.readLocal : () => readLocalCredential()
  const configDir = String(opts.configDir ?? "").trim()

  // ── 浏览器登录页 + 打开器 + 轮询参数（都可注入）──
  //
  // 用户明确不要客户端：点一下就用系统浏览器打开 quwork.cn（网页版自带完整登录），
  // 登录后 token 落在浏览器存储里，由 readLocalCredential 的浏览器 profile 来源读出。
  const openExternal = typeof opts.openExternal === "function" ? opts.openExternal : defaultOpenExternal
  const loginUrl = String(opts.loginUrl ?? "").trim() || WEB_LOGIN_URL
  const pollMs = Number.isFinite(opts.pollMs) ? Number(opts.pollMs) : 180_000
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? Number(opts.pollIntervalMs) : 3000
  /** @type {((ms: number) => Promise<void>) | undefined} */
  const sleep = typeof opts.sleep === "function" ? opts.sleep : undefined
  /** @type {(() => number) | undefined} */
  const now = typeof opts.now === "function" ? opts.now : undefined
  // 自动抓取依赖 Windows 客户端写入的 sqlite / credentials 文件；Linux/macOS
  // 下这个方式永远轮询不到凭据，明确提示改用短信/粘贴/文件导入。
  const platform = String(opts.platform ?? process.platform)

  /** 一次发码会话里暂存的信息（按 phone 索引；进程内有效）。 */
  const pending = new Map()

  /**
   * 把「登录成功」统一翻译成 magpie 的 success 形状。
   *
   * ⚠ `access` 必须是 **llm_token**（loader 拿它调模型）
   * ⚠ `refresh` 必须**存在**（哪怕空串）：magpie 的 keptAs 见到 refresh 就保留凭据
   * ⚠ `expires` 是**毫秒**（上游 `expire` 是秒，要 ×1000）；**没有就不写这个键**
   * ⚠ `accountId` **绝不允许空串**（空串 ⇒ 卡片退化成 `Signed in (pjcsg3)`）
   * ⚠ `metadata` 只放非空值（空串等于没写，还会让「有 token 吗」失真）
   *
   * @param {{llmToken: string, token?: string, expire?: number}} r
   * @param {string} [accountIdHint] 已知的账号名（手机号等）
   * @param {{uid?: string, phone?: string}} [extra]
   */
  const successOf = (r, accountIdHint, extra = {}) => {
    const phone = String(extra.phone ?? accountIdHint ?? "").trim()
    const uid = String(extra.uid ?? "").trim()
    const rawExpire = Number(r?.expire)
    const expiresMs = Number.isFinite(rawExpire) && rawExpire > 0 ? (rawExpire < 1e11 ? rawExpire * 1000 : rawExpire) : 0

    return {
      type: "success",
      access: r.llmToken,
      refresh: r.token ?? "",
      ...(expiresMs > 0 ? { expires: expiresMs } : {}),
      accountId: accountIdOf({ phone, uid, llmToken: r.llmToken }),
      metadata: compact({ uid, phone, nickname: phone, token: r.token }),
    }
  }

  /** 顺便把凭据写进 plugin-auth.json（失败不影响登录成功本身）。 */
  const persist = (r, phone) => {
    if (!configDir) return
    try {
      upsertAccount(configDir, {
        llmToken: r.llmToken,
        token: r.token || undefined,
        expire: r.expire || undefined,
        phone,
        uid: phone,
      })
    } catch (e) {
      log?.warn?.(`quwork: 保存凭据失败（登录仍然成功）: ${String(e?.message ?? e).slice(0, 160)}`)
    }
  }

  /* ── ① 手机号 + 短信验证码 ───────────────────────────────────────── */

  const smsMethod = {
    type: "oauth",
    label: "手机号 + 短信验证码",
    labels: { en: "phone + SMS code" },
    // ⚠ 同时挂在方法上：magpie 两种取法都见过（从 authorize 返回值取，或直接读方法）
    callback: smsCallback,
    prompts: [
      {
        type: "text",
        key: "phone",
        message: "手机号（中国大陆 11 位）",
        placeholder: "13800000000",
        validate: (v) => (PHONE_RE.test(String(v ?? "").trim()) ? null : "手机号格式不对"),
      },
    ],
    /**
     * 发码。⚠ 必须**立刻**返回（magpie 靠返回值判断下一步问什么）。
     *
     * 真机实测（2026-11-20）：**form-urlencoded** 提交、**不带** `aliyun_captcha`
     * —— 服务端没强校验，滑块只是前端 UX。旧报告拿 JSON 打才失败。
     *
     * @param {any} inputs
     */
    async authorize(inputs = {}) {
      const phone = String(inputs?.phone ?? "").trim()
      if (!PHONE_RE.test(phone)) return { type: "failed", error: "手机号格式不对" }

      const sent = await sendVerifyCode({ platformBaseUrl, phone, fetchImpl })
      if (!sent.ok) {
        // 频率限制是**正常业务回执**（"验证码发送过于频繁，请稍后再试"），原样交给用户
        return {
          type: "failed",
          error: sent.rateLimited ? `发送验证码失败：${sent.error}（稍后再试）` : `发送验证码失败：${sent.error}`,
        }
      }

      pending.set(phone, { deviceIdentifier: deviceIdentifierFrom() })
      return {
        method: "code",
        callback: smsCallback,
        instructions: `验证码已发送到 ${phone}`,
      }
    },
  }

  /**
   * 填完验证码后调这里（`method === "code"` 时 magpie 会把 code 传进来）。
   *
   * @param {string} [code]
   */
  async function smsCallback(code) {
    const phone = String(pending.keys().next().value ?? "").trim()
    if (!phone) return { type: "failed", error: "登录会话已失效，请重新发起" }

    const value = String(code ?? "").trim()
    // 格式先自己挡：4~8 位数字（省一次无用的上游请求）
    if (!CODE_RE.test(value)) return { type: "failed", error: "验证码格式不对（4~8 位数字）" }

    const one = pending.get(phone) ?? { deviceIdentifier: deviceIdentifierFrom() }
    const r = await loginWithCode({
      platformBaseUrl,
      phone,
      code: value,
      deviceIdentifier: one.deviceIdentifier,
      fetchImpl,
    })
    if (!r.ok) {
      // 验证码错允许重试（不清 pending）
      return { type: "failed", error: isCodeError(r.error) ? `验证码错误或已过期：${r.error}` : r.error }
    }
    if (!r.llmToken) {
      return { type: "failed", error: "登录成功但没有 llm_token，请改用「浏览器登录（读取本机客户端）」" }
    }
    pending.delete(phone)

    const uid = String(r.user?.id ?? r.user?.uid ?? "")
    persist(r, phone)
    return successOf(r, phone, { uid, phone })
  }

  /* ── ② 打开浏览器登录（网页版）+ 轮询抓取 ──────────────────────── */

  const browserMethod = {
    type: "oauth",
    label: "打开浏览器登录（自动抓取）",
    labels: { en: "open quwork.cn in a browser and capture the token" },
    // 同 sms：方法级也挂一份（两种取法都兼容）
    callback: browserCallback,
    /**
     * 点一下就**用系统浏览器打开 quwork.cn**（网页版自带完整登录）。
     *
     * 登录完成后 token 落在浏览器存储里，`callback` 轮询读出来。
     * ⚠ 立刻返回（沉默等待在 `callback`）；打开失败只 warn，仍把 url 交给 magpie。
     */
    async authorize() {
      if (platform !== "win32") {
        return {
          type: "failed",
          error: "「浏览器/客户端自动抓取」只支持 Windows（依赖本机客户端写入凭据）。Linux 请用「手机号 + 短信验证码」「粘贴 llm_token」或「从文件导入」。",
        }
      }
      try {
        await openExternal(loginUrl)
      } catch {
        /* 打不开也让 magpie 拿着 url 自己开 */
      }
      return {
        url: loginUrl,
        method: "other",
        callback: browserCallback,
        instructions: "已在浏览器打开 quwork.cn，登录完成后这里会自动继续",
      }
    },
  }

  /**
   * 轮询抓取新凭据。
   *
   * # 为什么先快照**完整**基准（不是只取 token 字符串）
   *
   * 真机实测：用户在客户端登录后 **token 可能与登录前完全相同**（服务端复用同一个
   * sk- token）。只比字符串会把「真的登录了」判成「没变化」⇒ 永远超时。
   * 所以快照整份凭据（含 `sessionUpdatedAt` / `fileMtime` / `hasPlatformToken`），
   * 交给 `isNewCredential()` 做四判据。
   */
  async function browserCallback(_input, { signal } = {}) {
    if (platform !== "win32") {
      return { type: "failed", error: "自动抓取只支持 Windows；Linux 请用短信验证码或粘贴 llm_token。" }
    }
    /** @type {any} */
    let baseline = {}
    try {
      baseline = readLocal() ?? {}
    } catch {
      baseline = {}
    }

    const polled = await pollForNewCredential({
      readLocal,
      baseline,
      signal,
      pollMs: pollMs,
      pollIntervalMs: pollIntervalMs,
      sleep,
      now,
    })
    if (!polled.ok) return { type: "failed", error: polled.error }

    const local = polled.cred
    const r = { llmToken: local.llmToken, token: local.token ?? "", expire: local.expire ?? 0 }
    const uid = String(local.uid ?? "").trim()
    const phone = String(local.phone ?? "").trim()
    persist(r, phone)
    return successOf(r, phone, { uid, phone })
  }

  /* ── ③ 粘贴（最后兜底）────────────────────────────────────────── */

  const LLM_PROMPT = {
    type: "password",
    key: "llmToken",
    message: "llm_token（sk- 开头，用于调模型）",
    placeholder: "sk-...",
  }
  const PLATFORM_PROMPT = {
    type: "password",
    key: "token",
    message: "平台 token（可选，用于显示积分与续期）",
    placeholder: "留空则只调模型",
  }

  const pasteMethods = [
    {
      type: "oauth",
      label: "粘贴 llm_token",
      labels: { en: "paste llm_token" },
      prompts: [LLM_PROMPT],
      async authorize(inputs = {}) {
        const llmToken = String(inputs?.llmToken ?? "").trim()
        if (!llmToken) return { type: "failed", error: "缺少模型 token（llm_token）" }
        persist({ llmToken, token: "", expire: 0 }, "")
        return successOf({ llmToken, token: "", expire: 0 }, "")
      },
    },
    {
      type: "oauth",
      label: "粘贴 llm_token + 平台 token",
      labels: { en: "paste llm_token + platform token" },
      prompts: [LLM_PROMPT, PLATFORM_PROMPT],
      async authorize(inputs = {}) {
        const llmToken = String(inputs?.llmToken ?? "").trim()
        if (!llmToken) return { type: "failed", error: "缺少模型 token（llm_token）" }
        const token = String(inputs?.token ?? "").trim()
        persist({ llmToken, token, expire: 0 }, "")
        return successOf({ llmToken, token, expire: 0 }, "")
      },
    },
  ]

  // ⑤ 从文件导入（粘贴 JSON / NDJSON）—— 导入入口放回**登录弹窗**里
  // （供应商详情页把账号全列出来时，最底下的导入按钮翻不到）。
  // 复用 `src/importer.mjs` 的解析/校验/去重，不写第二套解析器。
  const importMethod = makePasteImportMethod({
    configDir,
    client: opts.client,
    log,
    collect: (texts) => collectResults(texts, { configDir, log }),
  })

  return [smsMethod, browserMethod, ...pasteMethods, importMethod]
}

/** `auth.checkin` 允许的 outcome 全集（真源：`host.js` 的 `checkinOutcomes`）。 */
const CHECKIN_OUTCOMES = Object.freeze(["claimed", "done", "ineligible", "inactive", "captcha", "failed"])

/**
 * 上游"今天"什么时候翻页（epoch **毫秒**）。
 *
 * quwork 的 `next_refresh_at` 真机是**秒**（`1795190400` 换算出来正好是北京
 * 次日 0 点），但契约允许 `until` 是 RFC3339 或毫秒。这里按量级归一：
 * 小于 1e11 当秒 ×1000。认不出就不给 `until`（宿主的 `checkinOf` 对
 * 不可读的时间点会返回空串，不会炸）。
 *
 * @param {number|string|undefined|null} v
 * @returns {number|undefined}
 */
function expirationOf(v) {
  const n = typeof v === "string" ? Number(v.trim()) : Number(v)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
}

/**
 * 造 `auth.checkin` 钩子。
 *
 * 形状（照 `host.js:3393-3411` 的 `checkinOf` 抄，一个字段都不多给）：
 *
 *	{ outcome: "claimed"|"done"|"ineligible"|"inactive"|"captcha"|"failed",
 *	  credit?, streak?, message?, until? }
 *
 * 三条硬约束：
 *
 *	① 已签到必须 `done`（**成功态**）。旧实现报 `{ok:false}` ⇒ 宿主判 failed。
 *	② 需要绑微信不是"失败"，是"这个号没资格" ⇒ `ineligible`
 *	   （`error_code: wechat_bind_required` 的语义，用户该去绑微信，不该重试）。
 *	③ 任何异常都收成 `failed` + message，不往外抛 —— 宿主抛异常也判 failed，
 *	   但那样就没有可读的原因了。
 *
 * @param {{platformBaseUrl?: string, fetchImpl?: typeof fetch, log?: any}} [opts]
 * @returns {(getAuth: () => Promise<any>) => Promise<object>}
 */
export function makeCheckinHook(opts = {}) {
  const base = String(opts.platformBaseUrl ?? "").trim().replace(/\/+$/, "") || PLATFORM_BASE_URL
  const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : undefined
  const log = opts.log ?? console

  return async function checkin(getAuth) {
    /** @type {any} */
    let auth = {}
    try {
      auth = (await getAuth()) ?? {}
    } catch {
      auth = {}
    }
    // 平台 token：`token`（落盘）或 `refresh`（magpie 存的那个）都认 —— 与 usage 钩子同口径
    const token = String(auth?.token ?? auth?.refresh ?? "").trim()
    if (!token) {
      return {
        outcome: "ineligible",
        message: "只配置了模型 token，读不到平台签到状态（补一个平台 token 即可）",
      }
    }

    try {
      const status = await fetchDailyRewardStatus({ platformBaseUrl: base, token, fetchImpl })

      if (status.ok) {
        const streak = Number(status.consecutiveDays) || 0
        const until = expirationOf(status.nextRefreshAt)

        // ① 今天已经签过：**成功态**，不是失败
        if (status.claimed) {
          return {
            outcome: "done",
            ...(streak > 0 ? { streak } : {}),
            message: `今天已经签过了${streak > 0 ? `（连续 ${streak} 天）` : ""}`,
            ...(until ? { until } : {}),
          }
        }

        // ② 需要绑微信：不是"失败"，是这个号没资格
        if (status.wechatRequired) {
          return {
            outcome: "ineligible",
            message: "该账号签到需要先绑定微信（上游回 wechat_bind_required），去 QuWork 客户端绑完再签",
            ...(until ? { until } : {}),
          }
        }
      }

      const r = await claimDailyReward({ platformBaseUrl: base, token, fetchImpl })
      if (!r.ok) {
        // 上游把"今天已签"当业务错误返回（success:false）时的兜底：
        // 报 failed 会让卡片显示红，而事实是这个号今天好好的。
        const said = String(r.message ?? "")
        if (/已(经)?(签|领取)|今日已|already|claimed|repeated|重复/i.test(said)) {
          return { outcome: "done", message: `今天已经签过了：${said}` }
        }
        // 夹带 wechat_bind_required 的失败也要报成 ineligible（语义优先于措辞）
        if (/wechat|微信|bind_required/i.test(said)) {
          return { outcome: "ineligible", message: `该账号签到需要先绑定微信：${said}` }
        }
        return { outcome: "failed", message: said || "签到被上游拒绝（没说原因）" }
      }

      // ③ 真签上了
      const granted = Number(r.granted) || 0
      const streak = Number(r.consecutiveDays) || 0
      const points = Number(r.points) || 0
      return {
        outcome: "claimed",
        ...(granted > 0 ? { credit: granted } : {}),
        ...(streak > 0 ? { streak } : {}),
        message: `签到成功 +${granted} 积分${streak > 0 ? `（连续 ${streak} 天）` : ""}${
          points > 0 ? `，当前共 ${points} 积分` : ""
        }`,
      }
    } catch (e) {
      const message = String(e?.message ?? e).slice(0, 300)
      try {
        log?.warn?.(`quwork: 签到异常: ${message.slice(0, 160)}`)
      } catch {
        /* 日志失败不是业务失败 */
      }
      return { outcome: "failed", message }
    }
  }
}

/**
 * `auth.options`：面板侧的两个开关（T-32）。
 *
 * ⚠ 只有**布尔**能被画成开关（`optionsOf` 把 `default` 归成 `o.default === true`）。
 *   所以「登录轮询间隔（秒）」只能是 number 这个事实要写进 `description`，
 *   不能指望界面上填数字 —— 那会抄错 schema（见文件头「# auth.options」）。
 *
 * ⚠ **key 必须全是小写**（`OPTION_KEY = /^[a-z0-9_-]{1,40}$/`）：
 *   写成 `autoRefresh`(camelCase) 会被 `optionsOf()` **整项跳过**——
 *   既不报错也不显示，是最难发现的那种失效。下面两个 key 都是小写。
 *
 * 两个键都真的被消费：
 *
 *	`autorefresh`  → `QuWorkPage` 的默认设置：面板打开后自动刷一次积分
 *	                 （用户自己在面板「设置」里勾过就以面板为准）
 *	`pollfaster`   → `methods()[② 浏览器登录]` 的轮询间隔（关=3 秒 / 开=1 秒）
 *
 * 读到它们靠 `input.magpie.option(provider, key)`（`host.js:2455`）。
 * 这是 magpie 自有通道，OpenCode 里没有 ⇒ `input.magpie` 不存在时回落到 `default`。
 */
export const AUTH_OPTIONS = Object.freeze([
  {
    key: "autorefresh",
    label: "打开面板自动刷新积分",
    description: "面板打开后自动拉一次平台积分（不发任何请求给模型）。关掉则只在点「刷新」时读。",
    labels: { zh: "打开面板自动刷新积分", en: "Auto refresh credits when the panel opens" },
    descriptions: {
      zh: "面板打开后自动拉一次平台积分。关掉则只在点「刷新」时读。",
      en: "Read the platform credits once when the panel opens. Off: only when you press Refresh.",
    },
    default: false,
  },
  {
    key: "pollfaster",
    label: "登录轮询加快",
    description:
      "浏览器登录后读取本机登录态的间隔：关 = 默认 3 秒；开 = 1 秒（更快发现登录完成，也更耗电）。",
    labels: { zh: "登录轮询加快", en: "Sign in: poll faster" },
    descriptions: {
      zh: "浏览器登录后读取本机登录态的间隔：关 = 3 秒；开 = 1 秒（更快，也更耗电）。",
      en: "How often the browser sign-in reads the local credential: Off = 3s, On = 1s (faster, more CPU).",
    },
    default: false,
  },
])
export const QuWorkAuthPlugin = async (input = {}, options = {}) => {
  const configDir = String(input?.directory ?? options?.configDir ?? "").trim()
  const modelBaseUrl = String(options?.baseUrl ?? "").trim() || MODEL_BASE_URL
  const platformBaseUrl = String(options?.platformBaseUrl ?? "").trim() || PLATFORM_BASE_URL
  // body 形态：默认 client-shape（补 stream/thinking）；passthrough = 逐字节原样
  const bodyMode = String(options?.bodyMode ?? "").trim() || DEFAULT_BODY_MODE

  const log = input?.client?.app?.log
    ? { warn: (m) => input.client.app.log({ body: { service: PROVIDER, level: "warn", message: m } }) }
    : (options?.log ?? console)

  // ── 界面开关（`auth.options`）的读法 ──
  //
  // `input.magpie.option(provider, key)` 是 magpie **独有**的通道（`host.js:2455`），
  // 用户在供应商编辑页拨的开关就存在这里。OpenCode 里没有 `input.magpie`
  // ⇒ 一律回落到本文件 `AUTH_OPTIONS` 里声明的 `default`。
  //
  // ⚠ 这里读出来就要**立刻**用于生产行为，否则就是个"拨了没反应"的假开关。
  const option = (key, fallback) => {
    try {
      const v = input?.magpie?.option?.(PROVIDER, key)
      return typeof v === "boolean" ? v : fallback
    } catch {
      return fallback
    }
  }
  const autoRefreshOption = option("autorefresh", false)
  // 「登录轮询加快」：开 = 1 秒，关 = 默认 3 秒。显式的 pollIntervalMs 优先（排障用）。
  const pollIntervalMs =
    Number.isFinite(options?.pollIntervalMs) && Number(options.pollIntervalMs) > 0
      ? Number(options.pollIntervalMs)
      : option("pollfaster", false)
        ? 1000
        : 3000

  // 续期器：loader 每条对话请求后 `void` 调一次（节流 60s，失败只 log）
  const refresh = makeRefresher({ configDir, log, platformBaseUrl })

  /** @type {any} */
  const result = {
    config: makeConfigHook({ modelBaseUrl }),
    auth: {
      provider: PROVIDER,
      // ⚠ magpie 的 `iconOf()` 读的是 **`auth.icon`**（不是插件顶层 icon），
      // 且要求 `^data:image/` 前缀、≤3MB。少写这一处 = 界面上永远换不了图标。
      ...(ICON ? { icon: ICON } : {}),
      methods: makeMethods({
        platformBaseUrl,
        platform: options?.platform,
        configDir,
        log,
        // `client` 只给「从文件导入（粘贴）」用：一次粘多条时，第 2..N 条要走
        // `client.auth.set` 自己落盘（宿主一次登录只保存一个账号）。
        client: input?.client,
        // 测试/排障注入点（生产不传 = 用全局 fetch 与本机读取）
        fetchImpl: typeof options?.fetchImpl === "function" ? options.fetchImpl : undefined,
        readLocal: typeof options?.readLocal === "function" ? options.readLocal : undefined,
        // 浏览器登录 / 轮询：全部可注入（生产不传 = 真开浏览器、真轮询 3 分钟）
        loginUrl: options?.loginUrl,
        openExternal: typeof options?.openExternal === "function" ? options.openExternal : undefined,
        pollMs: options?.pollMs,
        // 开关「登录轮询加快」决定的值（开=1s / 关=3s），显式 pollIntervalMs 已在上面优先
        pollIntervalMs,
        sleep: typeof options?.sleep === "function" ? options.sleep : undefined,
        now: typeof options?.now === "function" ? options.now : undefined,
      }),
      loader: makeLoaderHook({ modelBaseUrl, log, refresh, bodyMode }),
      // T-39：额度**只读缓存**（`quwork-usage-cache.json`）。缓存由面板「刷新」写。
      usage: makeUsageHook({ platformBaseUrl, configDir, log }),
      // 界面开关（真源见文件头「# auth.options」）。**必须**挂在 `auth` 上，
      // 挂在返回对象顶层等于没写（`optionsOf(a.auth)`）。
      options: AUTH_OPTIONS.map((o) => ({ ...o })),
      /**
       * `auth.checkin`：magpie 自己的签到钩子（OpenCode 忽略）。
       *
       * 形状与三种结局见 `makeCheckinHook` 的注释（T-32 修正）。
       */
      checkin: makeCheckinHook({ platformBaseUrl, fetchImpl: options?.fetchImpl, log }),
      /**
       * `auth.import`：magpie 自己的「从文件导入账号」钩子（OpenCode 忽略）。
       *
       * 缺这个键时「添加提供商」里**不出现**「从文件导入」这一行（真机核对过）。
       * 形状与解析规则见 `src/importer.mjs`；`configDir` 用来读 `plugin-auth.json`
       * 做去重，不传就不去重（不会因为读不到而报错）。
       */
      ...makeImportHook({ configDir, log }),
    },
    provider: {
      id: PROVIDER,
      // T-39：目录**只读缓存**（`quwork-models-cache.json`）；未命中才拉 1 次并写缓存。
      models: makeModelsHook({ modelBaseUrl, configDir, log }),
    },
  }

  // 官方图标同时挂在顶层（排障用；magpie 真正读的是 `auth.icon`，见上）
  if (ICON) result.icon = ICON

  return result
}

/**
 * 面板服务的**宿主侧**：为 QuWork 面板跑一个本地 HTTP 服务。
 *
 * # 为什么必须是一个独立具名导出
 *
 * magpie 把入口模块的**每个具名导出**都当插件调用，并把它自己解析出的 options
 * （含 `port`）传进来。服务在这个函数里 `listen`，magpie 不代劳。
 *
 * ⚠ 动态 import：页面服务只在 magpie 真要它时才加载（`serve` 场景）。
 *   静态 import 会让 `node --test` 每次也拉起 server.mjs 的全部依赖。
 *
 * @param {{client?: any, directory?: string}} [input]
 * @param {object} [options]
 */
export const QuWorkPage = async (input = {}, options = {}) => {
  const { QuWorkPage: serve } = await import("./server.mjs")
  // 界面开关 `autorefresh` → 面板默认设置（用户自己在面板里勾过就以面板文件为准，
  // 见 server.mjs 的 `effectiveSettings` 合并顺序）。
  let autoRefresh
  try {
    const v = input?.magpie?.option?.(PROVIDER, "autorefresh")
    if (typeof v === "boolean") autoRefresh = v
  } catch {
    autoRefresh = undefined
  }
  return serve(input, autoRefresh === undefined ? options : { ...options, autoRefresh, fromOption: true })
}

/**
 * 测试与排障用的内部引用。
 *
 * ⚠ 挂在一个对象上，不要散着导出 —— 入口的每个具名导出都会被当成插件调用。
 */
export const _internal = {
  PROVIDER,
  MODEL_BASE_URL,
  PLATFORM_BASE_URL,
  DEFAULT_MODEL_ID,
  makeConfigHook,
  makeMethods,
  makeLoaderHook,
  makeModelsHook,
  makeUsageHook,
  makeRefresher,
}
