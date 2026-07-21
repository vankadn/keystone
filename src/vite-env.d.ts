/// <reference types="vite/client" />

// shared/keystone-provider.js and shared/keystone-auth.js read config off
// this global (unchanged from their app/*.html usage) — main.tsx sets it
// from Vite's import.meta.env before anything else renders.
interface Window {
  KEYSTONE_CONFIG: {
    apiKey: string;
    sheetId: string;
    oauthClientId: string;
  };
}
