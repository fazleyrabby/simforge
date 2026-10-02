import type { SimulationEvent } from '../simulations/core/Simulation'
import { audioEngine } from './AudioEngine'

export interface SimulationAudioDriver {
  update(stats: Record<string, number | string>, dt: number): void
  handleEvent(event: SimulationEvent): void
  dispose(): void
}

/**
 * Creates noise buffer for procedural mechanical and air sounds.
 */
function createNoiseBuffer(ctx: AudioContext, seconds = 2): AudioBuffer {
  const sampleRate = ctx.sampleRate
  const buffer = ctx.createBuffer(1, sampleRate * seconds, sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1
  }
  return buffer
}

// -------------------------------------------------------------
// 01 GEARS: Tooth clicks & rotation whine
// -------------------------------------------------------------
class GearsAudio implements SimulationAudioDriver {
  private gain: GainNode
  private osc: OscillatorNode
  private filter: BiquadFilterNode
  private clickTimer = 0

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.gain = ctx.createGain()
    this.gain.gain.value = 0.04

    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = 400

    this.osc = ctx.createOscillator()
    this.osc.type = 'triangle'
    this.osc.frequency.value = 60

    this.osc.connect(this.filter)
    this.filter.connect(this.gain)
    this.gain.connect(dest)
    this.osc.start()
  }

  update(stats: Record<string, number | string>, dt: number): void {
    const rawRpm = typeof stats.rpm === 'string' ? parseFloat(stats.rpm) : (stats.rpm ?? 60)
    const rpm = isNaN(rawRpm) ? 60 : Math.abs(rawRpm)
    const targetFreq = 40 + rpm * 1.5
    this.osc.frequency.setTargetAtTime(Math.min(targetFreq, 600), this.ctx.currentTime, 0.1)
    this.filter.frequency.setTargetAtTime(120 + rpm * 2.2, this.ctx.currentTime, 0.1)

    // Occasional subtle teeth engagement click
    this.clickTimer += dt
    const interval = Math.max(0.08, 15 / Math.max(rpm, 10))
    if (this.clickTimer >= interval) {
      this.clickTimer = 0
      this.playClick(rpm)
    }
  }

  private playClick(rpm: number): void {
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 1200 + Math.random() * 400
    gain.gain.setValueAtTime(0.02 * Math.min(rpm / 100, 1.2), this.ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.025)
    osc.connect(gain)
    gain.connect(this.gain)
    osc.start()
    osc.stop(this.ctx.currentTime + 0.03)
  }

  handleEvent(): void {}

  dispose(): void {
    try {
      this.osc.stop()
      this.osc.disconnect()
      this.gain.disconnect()
    } catch {
      // already stopped
    }
  }
}

// -------------------------------------------------------------
// 02 HEAT: Thermal chime pulses & warm ambient hum
// -------------------------------------------------------------
class HeatAudio implements SimulationAudioDriver {
  private humGain: GainNode
  private osc: OscillatorNode

  constructor(private ctx: AudioContext, private dest: AudioNode) {
    this.humGain = ctx.createGain()
    this.humGain.gain.value = 0.025

    this.osc = ctx.createOscillator()
    this.osc.type = 'sine'
    this.osc.frequency.value = 110

    this.osc.connect(this.humGain)
    this.humGain.connect(dest)
    this.osc.start()
  }

  update(stats: Record<string, number | string>): void {
    const avgTemp = typeof stats.avgTemp === 'string' ? parseFloat(stats.avgTemp) : (stats.avgTemp ?? 50)
    const baseFreq = 90 + (isNaN(avgTemp) ? 50 : avgTemp) * 0.8
    this.osc.frequency.setTargetAtTime(baseFreq, this.ctx.currentTime, 0.2)
  }

