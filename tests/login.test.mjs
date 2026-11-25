// login.test.mjs 真登录：手机号 + 短信（form-urlencoded，不带滑块）+ 浏览器兜底。
//
// # 真机实测（2026-11-20，推翻了旧报告）
//
//	POST https://llm.rrzu.com/api/sendVerifyCode
//	  content-type: application/x-www-form-urlencoded
//	  body: phone=13800000000&type=login
//	→ {"data":null,"message":"验证码发送成功","success":true}          ← 不带滑块也成功
//	再来一次 → {"message":"验证码发送过于频繁，请稍后再试","success":false}
//
// 旧报告用 JSON 打所以失败，误判成「滑块是硬门槛」。

import { test } from "node:test"
import assert from "node:assert/strict"

import { QuWorkAuthPlugin } from "../index.mjs"
import {
  PHONE_RE,
  CODE_RE,
  deviceIdentifierFrom,
  usableSource,
  isRateLimited,
  isCodeError,
  sendVerifyCode,
} from "../src/login.mjs"
import { parseSessionFromSqlite, yamlValue, readLocalCredential } from "../src/browser-login.mjs"

const LLM = "sk-llm-token"
const PLATFORM = "platform-token"
const EXPIRE_SEC = 1_800_000_000

function pluginWith(opts = {}) {
  // ⚠ 必须把全部 opts 透传：否则 exists/openExternal 注入不进去，
  //    测试会真的去启动本机的 QuWork 客户端。
  return QuWorkAuthPlugin({}, { log: { warn() {} }, platform: "win32", ...opts })
}

/** 找出「手机号 + 短信」那一项。 */
async function smsMethod(deps = {}) {
  const p = await pluginWith(deps)
  return p.auth.methods.find((m) => String(m.label).includes("手机号"))
}

// ── 形状 ───────────────────────────────────────────────────────────────

test("两个 oauth 方法的形状：type / prompts / authorize / callback 都在", async () => {
  const p = await pluginWith({})
  const oauth = p.auth.methods.filter((m) => m.type === "oauth")
  assert.ok(oauth.length >= 2, "至少有「手机号」和「浏览器」两条 oauth")

  const sms = oauth.find((m) => String(m.label).includes("手机号"))
  assert.ok(sms, "必须有「手机号 + 短信验证码」")
  assert.ok(Array.isArray(sms.prompts) && sms.prompts.length === 1)
  assert.equal(typeof sms.authorize, "function")
  assert.equal(typeof sms.callback, "function", "magpie 会直接调 callback")

  const browser = oauth.find((m) => /客户端|浏览器/.test(String(m.label)))
  assert.ok(browser)
  assert.equal(typeof browser.authorize, "function")
  assert.equal(typeof browser.callback, "function")
})

test("手机号 validate：合法返回 null，非法返回字符串", async () => {
  const sms = await smsMethod({})
  const phone = sms.prompts[0]
  assert.equal(phone.key, "phone")
  assert.equal(phone.type, "text")
  assert.equal(phone.validate("13800000000"), null)
  assert.equal(typeof phone.validate("12345"), "string")
  assert.equal(typeof phone.validate(""), "string")
  assert.equal(typeof phone.validate("23800000000"), "string", "1[3-9] 之外要拒")
  assert.equal(PHONE_RE.test("13800000000"), true)
  assert.equal(CODE_RE.test("123456"), true)
  assert.equal(CODE_RE.test("1234"), true)
  assert.equal(CODE_RE.test("12"), false)
})

// ── authorize（发码）─────────────────────────────────────────────────────

test("authorize：form-urlencoded 提交、不带 aliyun_captcha；成功 → {method:\"code\", callback}", async () => {
  /** @type {any} */
  let seen = null
  const sms = await smsMethod({
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init }
      return Response.json({ data: null, message: "验证码发送成功", success: true })
    },
  })

  const r = await sms.authorize({ phone: "13800000000" })

  assert.match(String(seen.url), /\/api\/sendVerifyCode$/)
  assert.equal(String(seen.url).includes("aliyun_captcha"), false, "不需要滑块票据")
  const ct = String(new Headers(seen.init.headers).get("content-type"))
  assert.match(ct, /application\/x-www-form-urlencoded/)
  const body = String(seen.init.body)
  assert.match(body, /phone=13800000000/)
  assert.match(body, /type=login/)

  assert.equal(r.method, "code")
  assert.equal(typeof r.callback, "function")
  assert.match(String(r.instructions), /13800000000/)
})

test("authorize：发码太频繁 → {type:\"failed\"}，error 含原文案", async () => {
  const sms = await smsMethod({
    fetchImpl: async () =>
      Response.json({ message: "验证码发送过于频繁，请稍后再试", success: false }),
  })

  const r = await sms.authorize({ phone: "13800000000" })
  assert.equal(r.type, "failed")
  assert.match(String(r.error), /过于频繁/)
  assert.equal(isRateLimited("验证码发送过于频繁，请稍后再试"), true)
})

