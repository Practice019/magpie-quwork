// models-fallback.test.mjs —— CONTRACT 6-02：不是账号自己的列表必须打标记。
//
// 宿主读 Symbol.for("magpie.fellBack")；带标记的列表不参与路由。quwork 有三处
// 回退静态表（未登录 / 上游返回空 / 拉取抛错），三处都必须带标记，否则一次上游
// 抖动就会让静态表被当成账号的计划去派活。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeModelsHook } from '../src/hooks/models.mjs'

const FALLBACK = Symbol.for('magpie.fellBack')

test('CONTRACT 6-02: 未登录给静态表，且标 falls back', async () => {
  const models = makeModelsHook({ configDir: '', log: { warn() {} } })
  const got = await models({ models: {} }, { auth: undefined })
  assert.equal(got[FALLBACK], true)
  assert.ok(Object.keys(got).length > 0, '静态表不能是空的')
})

test('CONTRACT 6-02: 上游拉取失败回退静态表，也带标记', async () => {
  const models = makeModelsHook({
    configDir: '',
    log: { warn() {} },
    fetchImpl: async () => { throw new Error('network down') },
  })
  const got = await models({ models: {} }, { auth: { llmToken: 'tok' } })
  assert.equal(got[FALLBACK], true)
})
