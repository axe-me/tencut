import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Platform class for the few styling differences (e.g. room for macOS traffic lights in the header).
document.body.classList.add(`platform-${window.tencut.platform}`)

createRoot(document.getElementById('root')!).render(<App />)