test("authorize：手机号非法 → failed，且**不发请求**", async () => {
  let called = 0
  const sms = await smsMethod({
    fetchImpl: async () => {
      called += 1
      return Response.json({ success: true })
    },
  })
  const r = await sms.authorize({ phone: "123" })
  assert.equal(r.type, "failed")
  assert.equal(called, 0)
})

// ── callback（登录即注册）────────────────────────────────────────────────

test("callback：成功 → access=llm_token、refresh=token、expires=expire*1000、accountId=手机号", async () => {
  /** @type {any[]} */
  const calls = []
  const sms = await smsMethod({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).includes("sendVerifyCode")) return Response.json({ success: true, message: "验证码发送成功" })
      return Response.json({
        success: true,
        data: { token: PLATFORM, llm_token: LLM, expire: EXPIRE_SEC, user: { id: "u-42", phone: "13800000000" } },
      })
    },
  })

  await sms.authorize({ phone: "13800000000" })
  const r = await sms.callback("123456")

  const login = calls.find((c) => c.url.includes("/api/user/client/login"))
  assert.ok(login, "应当调登录接口")
  const payload = JSON.parse(String(login.init.body))
  assert.equal(payload.phone, "13800000000")
  assert.equal(payload.verification_code, "123456")
  assert.equal(payload.platform, "qurvis")
  assert.match(String(payload.device_identifier), /^[0-9a-f]{64}$/)
  assert.equal(payload.device_uuid, "")

  assert.equal(r.type, "success")
  assert.equal(r.access, LLM, "access 必须是 llm_token（loader 用它）")
  assert.equal(r.refresh, PLATFORM)
  assert.equal(r.expires, EXPIRE_SEC * 1000, "expires 用毫秒")
  assert.equal(r.accountId, "13800000000")
  assert.ok("refresh" in r, "keptAs 靠 refresh 字段判断是否保留")
})

test("callback：验证码格式不对 → failed，且**不发请求**", async () => {
  let called = 0
  const sms = await smsMethod({
    fetchImpl: async (url) => {
      called += 1
      if (String(url).includes("sendVerifyCode")) return Response.json({ success: true })
      throw new Error("不该走到登录")
    },
  })
  await sms.authorize({ phone: "13800000000" })
  const before = called
  const r = await sms.callback("12")

  assert.equal(r.type, "failed")
  assert.equal(called, before, "格式错不该发请求")
})

test("callback：验证码错（success:false）→ failed，error 含平台文案", async () => {
  const sms = await smsMethod({
    fetchImpl: async (url) => {
      if (String(url).includes("sendVerifyCode")) return Response.json({ success: true })
      return Response.json({ success: false, message: "验证码错误或已过期" })
    },
  })
  await sms.authorize({ phone: "13800000000" })
  const r = await sms.callback("123456")

  assert.equal(r.type, "failed")
  assert.match(String(r.error), /验证码/)
  assert.equal(isCodeError("验证码错误或已过期"), true)
})

test("callback：登录成功但没有 llm_token → failed，提示改用浏览器登录", async () => {
  const sms = await smsMethod({
    fetchImpl: async (url) => {
      if (String(url).includes("sendVerifyCode")) return Response.json({ success: true })
      return Response.json({ success: true, data: { token: PLATFORM, expire: EXPIRE_SEC } })
    },
  })
  await sms.authorize({ phone: "13800000000" })
  const r = await sms.callback("123456")

  assert.equal(r.type, "failed")
  assert.match(String(r.error), /llm_token/)
  assert.match(String(r.error), /浏览器/)
})

// ── 打开客户端登录（自动抓取）──────────────────────────────────────────

test("登录入口方法：启动客户端后轮询到新凭据 → success；读不到 → failed", async () => {
  // 快照读 → 空（本机没登录过），轮询读 → 新凭据
  /** @type {any[]} */
  const queue = [
    { ok: false, error: "没找到" },
    { ok: true, llmToken: LLM, token: PLATFORM, expire: EXPIRE_SEC, source: "sqlite" },
  ]
  let reads = 0
  let clock = 0

  const p = await pluginWith({
    exists: () => false,
    readRegistry: () => "",
    openExternal: async () => {},
    pollIntervalMs: 1,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    readLocal: () => {
      const v = queue[Math.min(reads, queue.length - 1)]
      reads += 1
      return v
    },
  })

  const entry = p.auth.methods.find((m) => /客户端|浏览器/.test(String(m.label)))
  const started = await entry.authorize({})
  assert.equal(started.method, "other")
  assert.ok(String(started.url).startsWith("https://"), "没有客户端时退化到网页：要给出 url")

  const ok = await started.callback(undefined, {})
  assert.equal(ok.type, "success")
  assert.equal(ok.access, LLM)
  assert.equal(ok.refresh, PLATFORM)

  // 一直读不到 → failed
  let clock2 = 0
  const p2 = await pluginWith({
    exists: () => false,
    readRegistry: () => "",
    openExternal: async () => {},
    pollIntervalMs: 1,
    pollMs: 5,
    sleep: async (ms) => {
      clock2 += ms
    },
    now: () => clock2,
    readLocal: () => ({ ok: false, error: "没找到" }),
  })
  const entry2 = p2.auth.methods.find((m) => /客户端|浏览器/.test(String(m.label)))
  const failed = await (await entry2.authorize({})).callback(undefined, {})
  assert.equal(failed.type, "failed")
})