  handleEvent(event: SimulationEvent): void {
    // Play warm thermal ping
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(event.type === 'heat_erase' ? 440 : 880, this.ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(event.type === 'heat_erase' ? 220 : 1320, this.ctx.currentTime + 0.15)
    gain.gain.setValueAtTime(0.06, this.ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.35)
    osc.connect(gain)
    gain.connect(this.dest)
    osc.start()
    osc.stop(this.ctx.currentTime + 0.36)
  }

  dispose(): void {
    try {
      this.osc.stop()
      this.osc.disconnect()
      this.humGain.disconnect()
    } catch {
      // stopped
    }
  }
}

// -------------------------------------------------------------
// 03 DYNO: Engine synthesizer, roller hiss, gear shifts
// -------------------------------------------------------------
class DynoAudio implements SimulationAudioDriver {
  private engineGain: GainNode
  private osc1: OscillatorNode
  private osc2: OscillatorNode
  private engineFilter: BiquadFilterNode

  private rollerGain: GainNode
  private rollerNoise: AudioBufferSourceNode
  private rollerFilter: BiquadFilterNode

  constructor(private ctx: AudioContext, private dest: AudioNode) {
    // Engine setup
    this.engineGain = ctx.createGain()
    this.engineGain.gain.value = 0.05

    this.engineFilter = ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.frequency.value = 300

    this.osc1 = ctx.createOscillator()
    this.osc1.type = 'sawtooth'
    this.osc1.frequency.value = 45

    this.osc2 = ctx.createOscillator()
    this.osc2.type = 'triangle'
    this.osc2.frequency.value = 90

    this.osc1.connect(this.engineFilter)
    this.osc2.connect(this.engineFilter)
    this.engineFilter.connect(this.engineGain)
    this.engineGain.connect(dest)

    this.osc1.start()
    this.osc2.start()

    // Roller noise setup
    const buffer = createNoiseBuffer(ctx, 3)
    this.rollerNoise = ctx.createBufferSource()
    this.rollerNoise.buffer = buffer
    this.rollerNoise.loop = true

    this.rollerFilter = ctx.createBiquadFilter()
    this.rollerFilter.type = 'bandpass'
    this.rollerFilter.frequency.value = 600
    this.rollerFilter.Q.value = 2

    this.rollerGain = ctx.createGain()
    this.rollerGain.gain.value = 0.01

    this.rollerNoise.connect(this.rollerFilter)
    this.rollerFilter.connect(this.rollerGain)
    this.rollerGain.connect(dest)
    this.rollerNoise.start()
  }

  update(stats: Record<string, number | string>): void {
    const rawRpm = typeof stats.rpm === 'string' ? parseFloat(stats.rpm) : (stats.rpm ?? 1200)
    const rawSpeed = typeof stats.speed === 'string' ? parseFloat(stats.speed) : (stats.speed ?? 0)
    const rpm = isNaN(rawRpm) ? 1200 : rawRpm
    const speed = isNaN(rawSpeed) ? 0 : rawSpeed

    // Engine 4-cylinder firing frequency: rpm / 60 * 2
    const firingFreq = (rpm / 60) * 2
    this.osc1.frequency.setTargetAtTime(Math.max(25, firingFreq), this.ctx.currentTime, 0.06)
    this.osc2.frequency.setTargetAtTime(Math.max(50, firingFreq * 2), this.ctx.currentTime, 0.06)
    this.engineFilter.frequency.setTargetAtTime(150 + (rpm / 7000) * 800, this.ctx.currentTime, 0.08)

    // Roller rumble tracking road speed
    const rollerVol = Math.min(speed / 160, 1) * 0.035
    this.rollerGain.gain.setTargetAtTime(rollerVol, this.ctx.currentTime, 0.1)
    this.rollerFilter.frequency.setTargetAtTime(400 + speed * 6, this.ctx.currentTime, 0.1)
  }

