import { showRecorder, startRecording, stopRecording, syncRecording } from './recording.js'

const $ = id => document.getElementById(id)
const roomPattern = /^[a-f0-9-]{36}$/
const queryRoom = new URLSearchParams(location.search).get('room')
let meeting
let noticeTimer

function notice(text) {
  $('notice').textContent = text
  $('notice').hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { $('notice').hidden = true }, 5200)
}

function showLobby() {
  const invited = roomPattern.test(new URLSearchParams(location.search).get('room'))
  $('lobby').hidden = false
  $('meeting').hidden = true
  $('headline').textContent = invited ? '회의에 참여하기' : '바로 만나는 화상회의.'
  $('intro-copy').textContent = invited ? '회의에 표시할 이름을 입력하세요.' : '회의를 열고 초대 링크를 공유하세요.'
  $('join-button').textContent = invited ? '회의 입장 ↗' : '새 회의 시작 ↗'
  $('status').textContent = '화상회의'
}

function tile(profile, local = false) {
  const root = document.createElement('article')
  const video = document.createElement('video')
  const avatar = document.createElement('span')
  const label = document.createElement('span')
  root.className = 'tile'
  avatar.className = 'avatar'
  label.className = 'tile-label'
  video.autoplay = true
  video.playsInline = true
  video.muted = local
  video.addEventListener('click', () => video.play().catch(() => {}))
  root.append(avatar, video, label)
  $('tiles').append(root)
  const view = { root, video, avatar, label, local }
  updateTile(view, profile)
  return view
}

function updateTile(view, profile) {
  view.avatar.textContent = Array.from(profile.name)[0]
  view.label.textContent = profile.name + (view.local ? ' (나)' : '') +
    (profile.audio ? '' : ' · 음소거') + (profile.sharing ? ' · 화면 공유' : '')
  view.video.classList.toggle('audio-only', !profile.video)
  view.video.classList.toggle('sharing', profile.sharing)
}

function request(session, payload, keepalive = false) {
  return fetch(session.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, id: session.id, token: session.token }),
    signal: keepalive ? undefined : AbortSignal.timeout(8000),
    keepalive,
  })
}

async function post(session, payload) {
  if (meeting !== session || !session.token) throw new Error('연결을 확인해 주세요.')
  const response = await request(session, payload)
  if (!response.ok) throw new Error('회의 서버에 메시지를 보내지 못했습니다.')
}