test("parseSessionFromSqlite：能从字节里取出 llmToken/accessToken/expiresAt", () => {
  const buf = Buffer.from(
    `SQLite format 3\u0000...auth_session...{"accessToken":"${PLATFORM}","llmToken":"${LLM}","expiresAt":1800000000000,"createdAt":1}...`,
    "utf8",
  )
  const s = parseSessionFromSqlite(buf)
  assert.equal(s.llmToken, LLM)
  assert.equal(s.accessToken, PLATFORM)
  assert.equal(s.expiresAt, 1_800_000_000_000)

  assert.deepEqual(parseSessionFromSqlite("no session here"), { llmToken: "", accessToken: "", expiresAt: 0, updatedAt: 0 })
})

test("readLocalCredential：yaml 兜底读 QURIVS_LLM_API_KEY；两处都没有 → failed", () => {
  const paths = { sqlite: "X:/nope.sqlite", credentialsYaml: "X:/creds.yaml" }
  const files = { [paths.credentialsYaml]: `QURIVS_LLM_API_KEY: "${LLM}"\nDEEPSEEK_API_KEY: "${LLM}"\n` }
  const readFile = (p) => {
    if (files[p] === undefined) throw new Error("ENOENT")
    return files[p]
  }

  const ok = readLocalCredential({ paths, readFile })
  assert.equal(ok.ok, true)
  assert.equal(ok.llmToken, LLM)
  assert.equal(ok.source, "credentials-yaml")

  const bad = readLocalCredential({ paths, readFile: () => { throw new Error("ENOENT") } })
  assert.equal(bad.ok, false)
  assert.match(String(bad.error), /没在本机找到/)

  assert.equal(yamlValue(files[paths.credentialsYaml], "QURIVS_LLM_API_KEY"), LLM)
})

// ── device_identifier ───────────────────────────────────────────────────

test("device_identifier：确定输入 → 稳定 sha256；全 0 / 全 F 的来源被跳过", () => {
  const a = deviceIdentifierFrom({ machineGuid: "GUID-A", smbiosUuid: "UUID-B" })
  const b = deviceIdentifierFrom({ machineGuid: "GUID-A", smbiosUuid: "UUID-B" })
  assert.equal(a, b, "同输入必须同输出（一机一名额）")
  assert.match(a, /^[0-9a-f]{64}$/)

  // 全 0 UUID 视为厂商未写入 ⇒ 只用 MachineGuid
  const withZero = deviceIdentifierFrom({ machineGuid: "GUID-A", smbiosUuid: "00000000-0000-0000-0000-000000000000" })
  const onlyGuid = deviceIdentifierFrom({ machineGuid: "GUID-A" })
  assert.equal(withZero, onlyGuid, "全 0 来源必须被跳过")

  // 全 F 同理
  assert.equal(deviceIdentifierFrom({ machineGuid: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" }), deviceIdentifierFrom({}))
  assert.equal(usableSource("00000000000000000000000000000000"), false)
  assert.equal(usableSource("ffffffffffffffffffffffffffffffff"), false)
  assert.equal(usableSource("GUID-A"), true)
})

test("sendVerifyCode：HTTP 500 / 网络错不抛，返回 ok:false", async () => {
  const a = await sendVerifyCode({ phone: "13800000000", fetchImpl: async () => new Response("boom", { status: 500 }) })
  assert.equal(a.ok, false)

  const b = await sendVerifyCode({
    phone: "13800000000",
    fetchImpl: async () => {
      throw new Error("ECONNRESET")
    },
  })
  assert.equal(b.ok, false)
})

// ── 粘贴入口仍在（最后兜底）─────────────────────────────────────────────

test("粘贴入口仍保留，且排在两个真登录之后", async () => {
  const p = await pluginWith({})
  const labels = p.auth.methods.map((m) => m.label)
  const pasteIdx = labels.findIndex((l) => String(l).includes("粘贴"))
  const smsIdx = labels.findIndex((l) => String(l).includes("手机号"))
  const browserIdx = labels.findIndex((l) => /客户端|浏览器/.test(String(l)))

  assert.ok(pasteIdx > smsIdx && pasteIdx > browserIdx, `顺序不对: ${labels.join(" | ")}`)

  const paste = p.auth.methods[pasteIdx]
  const r = await paste.authorize({ llmToken: LLM, token: PLATFORM })
  assert.equal(r.type, "success")
  assert.equal(r.access, LLM)
  assert.ok("refresh" in r)
})