  handleEvent(event: SimulationEvent): void {
    if (event.type === 'run_complete' || event.type === 'power_run_complete') {
      // Throttle blip / chime
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(523.25, this.ctx.currentTime) // C5
      osc.frequency.setValueAtTime(659.25, this.ctx.currentTime + 0.1) // E5
      osc.frequency.setValueAtTime(783.99, this.ctx.currentTime + 0.2) // G5
      g.gain.setValueAtTime(0.08, this.ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.5)
      osc.connect(g)
      g.connect(this.dest)
      osc.start()
      osc.stop(this.ctx.currentTime + 0.5)
    } else if (event.type === 'gear_shift') {
      // Throttle cut + mechanical gear engagement clunk
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(130, this.ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(45, this.ctx.currentTime + 0.05)
      g.gain.setValueAtTime(0.08, this.ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.06)
      osc.connect(g)
      g.connect(this.dest)
      osc.start()
      osc.stop(this.ctx.currentTime + 0.07)
    } else if (event.type === 'wheel_slip') {
      // Tyre squeal chirp
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(850, this.ctx.currentTime)
      osc.frequency.linearRampToValueAtTime(1250, this.ctx.currentTime + 0.12)
      g.gain.setValueAtTime(0.035, this.ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.15)
      osc.connect(g)
      g.connect(this.dest)
      osc.start()
      osc.stop(this.ctx.currentTime + 0.16)
    }
  }

  dispose(): void {
    try {
      this.osc1.stop()
      this.osc2.stop()
      this.rollerNoise.stop()
      this.engineGain.disconnect()
      this.rollerGain.disconnect()
    } catch {
      // stopped
    }
  }
}

// -------------------------------------------------------------
// 04 FACTORY: Conveyor rumble & pneumatic stamping clicks
// -------------------------------------------------------------
class FactoryAudio implements SimulationAudioDriver {
  private conveyorGain: GainNode
  private noiseNode: AudioBufferSourceNode
  private noiseFilter: BiquadFilterNode
  private pulseTimer = 0

  constructor(private ctx: AudioContext, private dest: AudioNode) {
    const buffer = createNoiseBuffer(ctx, 2)
    this.noiseNode = ctx.createBufferSource()
    this.noiseNode.buffer = buffer
    this.noiseNode.loop = true

    this.noiseFilter = ctx.createBiquadFilter()
    this.noiseFilter.type = 'lowpass'
    this.noiseFilter.frequency.value = 180

    this.conveyorGain = ctx.createGain()
    this.conveyorGain.gain.value = 0.03

    this.noiseNode.connect(this.noiseFilter)
    this.noiseFilter.connect(this.conveyorGain)
    this.conveyorGain.connect(dest)
    this.noiseNode.start()
  }

  update(_stats: Record<string, number | string>, dt: number): void {
    this.pulseTimer += dt
    // Periodic subtle pneumatic hiss/stamp
    if (this.pulseTimer >= 1.4) {
      this.pulseTimer = 0
      this.playStamp()
    }
  }

  private playStamp(): void {
    // Air chuff
    const noise = this.ctx.createBufferSource()
    noise.buffer = createNoiseBuffer(this.ctx, 0.2)
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 1200
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.035, this.ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.15)
    noise.connect(filter)
    filter.connect(g)
    g.connect(this.dest)
    noise.start()
  }

  handleEvent(event: SimulationEvent): void {
    if (event.type === 'machine_repaired') {
      // Wrench tap / positive repair chime
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(587.33, this.ctx.currentTime) // D5
      osc.frequency.setValueAtTime(880, this.ctx.currentTime + 0.08) // A5
      g.gain.setValueAtTime(0.06, this.ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.25)
      osc.connect(g)
      g.connect(this.dest)
      osc.start()
      osc.stop(this.ctx.currentTime + 0.26)
    } else if (event.type === 'jam' || event.level === 'warn') {
      // Double alarm beep
      for (const offset of [0, 0.15]) {
        const osc = this.ctx.createOscillator()
        const g = this.ctx.createGain()
        osc.type = 'square'
        osc.frequency.value = 880
        g.gain.setValueAtTime(0.04, this.ctx.currentTime + offset)
        g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + offset + 0.09)
        osc.connect(g)
        g.connect(this.dest)
        osc.start(this.ctx.currentTime + offset)
        osc.stop(this.ctx.currentTime + offset + 0.1)
      }
    }
  }

  dispose(): void {
    try {
      this.noiseNode.stop()
      this.conveyorGain.disconnect()
    } catch {
      // stopped
    }
  }
}

// -------------------------------------------------------------
// 05 SERVER RACK: Datacenter fans, drive seeks, relay clicks
// -------------------------------------------------------------
class RackAudio implements SimulationAudioDriver {
  private fanGain: GainNode
  private fanNoise: AudioBufferSourceNode
  private fanFilter: BiquadFilterNode
  private seekTimer = 0

