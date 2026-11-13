import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { runIndependentTests } from '../../server/services/independent-testing.mjs'
const directories = []
afterEach(async () => { for (const directory of directories.splice(0)) { expect(directory.startsWith(os.tmpdir() + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true }) } })
it('blocks candidate acceptance when independently authored tests fail despite existing tests passing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-independent-tests-')); directories.push(root)
  const source = path.join(root, 'source'); await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'app.mjs'), 'export const answer = 42\n')
  await fs.writeFile(path.join(source, 'verify.mjs'), 'console.log("existing tests pass")\n')
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node verify.mjs' } }))
  const project = { id: crypto.randomUUID(), name: 'fixture', path: source }
  const input = { workflow: { id: 'fixture-workflow', prompt: 'Check answer independently.' }, node: { id: 'tester' }, signal: new AbortController().signal }
  const common = { input, artifact: { adapter: { source } }, project, dataDir: path.join(root, 'data'), onTask: async () => {}, trusted: (_workflow, _signal, operation) => operation() }
  const result = await runIndependentTests({ ...common, draft: { testFiles: [{ path: 'nexus-tests/answer.test.mjs', content: 'import {test} from "node:test"; import assert from "node:assert/strict"; import {answer} from "../app.mjs"; test("wrong candidate expectation",()=>assert.equal(answer,99));\n' }] } })
  expect(result.independentTestsAuthored).toBe(true)
  expect(result.checks[0].ok).toBe(true)
  expect(result.checks.find((check) => check.name === 'independent-tests').exitCode).not.toBe(0)
  expect(result.verified).toBe(false)
  expect(await fs.readdir(source)).toEqual(['app.mjs', 'package.json', 'verify.mjs'])
  await expect(runIndependentTests({ ...common, draft: { testFiles: [{ path: '../app.mjs', content: 'overwrite production code' }] } })).rejects.toMatchObject({ code: 'WORKFLOW_TEST_PLAN_INVALID' })
}, 30000)
