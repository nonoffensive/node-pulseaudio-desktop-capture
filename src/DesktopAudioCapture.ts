// DesktopAudioCapture
// pacmd load-module module-rtp-send format=pcm rate=44100 channels=2 source=alsa_output.pci-0000_00_1f.3.analog-stereo.monitor destination_ip=127.0.0.1 port=32145 loop=1
// How to get it into a Webrtc Peer Connection?
// No, connect with UDP and transport data into AudioBuffer
// "Thread" audio buffering via netcat subprocess, Node based UDP drops data during high CPU load, Webworkers cannot touch Node context or Audio buffer memory

import node from './node'

let mtu = 1280  // Maximum Transmission Unit

const getAllLoopbackPortsInUse = async (): Promise<number[]> => {
  return new Promise<number[]>((resolve, reject) => {
    console.log('Scanning ports...')

    node.exec()('ss -ntu | grep 127.0.0.1', function (error, stdout, stderr) {
      if (stdout.length === 0 || error) {
        // Nothing returned, either device is clear or we're taking a blind shot
        resolve([])
        return
      }

      let activity = stdout.match(/127\.0\.0\.1\:((\d+))/gi)
      let ports = []
      
      for (let i=0; i < activity.length; i++) {
        ports.push(Number(activity[i].split(':')[1]))
      }

      console.log('Detected these ports in use', ports)

      resolve(ports)
    })
  })
}

const getUnusedLoopbackPort = async (): Promise<number> => {
  let usedPorts = await getAllLoopbackPortsInUse()
  let port = 0

  do {
    // We'll assume there are plenty of free ports to choose from
    port = 12345 + Math.floor(Math.random() * 52655)
  } while (usedPorts.indexOf(port) > -1)

  console.log('Found unused loopback port', port)

  return port
}

const getDesktopAudioDevice = async (): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    console.log('Scanning Audio Devices...')

    node.exec()('pactl list | grep "analog-stereo.monitor" | grep Name:', (stdin, stdout, error) => {
      if (error) {
        console.log('Pulseaudio Not Found')
        reject(error)
      }

      try {
        let defaultAudioSource = stdout.split('\n')[0].split(':')[1].trim()
        console.log('Pulseaudio Default Audio Device Found', defaultAudioSource)
        resolve(defaultAudioSource)
      } catch (e) {
        console.log('Pulseaudio Could Not Find Default Audio Device')
        reject(e)
      }
    })
  })
}

const redirectSinkInputs = async function (monitorDeviceName: string): Promise<any> {
  return new Promise((resolve, reject) => {
    node.exec()('pacmd list-sinks | grep -B 1 ' + monitorDeviceName, function (error, stdout, stderr) {
      if (error) {
        console.log('Unable to locate Audio Combine sink')
        reject('Unable to locate Audio Combine sink')
      }

      let sinkId = stdout.match(/index:\s(\d+)/)[1]

      node.exec()('pacmd list-sink-inputs | grep -B 1 -A 4 protocol-native.c', function (error, stdout, stderr) {
        let inputs = stdout.split('index:').slice(1)
        let lines = []
        let i, j, inputId, outputId

        // Process text output to find the correct aduio sink
        for (i in inputs) {
          lines = inputs[i].split('\n')
          inputId = lines[0].match(/\d+/)[0]
          outputId = lines[4].match(/sink:\s(\d+)/)[1]

          if (outputId !== sinkId) {
            node.exec()('pacmd move-sink-input ' + inputId + ' ' + sinkId, (error, stdout, stderr) => {})
          }
        }

        resolve()
      })
    })
  })
}

const remapPulseaudioSink = async function (source, alias) {
  let sink = source.replace(/alsa_input/, 'alsa_output').replace(/\.monitor$/, '')
  console.log('REMAPPING PULSEAUDIO SINK', source, 'TO', sink)
  let command = `pacmd load-module module-combine-sink sink_name=${alias} slaves=${sink} sink_properties=device.description=NodeCapturePresentationAudio`

  return new Promise((resolve, reject) => {
    node.exec()(command, function (error, stdout, stderr) {
      if (error) {
        reject(error)
      }

      resolve()
    })
  })
}

const startPulseaudioRtpOutput = async function (source, port) {
  let command = 'pacmd load-module module-rtp-send '
  let args = `format=s16be rate=44100 channels=2 source=${source} destination_ip=127.0.0.1 port=${port} mtu=${mtu}`

  return new Promise((resolve, reject) => {
    console.log('Starting Pulseaudio RTP module...', args)

    node.exec()(command + args,  function (error, stdout, stderr) {
      if (error) {
        console.log('Pulseaudio RTP Service Error')
        reject(error)
      }

      console.log('Pulseaudio started RTP module on port', port, stdout, error)
      resolve(args)
    })
  })
}