  constructor(private ctx: AudioContext, private dest: AudioNode) {
    const buffer = createNoiseBuffer(ctx, 3)
    this.fanNoise = ctx.createBufferSource()
    this.fanNoise.buffer = buffer
    this.fanNoise.loop = true

    this.fanFilter = ctx.createBiquadFilter()
    this.fanFilter.type = 'bandpass'
    this.fanFilter.frequency.value = 750
    this.fanFilter.Q.value = 1.2

    this.fanGain = ctx.createGain()
    this.fanGain.gain.value = 0.04

    this.fanNoise.connect(this.fanFilter)
    this.fanFilter.connect(this.fanGain)
    this.fanGain.connect(dest)
    this.fanNoise.start()
  }

  update(_stats: Record<string, number | string>, dt: number): void {
    this.seekTimer += dt
    if (this.seekTimer >= 0.8) {
      this.seekTimer = 0
      if (Math.random() < 0.6) this.playDriveSeek()
    }
  }

  private playDriveSeek(): void {
    // HDD head seek click burst
    for (let i = 0; i < 3; i++) {
      const time = this.ctx.currentTime + i * 0.025
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 2400 + Math.random() * 800
      g.gain.setValueAtTime(0.015, time)
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.01)
      osc.connect(g)
      g.connect(this.dest)
      osc.start(time)
      osc.stop(time + 0.015)
    }
  }

  handleEvent(event: SimulationEvent): void {
    if (event.type === 'door_toggle') {
      // Cabinet door hinge squeak + magnetic latch tap
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(420, this.ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(750, this.ctx.currentTime + 0.08)
      g.gain.setValueAtTime(0.04, this.ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.09)
      osc.connect(g)
      g.connect(this.dest)
      osc.start()
      osc.stop(this.ctx.currentTime + 0.1)
    } else if (event.type === 'server_pulled' || event.type === 'server_pushed') {
      // Metal drawer slide friction + latch
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(event.type === 'server_pulled' ? 180 : 360, this.ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(event.type === 'server_pulled' ? 360 : 120, this.ctx.currentTime + 0.09)
      g.gain.setValueAtTime(0.06, this.ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.1)
      osc.connect(g)
      g.connect(this.dest)
      osc.start()
      osc.stop(this.ctx.currentTime + 0.11)
    } else if (event.type === 'server_reboot') {
      // Server reboot ascending pitch beep
      ;[440, 660, 880].forEach((freq, idx) => {
        const time = this.ctx.currentTime + idx * 0.06
        const osc = this.ctx.createOscillator()
        const g = this.ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        g.gain.setValueAtTime(0.035, time)
        g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05)
        osc.connect(g)
        g.connect(this.dest)
        osc.start(time)
        osc.stop(time + 0.055)
      })
    } else {
      // Relay click
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(320, this.ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(80, this.ctx.currentTime + 0.04)
      g.gain.setValueAtTime(0.08, this.ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.05)
      osc.connect(g)
      g.connect(this.dest)
      osc.start()
      osc.stop(this.ctx.currentTime + 0.06)
    }
  }

  dispose(): void {
    try {
      this.fanNoise.stop()
      this.fanGain.disconnect()
    } catch {
      // stopped
    }
  }
}

// -------------------------------------------------------------
// 06 ORBITAL: Cosmic harmonic drone & flyby swooshes
// -------------------------------------------------------------
class OrbitalAudio implements SimulationAudioDriver {
  private gain: GainNode
  private oscRoot: OscillatorNode
  private oscFifth: OscillatorNode
  private oscOctave: OscillatorNode

  constructor(private ctx: AudioContext, private dest: AudioNode) {
    this.gain = ctx.createGain()
    this.gain.gain.value = 0.035

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 280

    this.oscRoot = ctx.createOscillator()
    this.oscRoot.type = 'sine'
    this.oscRoot.frequency.value = 55 // A1

    this.oscFifth = ctx.createOscillator()
    this.oscFifth.type = 'sine'
    this.oscFifth.frequency.value = 82.41 // E2

    this.oscOctave = ctx.createOscillator()
    this.oscOctave.type = 'sine'
    this.oscOctave.frequency.value = 110 // A2

    this.oscRoot.connect(filter)
    this.oscFifth.connect(filter)
    this.oscOctave.connect(filter)
    filter.connect(this.gain)
    this.gain.connect(dest)

    this.oscRoot.start()
    this.oscFifth.start()
    this.oscOctave.start()
  }

  update(): void {}

  handleEvent(event: SimulationEvent): void {
    if (event.type === 'comet_launched' || event.title?.includes('COMET')) {
      // Resonant flyby sweep
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(220, this.ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(880, this.ctx.currentTime + 0.4)
      osc.frequency.exponentialRampToValueAtTime(330, this.ctx.currentTime + 0.9)
      g.gain.setValueAtTime(0.001, this.ctx.currentTime)
      g.gain.linearRampToValueAtTime(0.06, this.ctx.currentTime + 0.3)
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 1.2)
      osc.connect(g)
      g.connect(this.dest)
      osc.start()
      osc.stop(this.ctx.currentTime + 1.3)
    }
  }

  dispose(): void {
    try {
      this.oscRoot.stop()
      this.oscFifth.stop()
      this.oscOctave.stop()
      this.gain.disconnect()
    } catch {
      // stopped
    }
  }
}

// -------------------------------------------------------------
// 07 HYDRAULIC PRESS: Pump hum, creaks, explosion & victory jingle
// -------------------------------------------------------------
class PressAudio implements SimulationAudioDriver {
  private pumpGain: GainNode
  private pumpOsc: OscillatorNode
  private pumpFilter: BiquadFilterNode

  constructor(private ctx: AudioContext, private dest: AudioNode) {
    this.pumpGain = ctx.createGain()
    this.pumpGain.gain.value = 0.0

    this.pumpFilter = ctx.createBiquadFilter()
    this.pumpFilter.type = 'lowpass'
    this.pumpFilter.frequency.value = 350

    this.pumpOsc = ctx.createOscillator()
    this.pumpOsc.type = 'sawtooth'
    this.pumpOsc.frequency.value = 85

    this.pumpOsc.connect(this.pumpFilter)
    this.pumpFilter.connect(this.pumpGain)
    this.pumpGain.connect(dest)
    this.pumpOsc.start()
  }

  update(stats: Record<string, number | string>): void {
    const state = String(stats.state ?? '').toLowerCase()
    const rawForce = typeof stats.force === 'string' ? parseFloat(stats.force) : 0
    const straining = state.includes('overload')
    const isWorking = state === 'descending' || state === 'loading' || straining

    const targetGain = isWorking ? 0.05 + Math.min(rawForce / 500, 0.05) : 0.0
    this.pumpGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.08)

    if (straining) {
      this.pumpOsc.frequency.setTargetAtTime(110 + Math.random() * 20, this.ctx.currentTime, 0.05)
    } else {
      this.pumpOsc.frequency.setTargetAtTime(85, this.ctx.currentTime, 0.1)
    }
  }

  handleEvent(event: SimulationEvent): void {
    const t = event.type
    if (t === 'press_exploded' || t === 'press_destroyed' || t === 'object_shattered' || t === 'shattered') {
      this.playExplosion()
    } else if (t === 'nokia_survived') {
      this.playNokiaJingle()
    } else if (t === 'strain_overload' || t === 'plate_cracked' || t === 'overload') {
      this.playCreak()
    } else if (t === 'bolt_pop') {
      this.playBoltPop()
    } else if (t === 'ram_contact' || t === 'contact') {
      this.playRamContact()
    }
  }

  private playBoltPop(): void {
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(3200 + Math.random() * 800, this.ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(1400, this.ctx.currentTime + 0.08)
    g.gain.setValueAtTime(0.12, this.ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.1)
    osc.connect(g)
    g.connect(this.dest)
    osc.start()
    osc.stop(this.ctx.currentTime + 0.11)
  }

  private playRamContact(): void {
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(160, this.ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.12)
    g.gain.setValueAtTime(0.15, this.ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.15)
    osc.connect(g)
    g.connect(this.dest)
    osc.start()
    osc.stop(this.ctx.currentTime + 0.16)
  }

  private playCreak(): void {
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(280 + Math.random() * 100, this.ctx.currentTime)
    osc.frequency.linearRampToValueAtTime(180, this.ctx.currentTime + 0.18)
    g.gain.setValueAtTime(0.06, this.ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.22)
    osc.connect(g)
    g.connect(this.dest)
    osc.start()
    osc.stop(this.ctx.currentTime + 0.23)
  }

  private playExplosion(): void {
    // Impact noise burst
    const noise = this.ctx.createBufferSource()
    noise.buffer = createNoiseBuffer(this.ctx, 0.8)
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(1400, this.ctx.currentTime)
    filter.frequency.exponentialRampToValueAtTime(120, this.ctx.currentTime + 0.6)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.25, this.ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.7)
    noise.connect(filter)
    filter.connect(g)
    g.connect(this.dest)
    noise.start()

    // Sub thump
    const sub = this.ctx.createOscillator()
    const subG = this.ctx.createGain()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(120, this.ctx.currentTime)
    sub.frequency.exponentialRampToValueAtTime(30, this.ctx.currentTime + 0.4)
    subG.gain.setValueAtTime(0.3, this.ctx.currentTime)
    subG.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.5)
    sub.connect(subG)
    subG.connect(this.dest)
    sub.start()
    sub.stop(this.ctx.currentTime + 0.52)
  }

  private playNokiaJingle(): void {
    // Classic 8-bit victorious arpeggio: E5, D5, F#4, G#4, C#5, B4, D4, E4
    const notes = [659.25, 587.33, 369.99, 415.3, 554.37, 493.88, 293.66, 329.63]
    const step = 0.08
    notes.forEach((freq, idx) => {
      const time = this.ctx.currentTime + idx * step
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      g.gain.setValueAtTime(0.05, time)
      g.gain.exponentialRampToValueAtTime(0.0001, time + step * 0.9)
      osc.connect(g)
      g.connect(this.dest)
      osc.start(time)
      osc.stop(time + step)
    })
  }

  dispose(): void {
    try {
      this.pumpOsc.stop()
      this.pumpGain.disconnect()
    } catch {
      // stopped
    }
  }
}

