const $ = id => document.getElementById(id)
const maxRecordingTime = 30 * 60 * 1000
const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']
const extensions = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav' }

export function showRecorder(session, recorder) {
  session.recorder = recorder
  $('recording-status').hidden = !recorder
  $('recording-status').textContent = recorder ? '● ' + recorder.name + ' 님이 녹음 중' : ''
  $('record').textContent = session.recording ? '녹음 종료' : '녹음 시작'
  $('record').disabled = !!recorder && recorder.id !== session.id
  $('record').setAttribute('aria-pressed', !!session.recording)
}

export function syncRecording(session) {
  const recording = session.recording
  if (!recording) return
  const tracks = new Set([
    session.audio,
    ...[...session.peers.values()].map(peer => peer.audioTrack),
  ].filter(track => track?.readyState === 'live'))

  for (const [track, source] of recording.sources) {
    if (!tracks.has(track)) {
      source.disconnect()
      recording.sources.delete(track)
    }
  }
  for (const track of tracks) {
    if (recording.sources.has(track)) continue
    const source = recording.context.createMediaStreamSource(new MediaStream([track]))
    source.connect(recording.destination)
    recording.sources.set(track, source)
  }
}

function makeDownload(blob, filename) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.textContent = filename.endsWith('.txt') ? '텍스트 다운로드' : '녹음 다운로드'
  return link
}

async function transcriptRequest(token, audio) {
  const response = await fetch('/api/transcripts', {
    method: audio ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      ...(audio && { 'Content-Type': audio.type }),
    },
    body: audio,
    signal: AbortSignal.timeout(audio ? 75000 : 10000),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '회의록을 생성하지 못했습니다.')
  return result
}

function showResult(audio, token, started) {
  const group = document.createElement('article')
  group.className = 'recording-result'
  const date = new Date(started).toISOString().slice(0, 19).replace(/:/g, '-')
  const filename = 'moyeo-' + date
  const extension = extensions[audio.type.split(';')[0]] || 'webm'
  group.append(makeDownload(audio, filename + '.' + extension))
  const status = document.createElement('span')
  status.setAttribute('role', 'status')
  if (token) {
    status.textContent = '음성은 서버가 실행 중인 PC에서 변환됩니다.'
    const button = document.createElement('button')
    button.textContent = '한국어 회의록 만들기'
    button.addEventListener('click', async () => {
      button.disabled = true
      status.textContent = '서버에서 음성을 변환하고 있습니다…'
      try {
        let result = await transcriptRequest(token)
        if (result.status === 'ready') result = await transcriptRequest(token, audio)
        while (result.status === 'processing') {
          await new Promise(resolve => setTimeout(resolve, 2000))
          result = await transcriptRequest(token)
        }
        if (result.status === 'failed') throw new Error(result.error)
        if (result.status !== 'done') throw new Error('변환 상태를 확인하지 못했습니다.')
        const text = result.text || '인식된 내용이 없습니다.'
        group.append(makeDownload(new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' }), filename + '.txt'))
        status.textContent = result.text ? '회의록 생성 완료' : '인식된 내용이 없습니다'
        button.remove()
      } catch (error) {
        status.textContent = error.message
        button.disabled = false
      }
    })
    group.append(button)
  } else {
    status.textContent = '이 서버에서는 텍스트 변환을 사용할 수 없습니다.'
  }
  group.append(status)
  $('recording-results').hidden = false
  $('recording-files').prepend(group)
}

export async function startRecording(session, request, isCurrent, notice) {
  const AudioContext = window.AudioContext || window.webkitAudioContext
  if (!AudioContext || !window.MediaRecorder) {
    notice('이 브라우저에서는 회의 녹음을 사용할 수 없습니다.')
    return
  }
  if (session.startingRecording || session.recording) return
  session.startingRecording = true
  $('record').disabled = true
  let context
  let approved = false
  try {
    context = new AudioContext()
    await context.resume()
    const destination = context.createMediaStreamDestination()
    const mimeType = types.find(type => MediaRecorder.isTypeSupported(type))
    const media = new MediaRecorder(destination.stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 64000 })
    const response = await request(session, { type: 'recording', active: true })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    approved = true
    if (!isCurrent()) throw new Error('회의가 종료되었습니다.')
    const chunks = []
    const started = Date.now()
    const recording = { context, destination, media, sources: new Map() }
    media.ondataavailable = event => {
      if (event.data.size) chunks.push(event.data)
    }
    media.onstop = () => {
      context.close().catch(() => {})
      const audio = new Blob(chunks, { type: media.mimeType || chunks[0]?.type || mimeType })
      if (audio.size) showResult(audio, result.transcriptToken, started)
      else notice('저장할 녹음 내용이 없습니다.')
    }
    media.onerror = () => {
      notice('녹음 중 문제가 발생했습니다.')
      stopRecording(session, request, notice)
    }
    session.recording = recording
    syncRecording(session)
    media.start(1000)
    recording.timer = setTimeout(() => {
      stopRecording(session, request, notice)
      notice('30분 녹음을 저장했습니다.')
    }, maxRecordingTime)
    showRecorder(session, { id: session.id, name: session.name })
  } catch (error) {
    session.recording = null
    if (context) context.close().catch(() => {})
    if (approved && isCurrent()) request(session, { type: 'recording', active: false }, true).catch(() => {})
    if (isCurrent()) notice(error.message || '녹음을 시작하지 못했습니다.')
  } finally {
    session.startingRecording = false
    if (isCurrent()) showRecorder(session, session.recorder)
  }
}

export function stopRecording(session, request, notice) {
  const recording = session.recording
  if (!recording) return
  session.recording = null
  clearTimeout(recording.timer)
  if (recording.media.state !== 'inactive') recording.media.stop()
  showRecorder(session, null)
  if (session.token) request(session, { type: 'recording', active: false }, true).catch(() => {
    notice('다른 참가자 화면의 녹음 상태를 업데이트하지 못했습니다.')
  })
}
