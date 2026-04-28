# immi2mpeg

[![NodeJs](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white&style=flat-square)](https://nodejs.org)
[![Version](https://img.shields.io/badge/Version-1.0.0-orange.svg?style=flat-square)](https://github.com/Wilkware/immi2mpeg)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Donate](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=flat-square)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=8816166)

Node.js WebSocket service that bridges Blink Home System camera livestreams to browser clients.

Ports [blinkpy/livestream.py](https://github.com/fronzbot/blinkpy/blob/dev/blinkpy/livestream.py) to Node.js and exposes the same WebSocket client API as [amattu2/blink-liveview-middleware](https://github.com/amattu2/blink-liveview-middleware).

## Architecture

```
Browser / Client
     │  WebSocket  ws://host:8090
     ▼
┌─────────────────────────────────┐
│  src/index.js                   │  WebSocket server (ws)
│  ┌──────────────────────────┐   │
│  │  BlinkLiveStream         │   │  src/livestream.js
│  │  • TLS connect           │   │  Binary IMMI protocol
│  │  • 122-byte auth header  │   │  liveview_token + serial
│  │  • MPEG-TS parser        │   │  msgtype 0x00 → emit data
│  │  • Keepalive / polling   │   │
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │  ffmpeg (child process)  │   │  MPEG-TS → fMP4
│  │  stdin ← MPEG-TS chunks  │   │  -movflags frag_keyframe
│  │  stdout → fMP4 chunks    │   │  +empty_moov
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │  BlinkApi                │   │  src/blinkApi.js
│  │  • startLiveview()       │   │  POST .../liveview
│  │  • getCommandStatus()    │   │  GET  .../command/...
│  │  • commandDone()         │   │  POST .../command/.../done
│  └──────────────────────────┘   │
└─────────────────────────────────┘
     │  TLS TCP binary stream
     ▼
Blink IMMI Server (immedia-semi.com)
```

## Requirements

- Node.js >= 18
- ffmpeg installed and in PATH

```bash
# Debian/Ubuntu
sudo apt install ffmpeg

# macOS
brew install ffmpeg
```

## Installation

Download this project to your system – into any directory (the example below uses /opt/immi2mpeg).

```bash
# switch to opt directory
cd /opt

# clone this project
git clone https://github.com/wilkware/immi2mpeg

# change directory to the project directory
cd immi2mpeg

# installs this project
npm install

# installs this project as system service
sudo cp ./docs/immi2mpeg.service /etc/systemd/system

# as a service, the file must be executable
sudo chmod +x /opt/immi2mpeg/src/index.js

# Reload systemd to recognize new or changed unit files
sudo systemctl daemon-reexec
sudo systemctl daemon-reload

# Enable the service to start automatically on boot
sudo systemctl enable immi2mpeg.service

# Start the service immediately
sudo systemctl start immi2mpeg.service

# Check the current status of the service
sudo systemctl status immi2mpeg.service
```

## Usage

```bash
# Normal start (port 8090)
npm start

# Custom port/host
node src/index.js --port=9000 --host=127.0.0.1

# Via environment variables
PORT=9000 HOST=127.0.0.1 npm start
```

## Debug Logging

The service uses the [debug](https://www.npmjs.com/package/debug) module. By default only essential messages are logged. Enable verbose output with the `DEBUG` environment variable:

```bash
# All debug output
DEBUG=immi2mpeg:* npm start

# Specific namespaces
DEBUG=immi2mpeg:stream npm start
DEBUG=immi2mpeg:api    npm start
DEBUG=immi2mpeg:ffmpeg npm start
DEBUG=immi2mpeg:ws     npm start
```

## WebSocket Client API

```js
const ws = new WebSocket('ws://localhost:8090');
ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  // Must be sent within 8 seconds of connecting
  ws.send(JSON.stringify({
    command: 'liveview:start',
    data: {
      account_region: 'e006',        // Blink region from login response
      api_token:      'eyJhbGci...', // Bearer token
      account_id:     '12345',
      network_id:     '67890',
      camera_id:      '111222',
      camera_type:    'cameras',     // 'cameras' | 'owl' | 'doorbell'
    },
  }));
};

ws.onmessage = (evt) => {
  if (evt.data instanceof ArrayBuffer) {
    // fMP4 fragments — feed directly to MediaSource sourceBuffer
    return;
  }
  const msg = JSON.parse(evt.data);
  if (msg.command === 'liveview:start') {
    // Stream confirmed open, binary data follows in ~2-3s
  } else if (msg.command === 'liveview:stop') {
    // Stream ended (msg.error set if abnormal)
  }
};

// Stop from client side
ws.send(JSON.stringify({ command: 'liveview:stop' }));
```

## Browser MediaSource Setup

```js
const mediaSource  = new MediaSource();
let   sourceBuffer = null;
const queue        = [];

player.src = URL.createObjectURL(mediaSource);

mediaSource.addEventListener('sourceopen', () => {
  sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640029,mp4a.40.2"');
  sourceBuffer.mode = 'segments';
  sourceBuffer.addEventListener('updateend', () => {
    if (queue.length > 0 && !sourceBuffer.updating && mediaSource.readyState === 'open') {
      sourceBuffer.appendBuffer(queue.shift());
    }
  });
});

// In ws.onmessage:
if (evt.data instanceof ArrayBuffer) {
  queue.push(new Uint8Array(evt.data));
  if (sourceBuffer && !sourceBuffer.updating && mediaSource.readyState === 'open') {
    sourceBuffer.appendBuffer(queue.shift());
  }
}
```

## Docker

```bash
docker build -t immi2mpeg .
docker run -p 8090:8090 immi2mpeg
```

## Protocol Details (IMMI)

| Phase | Detail |
|-------|--------|
| Auth frame | 122 bytes: magic `0x28` + serial (16B) + client_id (4B) + `0x0108` + liveview_token (64B) + conn_id (16B) + trailer |
| Video packets | `msgtype=0x00`, payload starts with `0x47` (MPEG-TS sync byte) |
| Keepalive | `msgtype=0x0A` every 10s |
| Latency stats | `msgtype=0x12` every 10s |
| Polling | `GET /network/{id}/command/{id}` every `polling_interval` seconds |
| Done | `POST /network/{id}/command/{id}/done` on stop |