const searchAndDestroyModule = async function (search) {
  let command = `pacmd list-modules | grep -B 2 -A 6 "${search}"`

  return new Promise((resolve, reject) => {
    console.log('Unloading Pulseaudio module...')

    node.exec()(command, function (error, stdout, stderr) {
      try {
        let moduleId = stdout.match(/index\: \d+/i)[0].split(':')[1].trim()
        let stopCmd = `pacmd unload-module ${moduleId}`

        node.exec()(stopCmd, function (error, stdout, stderr) {
          if (error) {
            reject('Pulseaudio had a problem cleaning up module')
          }

          console.log('Pulseaudio unloaded module')
          resolve(moduleId)
        })
      } catch (e) {
        reject('Pulseaudio could not find the module')
      }
    })
  })
}

const killRemapSinkModule = async function (name) {
  let params = 'sink_name=' + name
  return searchAndDestroyModule(name)
}

const killPulseAudioRtpOutput = async function (port) {
  let params = 'destination_ip=127.0.0.1 port=' + port
  return searchAndDestroyModule(params)
}

const unloadRemapModule = async function () {
  return new Promise((resolve, reject) => {
    node.exec()('pacmd unload-module module-remap-sink', function (error, stdout, stderr) {

    })
  })
}

const createMediaStreamFromRTP = async (port): Promise<any> => {
  console.log('Creating MediaStream from Pulseaudio...')
  // Stream State Vars
  let sampleRate = 44100.0
  let bufferDuration = 0.25
  let audioCtx = new AudioContext() as any
  let audioBuf = audioCtx.createBuffer(2, sampleRate * bufferDuration, sampleRate) // 2 channel, 3 second audio buffer
  let audioInput = audioCtx.createBufferSource()
  let outputStreamNode = audioCtx.createMediaStreamDestination()
  let leftBuf = audioBuf.getChannelData(0)
  let rightBuf = audioBuf.getChannelData(1)
  let scalar = 1.0 / 32768.0
  let bufferLength = leftBuf.length
  let bufferPntr = Math.floor(leftBuf.length * 0.3)
  let processHeader = 0
  let lastCompletedFrame = -1
  let currentFrame = -1
  let newestFrame = null

  // Troubleshooting Vars
  let playStart = null
  let playData = 0
  let playTime = 0
  let frameAverage = []
  let pendingFrames = {}
  let headerKey = Buffer.from([0x80, 0x0a])
  let headerCheck = null // Buffer.from([0x15, 0x3e, 0x38, 0x3a]) // Each machine's fingerprint is different

  audioInput.buffer = audioBuf
  audioInput.loop = true
  audioInput.loopEnd = bufferDuration
  audioInput.connect(outputStreamNode)

  let dumpAudioHeader = function (header) {
    let frameIndex = header.readUInt16BE(2)
    let binary = []
    let block = []
    let b = ''
    for (let i=0; i < header.length; i++) {
      b = header[i].toString(16).padStart(2, '0')
      block.push(b.slice(-2))

      if (block.length > 1) {
        binary.push(block.join(''))
        block = []
      }
    }

    console.log('Audio Header', frameIndex, binary.join(' '))
  }

  let processSoundData = function (buffer) {
    // let start = Date.now()
    // Data Header
    // Byte - Label - Description
    // 0      ??      128           80 1000 0000 
    // 1      ?       10 Codec?     0A 0000 1010 Body Length?
    // 2      Frame2  Incrementing  3e++ % FF
    // 3      Frame1  Incrementing  5a++ % FF
    // 4      Frame3                00++
    // 5      Frame2                00++
    // 6      Frame1                01++
    // 7      Quad?   Repeating     00-40-80-c0-00...
    // 8      Constant?             4e 0100 1110 Hardware Unique? cannot be hardcoded
    // 9      Constant?             1c 0001 1100
    // 10     Constant?             a4 1010 0100
    // 11     Constant?             fb 1111 1011
    // BODY - Length  1280 1010 0000 0000
    // KNOWNS:
    // SAMPLE SIZE - 44100 1010 1100 0100 0100 126104
    // CHUNK - 2 bytes L Channel, 2 bytes R Channel

    // Best Guess
    // bits 8 - Format? - Value 1 or 8
    // bits 20 - Body Length
    // bits 42 - Frame Number
    // 000 000 101 010 111 001 111 110 011 110 0001 1011

    let header = buffer.slice(0, 12)
    let frame = header.readUInt16BE(2)
    let data = buffer.slice(12)
    let frameLength = data.length * 0.5
    let sample = 0
    let skip = 1

    newestFrame = (newestFrame - frame > 0xfff0) ? frame : Math.max(newestFrame, frame)

    let drift = ((playTime - audioCtx.currentTime) * 1000)

    if (processHeader > 700) {
      playData += frameLength

      console.log('Audio Status',
        (audioCtx.currentTime / 60.0).toFixed(0) + ':' + ('0' + (audioCtx.currentTime % 60).toFixed(2)).substr(-5),
        (drift % 250).toFixed(0) + 'ms',
        ((playData * 2) / (Date.now() - playStart)).toFixed(2) + 'kbps',
        (frameAverage.reduce((s, x) => { return s + x}, 0) / frameAverage.length).toFixed(2) + 'ms per frame',
        ('0000' + frame.toString(16)).substr(-4),
        headerCheck.hexSlice(0)
      )

      frameAverage = []
      processHeader = 0
      playStart = Date.now()
      playData = 0
    } else {
      playData += frameLength
      processHeader++
    }

    if ((drift % 250 ) < 150) { //(drift % 250 ) > 150 && (drift % 250) < 210
      console.log('Audio Danger Zone', frame, (drift % 250).toFixed(0), drift.toFixed(2))
      skip = 4
    }
    playTime += ((frameLength * 0.5) * skip) / sampleRate

    for(let i=0; i < frameLength * skip; i++) {
      // Convert pcm16 to float32
      sample = data.readInt16BE((i % frameLength) << 1) * scalar

      if (i % 2) {
        rightBuf[bufferPntr] = sample
        bufferPntr = (bufferPntr + 1) % bufferLength
      } else {
        leftBuf[bufferPntr] = sample
      }
    }

    lastCompletedFrame = frame
  }


  let handleConnection = function (resolve, reject, socket) {
    console.log('Created RTP Audio UDP Connection...')

    audioInput.start()

    setTimeout(() => {
      // Give stream a quarter second head start
      console.log('Starting Audio Object', outputStreamNode.stream, outputStreamNode.stream.getAudioTracks())

      resolve({
        socket: socket,
        context: audioCtx,
        input: audioInput,
        output: outputStreamNode,
        stream: outputStreamNode.stream,
        close: function () {
          audioInput.stop()
          socket.kill(9)
          audioCtx.close()
        }
      } as any)
    }, 250)
  }

  let client = node.spawn()('nc', [
    '-lu',
    '127.0.0.1',
    port
  ], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  return new Promise<any>((resolve, reject) => {
    // Netcat Subprocess
    client.stdout.on('data', (data) => {
      let start = Date.now()
      let blockStart = 0
      let blockEnd = 0
      let indexes = []
      
      while (data.indexOf(headerKey, blockStart) > -1) {
        blockStart = data.indexOf(headerKey, blockStart)

        if (!headerCheck) {
          // Set unique sound header data fingerprint, PulseAudio ID?
          headerCheck = data.slice(blockStart + 8, blockStart + 12)
        }

        indexes.push({
          offset: blockStart,
          padCheck: data[blockStart + 4] === 0,
          sanity: data.indexOf(headerCheck, blockStart) - blockStart
        })
        blockStart++
      }

      // console.log('Frame Details', data.length, indexes)

      let blocks = indexes.filter((block) => {
        return block.sanity === 8
      })

      for (let i = 0; i < blocks.length; i++) {
        if (i + 1 === blocks.length) {
          processSoundData(data.slice(blocks[i].offset))
        } else {
          processSoundData(data.slice(blocks[i].offset, blocks[i + 1].offset))
        }
      }

      frameAverage.push(Date.now() - start)
    })

    client.stderr.on('data', (data) => {
      console.error(data)
    })

    handleConnection(resolve, reject, client)
  })
}

export default class DesktopAudioCapture {
  audioNamePrefix: string         // Prefix to assign to all audio device labels
  audioMonitorName: string        // Name used to create the audio monitor
  audioSourceDescriptor: string
  port: number
  captureContext: any | null
  moveInputInterval: Timeout

  constructor (options: any) {
    this.audioNamePrefix = ( options.audioNamePrefix || 'node_capture' )
    this.audioMonitorName = ( options.audioMonitorName || ( this.audioNamePrefix + '_monitor ' ))
  }

  async createAudioCapture () {
    this.audioSourceDescriptor = await getDesktopAudioDevice()
    this.port = await getUnusedLoopbackPort()

    console.log('AUDIO SOURCE DESCRIPTOR', this.audioSourceDescriptor)
    
    await remapPulseaudioSink(this.audioSourceDescriptor, this.audioMonitorName)
    let paro = await startPulseaudioRtpOutput(this.audioMonitorName + '.monitor', this.port)
    console.log('Pulseaudio status', paro)
    
    this.captureContext = await createMediaStreamFromRTP(this.port)

    this.moveInputInterval = setInterval(() => {
      redirectSinkInputs(this.audioMonitorName)
    }, 500)

    return this.captureContext
  }

  async endAudioCapture () {
    if (this.captureContext) {
      this.captureContext.close()

      killRemapSinkModule(this.audioMonitorName)
      killPulseAudioRtpOutput(this.port)

      clearInterval(this.moveInputInterval)

      this.captureContext = null
    }
  }
}
