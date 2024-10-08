/*
 * Copyright (c) 2021-present, the hapjs-platform Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const path = require('path')
const { Writable } = require('stream')
const execa = require('execa')
const fetch = require('node-fetch')
const fkill = require('fkill')
const stripAnsi = require('strip-ansi')
const fs = require('fs-extra')
const { run, lsfiles, readZip, wipeDynamic } = require('hap-dev-utils')
const { compile } = require('../../packages/hap-toolkit/lib')

const cwd = path.resolve(__dirname, '../../examples/sample')
const buildBackup = path.resolve(__dirname, 'build-backup/sample')
fs.ensureDirSync(buildBackup)

describe('hap-toolkit', () => {
  const buildDir = path.resolve(cwd, 'build')
  const distDir = path.resolve(cwd, 'dist')
  fs.removeSync(distDir)

  it(
    'hap-build: 默认流式打包，包内存在META-INF文件',
    async () => {
      await run('npm', ['run', 'build'], [], { cwd })
      const rpks = await lsfiles('dist/*.rpk', { cwd })
      // TODO more details
      expect(rpks.length).toBe(1)
      let rpkPath = path.resolve(cwd, rpks[0])
      // 读取压缩包中的内容
      const packages = await readZip(rpkPath)
      const hasMeta = packages.files['META-INF/']
      const hasMetaCert = packages.files['META-INF/CERT']
      expect(hasMeta).toBeTruthy()
      expect(hasMetaCert).toBeTruthy()
    },
    6 * 60 * 1000
  )

  it(
    'hap-build [--disable-stream-pack]: 包内不存在META-INF文件',
    async () => {
      await run('npm', ['run', 'build', '-- --disable-stream-pack'], [], { cwd })
      const rpks = await lsfiles('dist/*.rpk', { cwd })
      let rpkPath = path.resolve(cwd, rpks[0])
      // 读取压缩包中的内容
      const packages = await readZip(rpkPath)
      const hasMeta = packages.files['META-INF/']
      expect(hasMeta).toBeFalsy()
    },
    6 * 60 * 1000
  )

  it(
    'hap-server',
    async () => {
      const serverReg = /服务器地址: (http:\/\/.*),/
      const dialogs = [
        {
          pattern: (output) => {
            return output.match(serverReg)
          },
          feeds: (proc, output) => {
            const match = output.match(serverReg)
            const url = match[1]
            const p1 = fetch(url)
              .then((res) => {
                expect(res.status).toBe(200)
                return res.text()
              })
              .then((text) => {
                expect(text).toMatch('<title>调试器</title>')
              })
            const p2 = fetch(url + '/qrcode')
              .then((res) => res.arrayBuffer())
              .then((buffer) => {
                expect(Buffer.from(buffer).readUInt32BE(0)).toBe(0x89504e47)
              })

            Promise.all([p1, p2]).then(async () => {
              await fkill(proc.pid)
            })
          }
        },
        {
          pattern: /listen EADDRINUSE: address already in use/,
          type: 'stderr',
          feeds: (proc, output) => {
            proc.kill('SIGINT')
            proc.kill('SIGTERM')
            throw new Error('address in use')
          }
        }
      ]

      await run('npm', ['run', 'server'], dialogs, { cwd })
    },
    6 * 60 * 1000
  )

  it(
    'missed release pem files',
    async () => {
      let happened = false
      const dialogs = [
        {
          pattern: /编译错误，缺少release签名私钥文件/,
          type: 'stderr',
          feeds: (proc, output) => {
            happened = true
          }
        }
      ]
      await run('npm', ['run', 'release'], dialogs, { cwd })
      /**
      TODO fix:
      在windows平台上， function talkTo 里面不能正确拿到完整的 stdout, stderr
       */

      expect(happened).toBe(true)
    },
    6 * 60 * 1000
  )

  // 这里会记录很多内容到 snapshots
  it(
    'compile native',
    async () => {
      const outputs = []
      const outputStream = new Writable({
        write(chunk, encoding, next) {
          outputs.push(chunk.toString())
          next()
        }
      })
      // 第三个参数为是否开启watch，true为开启
      // TODO other than `native`?
      const data = await compile('native', 'dev', false, {
        cwd,
        log: outputStream,
        buildNameFormat: 'CUSTOM=dev'
      })
      // 更详细的 snapshots
      const json = data.stats.toJson({
        source: true
      })
      const wipe = (content) =>
        wipeDynamic(content, [
          [cwd, '<project-root>'],
          [/大小为 \d+ KB/g, '大小为 <SIZE> KB']
        ])

      const rpks = await lsfiles('dist/*.rpk', { cwd })
      const hasCustom = rpks.some((item) => item.indexOf('dev') !== -1)
      expect(hasCustom).toBeTruthy()
      expect(
        `length: ${json.assets.length}\n` +
          json.assets
            .map((a) => a.name)
            .sort()
            .join('\n')
      ).toMatchSnapshot('assets list')

      const output = stripAnsi(outputs.join('\n'))
      // TODO expect(wipe(output)).toMatchSnapshot('outputs')
      expect(wipe(output)).not.toBeNull()

      const Promises = Promise.all(
        json.assets.map((asset) => {
          const fullpath = path.resolve(buildDir, asset.name)
          const destpath = path.resolve(buildBackup, asset.name)
          let content = fs.readFileSync(fullpath, { encoding: 'utf-8' })
          content = wipe(content)
          return fs.writeFile(destpath, content, { encoding: 'utf-8' })
        })
      )
      await Promises

      // git ls-files -m
      const files = execa.sync('git', ['ls-files', '-m']).stdout
      expect(!files.match(`build-backup`)).toBeTruthy()
    },
    6 * 60 * 1000
  )
})
