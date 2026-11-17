import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createTranscript, serveTranscript } from './transcripts.mjs'

const files = new Map(await Promise.all([
  ['/', 'index.html', 'text/html'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/recording.js', 'recording.js', 'text/javascript'],
  ['/style.css', 'style.css', 'text/css'],
].map(async ([path, name, type]) => [
  path, [await readFile(new URL('./public/' + name, import.meta.url)), type],
])))
const rooms = new Map()
const roomLimit = 6
const iceServers = JSON.parse(process.env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]')

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function send(member, value) {
  if (member.queue.length >= 256) {
    member.overflow = true
    return
  }
  member.queue.push(value)
}

function broadcast(room, value, exclude) {
  for (const member of room.values()) {
    if (member.id !== exclude) send(member, value)
  }
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65536) throw new Error('Body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}

function removeMember(roomId, room, id) {
  const recording = room.get(id)?.profile.recording
  room.delete(id)
  if (recording) broadcast(room, { type: 'recording', recorder: null })
  broadcast(room, { type: 'leave', id })
  if (!room.size) rooms.delete(roomId)
}

setInterval(() => {
  const cutoff = Date.now() - 30000
  for (const [roomId, room] of rooms) {
    for (const member of room.values()) {
      if (member.seen < cutoff || member.overflow) removeMember(roomId, room, member.id)
    }
  }
}, 5000).unref()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const file = files.get(url.pathname)
    if (req.method === 'GET' && file) {
      res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' })
      return res.end(file[0])
    }

    if (url.pathname === '/api/transcripts') return await serveTranscript(req, res, json)
    const roomId = /^\/api\/rooms\/([a-f0-9-]{36})$/.exec(url.pathname)?.[1]
    if (!roomId) return json(res, 404, { error: '페이지를 찾을 수 없습니다.' })

    if (req.method !== 'POST') return json(res, 405, { error: '지원하지 않는 요청입니다.' })
    const data = await readJson(req)
    if (data?.type === 'join') {
      const name = typeof data.name === 'string' && data.name.trim().slice(0, 30)
      if (!name) return json(res, 400, { error: '이름을 입력해 주세요.' })
      const room = rooms.get(roomId) || new Map()
      if (room.size >= roomLimit) return json(res, 409, { error: '회의가 가득 찼습니다.' })
      const id = randomUUID()
      const token = randomUUID()
      const profile = { id, name, video: false, audio: false, sharing: false }
      const peers = [...room.values()].map(member => member.profile)
      rooms.set(roomId, room)
      room.set(id, { id, token, profile, queue: [], seen: Date.now() })
      broadcast(room, { type: 'join', profile }, id)
      return json(res, 200, { type: 'welcome', id, token, iceServers, peers })
    }

    const room = rooms.get(roomId)
    const member = room?.get(data?.id)
    if (!member || member.token !== data.token || member.overflow) {
      return json(res, 403, { error: '다시 입장해 주세요.' })
    }
    member.seen = Date.now()
    const { id, profile } = member
    switch (data.type) {
      case 'poll':
        return json(res, 200, member.queue.splice(0))
      case 'leave':
        removeMember(roomId, room, id)
        break
      case 'recording': {
        if (data.active === true) {
          if ([...room.values()].some(peer => peer.profile.recording)) {
            return json(res, 409, { error: '이미 참가자가 녹음 중입니다.' })
          }
          profile.recording = true
          broadcast(room, { type: 'recording', recorder: profile })
          return json(res, 200, { transcriptToken: createTranscript() })
        }
        if (profile.recording) {
          profile.recording = false
          broadcast(room, { type: 'recording', recorder: null })
        }
        break
      }
      case 'signal': {
        const target = room.get(data.to)
        if (target && target !== member) {
          send(target, { type: 'signal', from: id, description: data.description, candidate: data.candidate })
        }
        break
      }
      case 'chat': {
        const message = typeof data.text === 'string' && data.text.trim().slice(0, 1000)
        if (message) broadcast(room, { type: 'chat', id, name: profile.name, text: message, time: Date.now() })
        break
      }
      case 'state':
        for (const key of ['video', 'audio', 'sharing']) profile[key] = data[key] === true
        broadcast(room, { type: 'state', profile }, id)
        break
      default:
        return json(res, 400, { error: '지원하지 않는 메시지입니다.' })
    }
    res.writeHead(204).end()
  } catch {
    if (!res.headersSent) json(res, 400, { error: '요청을 처리하지 못했습니다.' })
    else res.end()
  }
})

const host = process.env.HOST || '127.0.0.1'
server.listen(Number(process.env.PORT || 8787), host, () => {
  console.log('모여 · http://' + host + ':' + server.address().port)
})
