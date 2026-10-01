/**
 * Global Web Audio manager for SimForge.
 *
 * Requirements from spec.md §31:
 * - Subtle audio, zero external audio asset downloads (100% procedural Web Audio synthesis).
 * - Disabled (muted) by default.
 * - Sound ON / OFF toggle.
 * - No audio autoplays without user interaction.
 */

type Listener = (enabled: boolean) => void

class AudioEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private compressor: DynamicsCompressorNode | null = null
  private enabled = false
  private listeners = new Set<Listener>()

  constructor() {
    // Respect stored user preference, but default to false
    try {
      const stored = localStorage.getItem('simforge_audio')
      this.enabled = stored === 'true'
    } catch {
      this.enabled = false
    }
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.enabled)
    return () => this.listeners.delete(listener)
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled)
    return this.enabled
  }

  setEnabled(enable: boolean): void {
    this.enabled = enable
    try {
      localStorage.setItem('simforge_audio', String(enable))
    } catch {
      // storage unavailable
    }

    if (enable) {
      this.initContext()
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume()
      }
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.setTargetAtTime(0.35, this.ctx.currentTime, 0.05)
      }
    } else {
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
      }
    }

    for (const listener of this.listeners) {
      listener(this.enabled)
    }
  }

  getContext(): AudioContext | null {
    if (!this.enabled) return null
    this.initContext()
    return this.ctx
  }

  getMasterInput(): AudioNode | null {
    if (!this.enabled) return null
    this.initContext()
    return this.compressor
  }

  private initContext(): void {
    if (this.ctx) return
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return

    this.ctx = new AudioCtx()
    this.compressor = this.ctx.createDynamicsCompressor()
    this.compressor.threshold.value = -12
    this.compressor.knee.value = 20
    this.compressor.ratio.value = 8
    this.compressor.attack.value = 0.003
    this.compressor.release.value = 0.15

    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = this.enabled ? 0.35 : 0

    this.compressor.connect(this.masterGain)
    this.masterGain.connect(this.ctx.destination)
  }

  playUiClick(tone: 'neutral' | 'subtle' | 'high' | 'heavy' = 'neutral'): void {
    if (!this.enabled || !this.ctx || !this.compressor) return
    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()

    osc.type = tone === 'heavy' ? 'triangle' : 'sine'
    const freq = tone === 'subtle' ? 600 : tone === 'high' ? 1400 : tone === 'heavy' ? 320 : 900
    osc.frequency.setValueAtTime(freq, now)
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.4), now + 0.02)

    gain.gain.setValueAtTime(tone === 'subtle' ? 0.02 : 0.04, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.025)

    osc.connect(gain)
    gain.connect(this.compressor)
    osc.start(now)
    osc.stop(now + 0.03)
  }

  playUiSliderTick(): void {
    if (!this.enabled || !this.ctx || !this.compressor) return
    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(1600, now)
    gain.gain.setValueAtTime(0.012, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.008)

    osc.connect(gain)
    gain.connect(this.compressor)
    osc.start(now)
    osc.stop(now + 0.01)
  }

  playUiChime(): void {
    if (!this.enabled || !this.ctx || !this.compressor) return
    const now = this.ctx.currentTime
    const notes = [659.25, 880]
    notes.forEach((freq, i) => {
      const t = now + i * 0.08
      const osc = this.ctx!.createOscillator()
      const gain = this.ctx!.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.04, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      osc.connect(gain)
      gain.connect(this.compressor!)
      osc.start(t)
      osc.stop(t + 0.23)
    })
  }

  playCardHover(): void {
    if (!this.enabled || !this.ctx || !this.compressor) return
    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(700, now)
    osc.frequency.exponentialRampToValueAtTime(950, now + 0.04)
    gain.gain.setValueAtTime(0.01, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05)
    osc.connect(gain)
    gain.connect(this.compressor)
    osc.start(now)
    osc.stop(now + 0.055)
  }
}

export const audioEngine = new AudioEngine()