// -------------------------------------------------------------
// 08 WAREHOUSE: Fleet motor hum, delivery blips, rush alerts
// -------------------------------------------------------------
class WarehouseAudio implements SimulationAudioDriver {
  private humGain: GainNode
  private osc: OscillatorNode
  private filter: BiquadFilterNode

  constructor(private ctx: AudioContext, private dest: AudioNode) {
    this.humGain = ctx.createGain()
    this.humGain.gain.value = 0.0
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = 500
    this.osc = ctx.createOscillator()
    this.osc.type = 'sawtooth'
    this.osc.frequency.value = 140
    this.osc.connect(this.filter)
    this.filter.connect(this.humGain)
    this.humGain.connect(dest)
    this.osc.start()
  }

  update(stats: Record<string, number | string>): void {
    // "6 / 8": the hum of the drive motors grows with the number of robots on the move.
    const busy = parseFloat(String(stats.busy ?? '0'))
    const level = isNaN(busy) ? 0 : Math.min(busy / 8, 1.5)
    this.humGain.gain.setTargetAtTime(0.012 + level * 0.03, this.ctx.currentTime, 0.2)
    this.osc.frequency.setTargetAtTime(120 + level * 50, this.ctx.currentTime, 0.2)
  }

  private tone(frequency: number, at: number, length: number, level: number, type: OscillatorType = 'sine'): void {
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = type
    osc.frequency.value = frequency
    g.gain.setValueAtTime(level, at)
    g.gain.exponentialRampToValueAtTime(0.0001, at + length)
    osc.connect(g)
    g.connect(this.dest)
    osc.start(at)
    osc.stop(at + length + 0.01)
  }