async function listen(session) {
  while (meeting === session) {
    try {
      if (!session.token) {
        const response = await request(session, { type: 'join', name: session.name })
        if (response.status === 409) {
          await handle(session, { type: 'full' })
          return
        }
        if (!response.ok) throw new Error('입장하지 못했습니다.')
        if (meeting === session) await handle(session, await response.json())
      } else {
        const response = await request(session, { type: 'poll' })
        if (meeting !== session) return
        if (response.status === 403) {
          stopRecording(session, request, notice)
          session.token = null
          for (const id of session.peers.keys()) removePeer(session, id)
          continue
        }
        if (!response.ok) throw new Error('연결을 확인해 주세요.')
        $('status').textContent = '회의 연결됨'
        for (const message of await response.json()) {
          if (meeting !== session) return
          try {
            await handle(session, message)
          } catch {
            if (meeting === session) notice('회의 연결 중 오류가 발생했습니다.')
          }
        }
      }
    } catch {
      if (meeting !== session) return
      if ($('meeting').hidden) {
        leave()
        notice('회의 서버에 연결하지 못했습니다.')
        return
      }
      stopRecording(session, request, notice)
      $('status').textContent = '다시 연결 중'
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

function tracks(session) {
  return { audio: session.audio, video: session.screen || session.camera }
}

function setMicFeedback(text) {
  if ($('mic-feedback').textContent !== text) $('mic-feedback').textContent = text
}

function stopMicMeter(session) {
  if (session.micMeter) {
    clearInterval(session.micMeter.timer)
    session.micMeter.context.close().catch(() => {})
    session.micMeter = null
  }
  $('mic-level').value = 0
  setMicFeedback('마이크 꺼짐')
}

function prepareMicMeter(session) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    const context = new AudioContext()
    session.micMeter = { context }
    context.resume().catch(() => {})
  } catch {
    // Audio metering is optional on browsers that cannot open an audio context.
  }
}

function startMicMeter(session, track) {
  const meter = session.micMeter
  if (!meter) {
    setMicFeedback('입력 표시 사용 불가')
    return
  }
  try {
    const analyser = meter.context.createAnalyser()
    analyser.fftSize = 1024
    const source = meter.context.createMediaStreamSource(new MediaStream([track]))
    source.connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    let lastInput = -Infinity
    meter.timer = setInterval(() => {
      if (meter.context.state !== 'running') {
        $('mic-level').value = 0
        setMicFeedback('입력 표시 일시 중지')
        return
      }
      analyser.getFloatTimeDomainData(samples)
      const meanSquare = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length
      const rms = Math.sqrt(meanSquare)
      $('mic-level').value = Math.min(100, Math.round(rms * 400))
      const now = performance.now()
      if (rms >= 0.012) lastInput = now
      setMicFeedback(now - lastInput < 1200 ? '소리 감지됨' : '말해 보세요')
    }, 100)
    setMicFeedback('말해 보세요')
  } catch {
    stopMicMeter(session)
    setMicFeedback('입력 표시 사용 불가')
  }
}

function syncPeer(session, peer) {
  const local = tracks(session)
  return Promise.all(peer.pc.getTransceivers().map(transceiver => {
    const kind = transceiver.receiver.track.kind
    return transceiver.sender.replaceTrack(local[kind] || null)
  }))
}

async function publishMedia(session) {
  if (meeting !== session) return
  syncRecording(session)
  const { audio, video } = tracks(session)
  const state = { name: session.name, audio: !!audio, video: !!video, sharing: !!session.screen }
  session.self.video.srcObject = video ? new MediaStream([video]) : null
  updateTile(session.self, state)
  for (const [id, active, on, off] of [
    ['mic', state.audio, '마이크 끄기', '마이크 켜기'],
    ['camera', !!session.camera, '카메라 끄기', '카메라 켜기'],
    ['share', state.sharing, '공유 중지', '화면 공유'],
  ]) {
    $(id).textContent = active ? on : off
    $(id).setAttribute('aria-pressed', active)
  }
  const results = await Promise.allSettled([...session.peers.values()].map(peer => syncPeer(session, peer)))
  if (results.some(result => result.status === 'rejected')) notice('일부 참가자에게 미디어를 전송하지 못했습니다.')
  if (session.token) await post(session, { type: 'state', ...state })
}

function updateCount(session) {
  $('count').textContent = '참가자 ' + (session.peers.size + 1) + '명'
}

function removePeer(session, id) {
  const peer = session.peers.get(id)
  if (!peer) return
  session.peers.delete(id)
  syncRecording(session)
  peer.pc.close()
  peer.view.root.remove()
  updateCount(session)
}

function createPeer(session, profile) {
  const pc = new RTCPeerConnection({ iceServers: session.iceServers })
  const view = tile(profile)
  const stream = new MediaStream()
  view.video.srcObject = stream
  const peer = { pc, view, candidates: [] }
  session.peers.set(profile.id, peer)
  updateCount(session)
  pc.ontrack = event => {
    stream.addTrack(event.track)
    if (event.track.kind === 'audio') {
      peer.audioTrack = event.track
      syncRecording(session)
    }
    event.track.onunmute = () => {
      view.video.play().catch(() => {
        if (session.peers.has(profile.id)) notice('소리가 들리지 않으면 화면을 한 번 눌러 주세요.')
      })
    }
  }
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') notice(profile.name + ' 님과 연결하지 못했습니다.')
  }
  pc.onicecandidate = event => {
    if (event.candidate && session.token && session.peers.get(profile.id) === peer) {
      post(session, { type: 'signal', to: profile.id, candidate: event.candidate }).catch(() => {})
    }
  }
  return peer
}

async function offer(session, profile) {
  const peer = createPeer(session, profile)
  peer.pc.addTransceiver('audio')
  peer.pc.addTransceiver('video')
  await syncPeer(session, peer)
  await peer.pc.setLocalDescription()
  await post(session, { type: 'signal', to: profile.id, description: peer.pc.localDescription })
}

async function receiveSignal(session, message) {
  const peer = session.peers.get(message.from)
  if (!peer) return
  const { pc, candidates } = peer
  if (message.description) {
    await pc.setRemoteDescription(message.description)
    for (const candidate of candidates.splice(0)) await pc.addIceCandidate(candidate)
    if (message.description.type === 'offer') {
      for (const transceiver of pc.getTransceivers()) transceiver.direction = 'sendrecv'
      await syncPeer(session, peer)
      await pc.setLocalDescription()
      await post(session, { type: 'signal', to: message.from, description: pc.localDescription })
    }
  } else if (message.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(message.candidate)
    else candidates.push(message.candidate)
  }
}

function addMessage(message) {
  const item = document.createElement('li')
  const author = document.createElement('small')
  author.textContent = message.name + ' · ' + new Date(message.time).toLocaleTimeString('ko', { hour: '2-digit', minute: '2-digit' })
  item.append(author, document.createTextNode(message.text))
  $('messages').append(item)
  $('messages').scrollTop = $('messages').scrollHeight
  if ($('chat').hidden) $('chat-toggle').textContent = '채팅 •'
}

