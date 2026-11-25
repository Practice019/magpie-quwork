// shape.test.mjs **装载形状**：magpie 真机上认的形状（踩过 `map is not a function`）。
//
// # 真机报错原文
//
//	magpie: (auth.methods ?? []).map is not a function
//
// 因为 `auth.methods` 被当数组 `map`。返回对象/函数都会炸 —— 这条测试就是
// 防止再犯：它不看实现细节，只看 magpie 会读到的那几个字段。

import { test } from "node:test"
import assert from "node:assert/strict"

import { QuWorkAuthPlugin } from "../index.mjs"

const SESSION_AUTH = { llmToken: "sk-test", access: "sk-test", token: "pt", expire: 1 }

const p = await QuWorkAuthPlugin({}, {})

test("auth.methods 是**数组**（不是对象、不是函数）", () => {
  assert.ok(Array.isArray(p.auth.methods), `实际类型: ${typeof p.auth.methods}`)
  // ① 手机号+短信 ② 浏览器登录 ③④ 两种粘贴 ⑤ 从文件导入（粘贴）
  assert.equal(p.auth.methods.length, 5)
})

test("Linux 下自动抓取明确失败，短信/粘贴/导入仍保留", async () => {
  const linux = await QuWorkAuthPlugin({}, { platform: "linux" })
  const browser = linux.auth.methods.find((m) => /客户端|浏览器/.test(String(m.label)))
  const failed = await browser.authorize({})
  assert.equal(failed.type, "failed")
  assert.match(failed.error, /只支持 Windows/)
  const labels = linux.auth.methods.map((m) => String(m.label))
  assert.ok(labels.some((l) => l.includes("手机号")))
  assert.ok(labels.filter((l) => l.startsWith("粘贴")).length >= 2)
})

test("每项都有 type / label；prompts（若有）结构合法", () => {
  for (const m of p.auth.methods) {
    assert.equal(typeof m.type, "string")
    assert.ok(m.label && typeof m.label === "string", "label 必须有（界面显示）")
    assert.equal(m.type, "oauth", "只用已验证可装载的 type")
    if (m.prompts === undefined) continue
    assert.ok(Array.isArray(m.prompts), "prompts 必须是数组")
    for (const pr of m.prompts) {
      assert.ok(["text", "password", "select"].includes(pr.type), `prompt.type 取值: ${pr.type}`)
      assert.equal(typeof pr.key, "string")
      assert.equal(typeof pr.message, "string")
      if (pr.placeholder !== undefined) assert.equal(typeof pr.placeholder, "string")
    }
  }
})

test("五项顺序：手机号 → 客户端登录 → 两种粘贴 → 从文件导入（兜底在最后）", () => {
  const labels = p.auth.methods.map((m) => String(m.label))
  assert.match(labels[0], /手机号/)
  assert.match(labels[1], /客户端|浏览器/)
  assert.match(labels[2], /粘贴/)
  assert.match(labels[3], /粘贴/)
  assert.match(labels[4], /从文件导入/)
})

test("粘贴项问的 key：第一项只有 llmToken，第二项 llmToken+token", () => {
  const paste = p.auth.methods.filter((m) => String(m.label).startsWith("粘贴"))
  assert.deepEqual(paste[0].prompts.map((x) => x.key), ["llmToken"])
  assert.deepEqual(paste[1].prompts.map((x) => x.key), ["llmToken", "token"])
  assert.equal(paste[0].prompts[0].type, "password", "token 类字段要遮起来")
})

test("magpie 会 map 出的三个字段都在（type / label / labels 可选）", () => {
  const projected = p.auth.methods.map((m) => ({ type: m.type, label: m.label, labels: m.labels }))
  assert.equal(projected.length, 5)
  assert.ok(projected.every((x) => x.type === "oauth" && typeof x.label === "string"))
})

test("其余钩子都是函数：config / auth.loader / auth.usage / provider.models", () => {
  assert.equal(typeof p.config, "function")
  assert.equal(typeof p.auth.loader, "function")
  assert.equal(typeof p.auth.usage, "function")
  assert.equal(typeof p.provider.models, "function")
})

test("auth.usage 接受 getAuth 参数：传一个函数调用不抛", async () => {
  const u = await p.auth.usage(async () => SESSION_AUTH)
  assert.ok(u && typeof u === "object")
  assert.ok(Array.isArray(u.windows), "usage 必须返回 {windows: [...]}")
  for (const w of u.windows) assert.equal(typeof w.name, "string")
})

test("auth.loader 接受 getAuth 参数，返回带 fetch 的对象", async () => {
  const loader = await p.auth.loader(async () => SESSION_AUTH)
  assert.equal(typeof loader.fetch, "function")
  assert.equal(typeof loader.baseURL, "string")
  assert.equal(loader.apiKey, SESSION_AUTH.llmToken)
})

test("provider.models 接受 (provider, ctx) 参数，返回按 id 索引的对象", async () => {
  const models = await p.provider.models({}, { auth: SESSION_AUTH })
  assert.ok(models && typeof models === "object" && !Array.isArray(models), "必须是 id→model 的对象")
  assert.ok(Object.keys(models).length > 0)
  const first = models[Object.keys(models)[0]]
  assert.equal(typeof first.id, "string")
  assert.ok(first.limit && typeof first.limit.context === "number")
})

test("config 原地写入 provider 条目（宿主不看返回值）", () => {
  // ⚠ host.js L1567 丢弃 config() 的返回值，只读它改过的 cfg 本身。
  const cfg = { provider: {} }
  const ret = p.config(cfg)
  assert.equal(ret, undefined, "不能返回新对象：宿主不会用")
  assert.equal(typeof cfg.provider.quwork.baseURL, "string")
  assert.match(cfg.provider.quwork.baseURL, /llm\.quwork\.cn\/v1$/)
})