  handleEvent(event: SimulationEvent): void {
    const now = this.ctx.currentTime
    if (event.type === 'order_complete') {
      // Scanner blip as a tote reaches a packing station.
      this.tone(1320, now, 0.09, 0.04)
    } else if (event.type === 'rush_order') {
      this.tone(880, now, 0.12, 0.07, 'triangle')
      this.tone(1175, now + 0.12, 0.16, 0.07, 'triangle')
    } else if (event.type === 'order_surge') {
      for (let i = 0; i < 4; i++) this.tone(660 + i * 110, now + i * 0.07, 0.1, 0.06, 'triangle')
    }
  }

  dispose(): void {
    try {
      this.osc.stop()
      this.osc.disconnect()
      this.humGain.disconnect()
    } catch {
      // already stopped
    }
  }
}

// -------------------------------------------------------------
// 09 WIND TUNNEL: Rushing air, fan drone, separation warning
// -------------------------------------------------------------
class TunnelAudio implements SimulationAudioDriver {
  private windGain: GainNode
  private windFilter: BiquadFilterNode
  private noise: AudioBufferSourceNode
  private fanGain: GainNode
  private fan: OscillatorNode

  constructor(private ctx: AudioContext, private dest: AudioNode) {
    this.noise = ctx.createBufferSource()
    this.noise.buffer = createNoiseBuffer(ctx, 2)
    this.noise.loop = true
    this.windFilter = ctx.createBiquadFilter()
    this.windFilter.type = 'bandpass'
    this.windFilter.frequency.value = 500
    this.windFilter.Q.value = 0.6
    this.windGain = ctx.createGain()
    this.windGain.gain.value = 0
    this.noise.connect(this.windFilter)
    this.windFilter.connect(this.windGain)
    this.windGain.connect(dest)
    this.noise.start()

    this.fan = ctx.createOscillator()
    this.fan.type = 'triangle'
    this.fan.frequency.value = 70
    this.fanGain = ctx.createGain()
    this.fanGain.gain.value = 0
    this.fan.connect(this.fanGain)
    this.fanGain.connect(dest)
    this.fan.start()
  }