async function handle(session, message) {
  switch (message.type) {
    case 'welcome': {
      session.id = message.id
      session.token = message.token
      session.iceServers = message.iceServers
      $('status').textContent = '회의 연결됨'
      $('lobby').hidden = true
      $('meeting').hidden = false
      const url = new URL(location.href)
      url.searchParams.set('room', session.room)
      history.replaceState(null, '', url)
      $('invite-url').value = url.href
      $('invite').focus()
      showRecorder(session, message.peers.find(profile => profile.recording))
      await publishMedia(session)
      const results = await Promise.allSettled(message.peers.map(profile => offer(session, profile)))
      if (results.some(result => result.status === 'rejected')) notice('일부 참가자와 연결을 시작하지 못했습니다.')
      break
    }
    case 'join':
      createPeer(session, message.profile)
      break
    case 'leave':
      removePeer(session, message.id)
      break
    case 'signal':
      await receiveSignal(session, message)
      break
    case 'state': {
      const peer = session.peers.get(message.profile.id)
      if (peer) updateTile(peer.view, message.profile)
      break
    }
    case 'recording':
      showRecorder(session, message.recorder)
      break
    case 'chat':
      addMessage(message)
      break
    case 'full':
      leave()
      notice('회의가 가득 찼습니다. 최대 6명이 참여할 수 있습니다.')
      break
  }
}

function leave() {
  const session = meeting
  if (!session) return
  stopRecording(session, request, notice)
  meeting = null
  stopMicMeter(session)
  if (session.token) request(session, { type: 'leave' }, true).catch(() => {})
  for (const id of session.peers.keys()) removePeer(session, id)
  for (const track of [session.audio, session.camera, session.screen]) track?.stop()
  $('tiles').replaceChildren()
  $('messages').replaceChildren()
  $('chat').hidden = true
  $('chat-toggle').textContent = '채팅'
  $('chat-toggle').setAttribute('aria-expanded', 'false')
  $('invite-url').hidden = true
  $('join-button').disabled = false
  showLobby()
  $('name').focus()
}

$('name').addEventListener('input', () => { $('initial').textContent = Array.from($('name').value.trim())[0] || '' })
$('join').addEventListener('submit', event => {
  event.preventDefault()
  const name = $('name').value.trim()
  if (!name || meeting) return
  if (!window.isSecureContext || !window.RTCPeerConnection) {
    notice('회의에 참여하려면 localhost 또는 HTTPS를 지원하는 브라우저에서 열어 주세요.')
    return
  }
  const currentRoom = new URLSearchParams(location.search).get('room') || queryRoom
  const room = roomPattern.test(currentRoom) ? currentRoom : crypto.randomUUID()
  const endpoint = '/api/rooms/' + room
  const session = { room, endpoint, name, peers: new Map() }
  meeting = session
  $('join-button').disabled = true
  $('status').textContent = '회의 연결 중'
  session.self = tile({ name }, true)
  updateCount(session)
  listen(session)
})

let mediaOperation
function bindMedia(button, key, capture) {
  $(button).addEventListener('click', async () => {
    const session = meeting
    if (!session || mediaOperation === session) return
    mediaOperation = session
    $(button).disabled = true
    try {
      if (session[key]) {
        session[key].stop()
        session[key] = null
        if (key === 'audio') stopMicMeter(session)
      } else {
        if (key === 'audio') prepareMicMeter(session)
        const stream = await capture()
        const [track] = stream.getTracks()
        if (meeting !== session) {
          stream.getTracks().forEach(item => item.stop())
          return
        }
        session[key] = track
        if (key === 'audio') startMicMeter(session, track)
        track.onended = () => {
          if (session[key] !== track) return
          session[key] = null
          if (key === 'audio' && meeting === session) stopMicMeter(session)
          publishMedia(session).catch(() => notice('미디어 상태를 전송하지 못했습니다.'))
        }
      }
      await publishMedia(session)
    } catch {
      if (meeting === session) {
        if (key === 'audio' && !session.audio) {
          stopMicMeter(session)
          setMicFeedback('마이크 접근 실패')
        }
        notice('미디어를 사용할 수 없습니다. 브라우저 권한과 장치를 확인해 주세요.')
      }
    } finally {
      if (mediaOperation === session) mediaOperation = null
      $(button).disabled = false
    }
  })
}

bindMedia('mic', 'audio', () => navigator.mediaDevices.getUserMedia({ audio: true }))
bindMedia('camera', 'camera', () => navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 } } }))
bindMedia('share', 'screen', () => navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } } }))
$('invite').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('invite-url').value)
    notice('초대 링크를 복사했습니다.')
  } catch {
    $('invite-url').hidden = false
    $('invite-url').select()
    notice('표시된 초대 링크를 복사해 주세요.')
  }
})
$('record').addEventListener('click', () => {
  const session = meeting
  if (!session?.token) return
  if (session.recording) stopRecording(session, request, notice)
  else startRecording(session, request, () => meeting === session, notice)
})
$('leave').addEventListener('click', leave)
$('chat-toggle').addEventListener('click', () => {
  $('chat').hidden = !$('chat').hidden
  $('chat-toggle').setAttribute('aria-expanded', !$('chat').hidden)
  $('chat-toggle').textContent = '채팅'
  if (!$('chat').hidden) $('message').focus()
})
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault()
  const input = $('message')
  const text = input.value.trim()
  if (!text || !meeting) return
  try {
    await post(meeting, { type: 'chat', text })
    if (input.value.trim() === text) input.value = ''
  } catch {
    notice('메시지를 보내지 못했습니다.')
  }
})
window.addEventListener('pagehide', leave)
showLobby()
