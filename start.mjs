import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('사용법: node start.mjs [--share]\n--share: 임시 HTTPS 주소를 만들어 외부 참가자를 초대합니다.')
} else if (args.some(arg => arg !== '--share')) {
  console.error('알 수 없는 옵션입니다. node start.mjs --help를 실행하세요.')
  process.exitCode = 1
} else {
  await start(args.includes('--share'))
}

async function findExecutable(name, configured) {
  const path = process.env.PATH || process.env.Path || ''
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const candidates = configured
    ? [resolve(configured)]
    : path.split(delimiter).filter(Boolean).map(dir => resolve(dir.replace(/^"|"$/g, ''), name + suffix))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      continue
    }
  }
  return null
}

async function start(share) {
  const [tunnelBin, whisper, ffmpeg] = await Promise.all([
    share ? findExecutable('cloudflared', process.env.CLOUDFLARED_BIN) : null,
    findExecutable('whisper-cli', process.env.WHISPER_BIN),
    findExecutable('ffmpeg', process.env.FFMPEG_BIN),
  ])
  if (share && !tunnelBin) {
    console.error('cloudflared를 설치하고 PATH에 추가하거나 CLOUDFLARED_BIN에 실행 파일 경로를 지정하세요.')
    process.exitCode = 1
    return
  }

  const env = { ...process.env }
  const model = env.WHISPER_MODEL
    ? resolve(env.WHISPER_MODEL)
    : fileURLToPath(new URL('./.models/ggml-base.bin', import.meta.url))
  const modelFile = await stat(model).catch(() => null)
  if (whisper && ffmpeg && modelFile?.isFile() && modelFile.size > 0) {
    Object.assign(env, { WHISPER_MODEL: model, WHISPER_BIN: whisper, FFMPEG_BIN: ffmpeg })
    console.log('한국어 회의록 변환을 사용할 수 있습니다.')
  } else {
    delete env.WHISPER_MODEL
    console.log('텍스트 회의록을 활성화하려면 whisper-cli, ffmpeg, Whisper 모델을 준비하세요.')
  }

  const children = new Set()
  let stopping = false
  function stop(code) {
    if (stopping) return
    stopping = true
    process.exitCode = code
    for (const child of children) child.kill()
  }
  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))

  function launch(bin, argv, options, name) {
    const child = spawn(bin, argv, { ...options, windowsHide: true })
    children.add(child)
    child.on('error', error => {
      console.error(name + ' 실행 실패: ' + error.message)
      stop(1)
    })
    child.on('exit', code => {
      children.delete(child)
      if (!stopping) {
        console.error(name + ' 프로세스가 종료되었습니다.')
        stop(code || 1)
      }
    })
    return child
  }

  const server = fileURLToPath(new URL('./server.mjs', import.meta.url))
  const app = launch(process.execPath, [server], { env, stdio: ['ignore', 'pipe', 'inherit'] }, '모여 서버')
  let tunnelStarted = false
  createInterface({ input: app.stdout }).on('line', line => {
    console.log(line)
    const address = line.match(/^모여 · (http:\/\/\S+)$/)?.[1]
    if (!share || tunnelStarted || stopping || !address) return
    tunnelStarted = true
    const target = address.replace('http://0.0.0.0:', 'http://127.0.0.1:')
    const tunnel = launch(tunnelBin, [
      'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', target,
    ], { stdio: ['ignore', 'pipe', 'pipe'] }, 'HTTPS 터널')
    let publicAddress
    for (const stream of [tunnel.stdout, tunnel.stderr]) {
      createInterface({ input: stream }).on('line', output => {
        console.log(output)
        publicAddress ||= output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0]
        if (publicAddress && output.includes('Registered tunnel connection')) {
          console.log('외부 접속 주소 ' + publicAddress)
        }
      })
    }
  })
}
