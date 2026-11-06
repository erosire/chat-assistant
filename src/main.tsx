// React entry point for the Chat Assistant distribution.
import React from 'react';
import ReactDOM from 'react-dom/client';
// The vendored workstation skin: one stylesheet entry (styles/index.css) that
// pulls in the token layer, the shell structure and the per-area files. Kept
// explicit for the standalone app bundle; ChatAssistantApp imports the SAME
// module (dashboard/ChatAssistantApp.tsx) so an embedder of the export gets the
// skin too, and Vite resolves the duplicate into one CSS asset.
import './dashboard/styles/index.css';
import { App } from './App';
import { PRODUCT_TITLE } from './version';

// The browser document title represents the app name; upgrade the static
// index.html <title> to the versioned product title (Chat Assistant v<version>)
// from package.json. index.html keeps the plain name as the pre-JS fallback.
document.title = PRODUCT_TITLE;

// Mount the application inside StrictMode so lifecycle mistakes are visible in development.
const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
