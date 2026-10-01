import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { trackVisit } from './app/visitorCounter'
import './styles/index.css'

// Count the visit on any entry route, including direct simulation links.
void trackVisit()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
