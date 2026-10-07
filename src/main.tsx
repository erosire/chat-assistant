// React entry point for the Chat Assistant distribution.
import React from 'react';
import ReactDOM from 'react-dom/client';
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