  update(stats: Record<string, number | string>): void {
    const wind = parseFloat(String(stats.wind ?? '0'))
    const level = isNaN(wind) ? 0 : Math.min(wind / 40, 1)
    // Faster air is louder and brighter; the fan's blade-pass tone climbs with it.
    this.windGain.gain.setTargetAtTime(0.02 + level * 0.09, this.ctx.currentTime, 0.15)
    this.windFilter.frequency.setTargetAtTime(300 + level * 1100, this.ctx.currentTime, 0.15)
    this.fanGain.gain.setTargetAtTime(0.015 + level * 0.03, this.ctx.currentTime, 0.15)
    this.fan.frequency.setTargetAtTime(50 + level * 110, this.ctx.currentTime, 0.15)
  }

  handleEvent(event: SimulationEvent): void {
    if (event.type !== 'flow_separation') return
    // Stall warning: two falling tones.
    for (const [offset, frequency] of [[0, 740], [0.18, 520]]) {
      const osc = this.ctx.createOscillator()
      const g = this.ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = frequency
      g.gain.setValueAtTime(0.04, this.ctx.currentTime + offset)
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + offset + 0.16)
      osc.connect(g)
      g.connect(this.dest)
      osc.start(this.ctx.currentTime + offset)
      osc.stop(this.ctx.currentTime + offset + 0.17)
    }
  }

  dispose(): void {
    try {
      this.noise.stop()
      this.fan.stop()
      this.noise.disconnect()
      this.fan.disconnect()
      this.windGain.disconnect()
      this.fanGain.disconnect()
    } catch {
      // already stopped
    }
  }
}

/**
 * Creates and attaches an audio driver for the given simulation ID.
 */
export function createSimulationAudioDriver(simId: string): SimulationAudioDriver | null {
  const ctx = audioEngine.getContext()
  const dest = audioEngine.getMasterInput()
  if (!ctx || !dest) return null

  switch (simId) {
    case 'gears':
      return new GearsAudio(ctx, dest)
    case 'heat':
      return new HeatAudio(ctx, dest)
    case 'dyno':
      return new DynoAudio(ctx, dest)
    case 'factory':
      return new FactoryAudio(ctx, dest)
    case 'rack':
      return new RackAudio(ctx, dest)
    case 'orbital':
      return new OrbitalAudio(ctx, dest)
    case 'press':
      return new PressAudio(ctx, dest)
    case 'warehouse':
      return new WarehouseAudio(ctx, dest)
    case 'tunnel':
      return new TunnelAudio(ctx, dest)
    default:
      return null
  }
}
