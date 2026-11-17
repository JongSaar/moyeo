import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const model = process.env.WHISPER_MODEL
const jobs = new Map()
const maxUpload = 32 * 1024 * 1024
let busy = false

setInterval(() => {
  for (const [token, job] of jobs) {
    if (job.expires <= Date.now() && job.status !== 'processing') jobs.delete(token)
  }
}, 60000).unref()

export function createTranscript() {
  if (!model || jobs.size >= 512) return null
  const token = randomUUID()
  jobs.set(token, { status: 'ready', expires: Date.now() + 7200000 })
  return token
}

const formats = new Map([
  ['audio/webm', 'matroska'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'mov'],
  ['audio/wav', 'wav'],
])

export async function serveTranscript(req, res, json) {
  const token = req.headers.authorization?.match(/^Bearer ([a-f0-9-]{36})$/)?.[1]
  const job = jobs.get(token)
  if (!job || job.expires <= Date.now()) return json(res, 404, { error: '회의록 생성 시간이 만료되었습니다.' })
  if (req.method === 'GET') return json(res, 200, { status: job.status, text: job.text, error: job.error })
  if (req.method !== 'POST') return json(res, 405, { error: '지원하지 않는 요청입니다.' })
  if (job.status !== 'ready') return json(res, 409, { error: '이미 변환을 시작했습니다.' })
  const format = formats.get(req.headers['content-type']?.split(';')[0])
  if (!format) return json(res, 415, { error: '지원하지 않는 녹음 형식입니다.' })
  const length = Number(req.headers['content-length'])
  if (length > maxUpload) return json(res, 413, { error: '음성 파일은 32MB까지 변환할 수 있습니다.' })
  if (busy) return json(res, 429, { error: '다른 회의록을 변환하고 있습니다. 잠시 뒤 다시 시도해 주세요.' })

  busy = true
  job.status = 'processing'
  let dir
  let size = 0
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length
      callback(size > maxUpload ? new Error('Upload limit') : null, chunk)
    },
  })
  try {
    dir = await mkdtemp(join(tmpdir(), 'moyeo-transcript-'))
    const input = join(dir, 'recording')
    await pipeline(req, limit, createWriteStream(input), { signal: AbortSignal.timeout(60000) })
    json(res, 202, { status: job.status })
    const wav = join(dir, 'speech.wav')
    const output = join(dir, 'transcript')
    const options = { timeout: 600000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }
    await run(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-nostdin', '-v', 'error', '-f', format, '-protocol_whitelist', 'file',
      '-i', input, '-map', '0:a:0', '-t', '1801', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
    ], options)
    await run(process.env.WHISPER_BIN || 'whisper-cli', [
      '-m', model, '-f', wav, '-l', 'ko', '-otxt', '-of', output,
    ], options)
    job.text = (await readFile(output + '.txt', 'utf8')).trim()
    job.status = 'done'
    job.expires = Date.now() + 1800000
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      job.status = 'ready'
      json(res, 400, { error: '녹음 파일을 올리지 못했습니다.' })
    } else {
      job.status = 'failed'
      job.error = '회의록을 변환하지 못했습니다. 녹음 파일은 다운로드할 수 있습니다.'
      console.error('Transcript conversion:', error.code || error.name)
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    busy = false
  }
}
