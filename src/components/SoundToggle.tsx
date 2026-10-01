import { useEffect, useState } from 'react'
import { audioEngine } from '../audio/AudioEngine'

export function SoundToggle({ compact = false }: { compact?: boolean }) {
  const [enabled, setEnabled] = useState(() => audioEngine.isEnabled)

  useEffect(() => {
    return audioEngine.subscribe(setEnabled)
  }, [])

  if (compact) {
    return (
      <button
        type="button"
        className="lab-btn !min-h-8 sm:!min-h-9 !px-2.5 sm:!px-3.5 text-[0.625rem] sm:text-[0.6875rem] shrink-0 sm:shrink flex items-center gap-1.5"
        aria-label={enabled ? 'Mute audio' : 'Unmute audio'}
        aria-pressed={enabled}
        onClick={() => audioEngine.toggle()}
      >
        <span className={enabled ? 'text-amber' : 'text-lab-dim'}>{enabled ? '🔊' : '🔇'}</span>
        <span>{enabled ? 'Sound ON' : 'Sound OFF'}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      className="lab-label flex items-center gap-1.5 transition-colors hover:text-lab-bright cursor-pointer"
      aria-label={enabled ? 'Mute audio' : 'Unmute audio'}
      aria-pressed={enabled}
      onClick={() => audioEngine.toggle()}
    >
      <span className={enabled ? 'text-amber' : 'text-lab-dim'}>{enabled ? '🔊' : '🔇'}</span>
      <span>{enabled ? 'Sound ON' : 'Sound OFF'}</span>
    </button>
  )
}
