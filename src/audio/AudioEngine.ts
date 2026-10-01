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
}

export const audioEngine = new AudioEngine()
