import { Link } from 'react-router-dom'
import { usePageMeta } from '../app/usePageMeta'
import { Header } from '../components/Header'

export function NotFound() {
  usePageMeta('Not found')
  return (
    <>
      <Header />
      <main className="mx-auto max-w-[1400px] px-4 py-20 sm:px-6">
        <p className="font-mono text-xs font-semibold tracking-[0.16em] text-signal-red">404 · NO SUCH ENVIRONMENT</p>
        <h1 className="mt-3 text-3xl font-medium text-lab-bright">This simulation does not exist.</h1>
        <Link to="/" className="lab-btn mt-6">
          ← Back to the lab
        </Link>
      </main>
    </>
  )
}
