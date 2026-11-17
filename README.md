# 모여

초대 링크로 참여하는 소규모 브라우저 화상회의 앱입니다. 한 회의에 최대 6명이 참여할 수 있습니다.

## 실행

Windows, macOS, Linux에서 Node.js 18 이상으로 실행할 수 있습니다. 이 디렉터리에서 다음 명령을 실행합니다.

```sh
node start.mjs
```

브라우저에서 http://localhost:8787 을 엽니다. 이름을 입력해 회의를 시작하고, **초대 링크 복사**로 생성한 링크를 다른 탭에 붙여넣으면 참가자 두 명으로 확인할 수 있습니다. 입장 후 카메라와 마이크를 직접 켤 수 있습니다. 같은 기기에서 테스트할 때는 하울링을 막기 위해 헤드폰을 사용하거나 한쪽 마이크를 꺼 두세요.

## Windows에서 서버 열기

1. [Node.js LTS](https://nodejs.org/en/download)를 설치합니다. 설치가 끝나면 PowerShell을 새로 열고 이 폴더에서 `node start.mjs`를 실행합니다.
2. 다른 기기를 초대하려면 [Windows용 cloudflared](https://developers.cloudflare.com/tunnel/downloads/#windows)를 설치하고 `node start.mjs --share`를 실행합니다. 실행 파일을 다운로드했다면 아래 예시처럼 경로를 직접 지정할 수도 있습니다. 콘솔에 표시된 HTTPS 주소를 열어 회의를 만든 뒤 **초대 링크 복사**를 누릅니다.
3. 텍스트 회의록이 필요하다면 [Whisper의 Windows용 CPU 빌드](https://github.com/ggml-org/whisper.cpp/releases)와 [Windows용 FFmpeg](https://www.ffmpeg.org/download.html#build-windows)를 내려받아 압축을 풉니다. Whisper의 실행 파일과 함께 제공되는 DLL은 같은 디렉터리에 두세요. [다국어 base 모델](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin)을 `.models/ggml-base.bin`에 넣습니다. 도구를 PATH에 추가하거나 다음 예시처럼 실제 설치 경로를 PowerShell에 지정합니다.

```powershell
$env:CLOUDFLARED_BIN = 'C:\tools\cloudflared.exe'
$env:WHISPER_BIN = 'C:\tools\whisper\whisper-cli.exe'
$env:FFMPEG_BIN = 'C:\tools\ffmpeg\bin\ffmpeg.exe'
node start.mjs --share
```

같은 PC에서만 테스트하려면 `--share`를 빼고 실행하세요. PowerShell에서 **Ctrl+C**를 누르면 해당 명령으로 시작한 서버와 터널이 종료됩니다. 서버는 회의 중 켜져 있어야 합니다. 초대받은 참가자는 Windows에서도 Chrome이나 Edge로 초대 링크를 열면 됩니다.

## 다른 기기에서 참여

서버를 실행하는 기기와 참가자 모두가 접속할 수 있는 주소로 서비스해야 합니다. 카메라, 마이크와 화면 공유를 쓰려면 공개 주소에는 HTTPS가 필요합니다. 기본 서버는 127.0.0.1:8787에서 수신합니다. HTTPS 리버스 프록시가 다른 호스트에서 실행된다면 필요에 맞게 `HOST`와 `PORT`를 설정하세요.

영상과 음성은 참가자 사이에서 WebRTC로 오갑니다. 기본 STUN으로 직접 연결하기 어려운 네트워크에서는 TURN 중계 서버가 필요합니다. `ICE_SERVERS` 환경 변수로 WebRTC ICE 서버 배열을 JSON 형식으로 설정할 수 있습니다. 이 설정은 참가자의 브라우저로 전달되므로 TURN 자격 증명에는 사용자에게 공개 가능한 임시 값을 사용하세요.

회의 접속 정보는 한 서버 프로세스의 메모리에 있습니다. 채팅은 참여 중인 브라우저에 실시간으로 전달되며, 서버에 기록되지 않습니다.

## 녹음과 한국어 회의록

회의에서 **녹음 시작**을 누르면 녹음을 시작한 브라우저가 자기 마이크와 전달받은 참가자 음성을 함께 담습니다. 모든 참가자 화면에 녹음 상태가 표시됩니다. **녹음 종료**를 누르면 해당 브라우저에서 파일을 다운로드할 수 있습니다. 한 번에 최대 30분을 녹음할 수 있습니다. 결과는 페이지를 새로고침하기 전에 다운로드하세요.

텍스트 변환은 서버에 Whisper 모델, `whisper-cli`, `ffmpeg`가 설치되어 있어야 합니다. macOS에서는 Homebrew의 `whisper-cpp`와 `ffmpeg`를 설치하고, [다국어 base 모델](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin)을 `.models/ggml-base.bin`에 다운로드한 뒤 다음과 같이 실행합니다.

```sh
WHISPER_MODEL="$PWD/.models/ggml-base.bin" node start.mjs
```

도구가 PATH에 없다면 `WHISPER_BIN`과 `FFMPEG_BIN`에 실행 파일 경로를 설정할 수 있습니다. **한국어 회의록 만들기**를 누르면 녹음 파일이 서버를 실행한 PC에 전송되어 변환됩니다. 변환용 임시 음성 파일은 처리 후 삭제되고, 텍스트 결과는 서버 메모리에 30분간 남습니다.
