// React entry point for the Chat Assistant distribution.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

// Mount the application inside StrictMode so lifecycle mistakes are visible in development.
const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
