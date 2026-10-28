import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/red-hat-display/wght.css'
import './styles/tokens.css'
import './styles/voice.css'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => undefined)
  })
}

// Ask the browser to keep recordings until they are uploaded. Granted automatically for installed apps in most browsers.
void navigator.storage?.persist?.().catch(() => undefined)
