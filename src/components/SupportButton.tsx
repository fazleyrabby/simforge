import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { audioEngine } from '../audio/AudioEngine'
import { site } from '../data/site'

/** A way to tip the author. Opens a dialog listing the support options. */
export function SupportButton({ variant = 'nav' }: { variant?: 'nav' | 'button' }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Keep Escape from also reaching page-level shortcuts.
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    const trigger = triggerRef.current
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      trigger?.focus()
    }
  }, [open])

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(site.support.payoneerId)
      setCopied(true)
      audioEngine.playUiChime()
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      window.prompt('Copy this Payoneer ID', site.support.payoneerId)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={
          variant === 'nav'
            ? 'lab-label flex cursor-pointer items-center gap-1.5 !text-amber transition-colors hover:!text-lab-bright'
            : 'lab-btn'
        }
        aria-haspopup="dialog"
        onClick={() => {
          audioEngine.playUiClick('neutral')
          setOpen(true)
        }}
      >
        <span aria-hidden="true">♥</span>
        Support
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false)
            }}
          >
            <div role="dialog" aria-modal="true" aria-labelledby="support-title" className="lab-panel max-h-full w-full max-w-md overflow-y-auto !border-lab-line-strong !bg-lab-panel p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="lab-label !text-amber">Support</p>
                  <h2 id="support-title" className="mt-1 text-xl font-medium text-lab-bright">
                    Support the project
                  </h2>
                  <p className="mt-1 text-sm text-lab-dim">
                    Simulation Lab is free and open source. A tip keeps new worlds coming.
                  </p>
                </div>
                <button ref={closeRef} type="button" className="lab-btn !min-h-8 !px-2.5" aria-label="Close" onClick={() => setOpen(false)}>
                  ✕
                </button>
              </div>

              <ul className="mt-5 flex flex-col gap-3">
                {site.support.links.map((link) => (
                  <li key={link.url}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center justify-between gap-4 border border-lab-line-strong px-4 py-3 transition-colors hover:border-amber"
                    >
                      <span>
                        <span className="block font-mono text-sm font-semibold text-lab-bright">{link.name}</span>
                        <span className="lab-label mt-1 block !text-[0.625rem]">{link.audience}</span>
                        <span className="mt-1 block text-xs text-lab-dim">{link.methods}</span>
                      </span>
                      <span className="shrink-0 font-mono text-xs font-medium tracking-[0.12em] text-amber group-hover:text-lab-bright">
                        {link.action} →
                      </span>
                    </a>
                  </li>
                ))}
              </ul>

              <p className="lab-label mt-5 !text-[0.625rem]">Or direct via Payoneer, no fee</p>
              <div className="mt-2 flex items-center justify-between gap-3 border border-lab-line-strong px-4 py-2.5">
                <span>
                  <span className="lab-label block !text-[0.625rem]">Payoneer customer ID</span>
                  <span className="font-mono text-lg font-semibold tabular-nums text-amber">{site.support.payoneerId}</span>
                </span>
                <button type="button" className="lab-btn !min-h-8" onClick={() => void copyId()}>
                  {copied ? 'Copied' : 'Copy ID'}
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-lab-dim">
                In the Payoneer app: Pay → Pay to recipient → enter the ID above.
              </p>

              <p className="mt-5 border-t border-lab-line pt-4 text-center text-xs text-lab-dim">Thank you for your support.</p>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
