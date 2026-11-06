// Vite client types for this distribution.
//
// Adds the ambient asset-module declarations (`*.css`, `*.svg`, `?url`, ...) that
// src/main.tsx needs to `import './dashboard/styles/index.css'`, mirroring the
// convention every other distribution in this workspace uses. Without it,
// `tsc --noEmit` reports TS2307 for the stylesheet import.
/// <reference types="vite/client" />
