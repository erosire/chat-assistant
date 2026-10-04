// Icon barrel — now a thin RE-EXPORT of @rightless/icons.
//
// The stroke-based SVG family that used to live in this directory (24×24
// grid, currentColor, strokeWidth 2, round caps — the Feather/Lucide visual
// system) moved into the workspace icon package
// (packages/rightless/icons/src/components/react) so every package in the
// monorepo draws its icons from ONE source. The re-export keeps this
// package's public API stable: `export * from './icons'` in src/index.ts and
// every `from '../icons'` import (ChatAssistantApp.tsx) resolve exactly as
// before, and the names below are the same components with the same
// geometry — pinned by icons.test.tsx.
//
// Only the ten glyphs this package actually uses are re-exported; the
// remaining built-ins of @rightless/icons stay out of this package's API.
export { IconBase } from '@rightless/icons';
export type { IconBaseProps, IconProps } from '@rightless/icons';
export { MenuIcon } from '@rightless/icons';
export { MicIcon } from '@rightless/icons';
export { CloseIcon } from '@rightless/icons';
export { EditIcon } from '@rightless/icons';
export { CopyIcon } from '@rightless/icons';
export { ChevronRightIcon } from '@rightless/icons';
export { ChevronDownIcon } from '@rightless/icons';
export { ChevronUpIcon } from '@rightless/icons';
export { SwitchIcon } from '@rightless/icons';
export { ForkIcon } from '@rightless/icons';
