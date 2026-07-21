import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// shared/keystone-provider.js and shared/keystone-auth.js read config off
// this global, unchanged from their app/*.html usage — set before App
// (and anything it imports) runs.
window.KEYSTONE_CONFIG = {
  apiKey: import.meta.env.VITE_API_KEY,
  sheetId: import.meta.env.VITE_SHEET_ID,
  oauthClientId: import.meta.env.VITE_OAUTH_CLIENT_ID,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
