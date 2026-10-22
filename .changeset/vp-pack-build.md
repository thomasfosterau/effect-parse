---
"@thomasfosterau/effect-parse": patch
---

The package is now built with `vp pack` (tsdown) instead of `tsc`. `dist/` keeps the same layout, entry points and runtime exports, and every top-level call stays marked `/*#__PURE__*/`; the declaration files spell some types out where they used to write `typeof Token.take` and the like, and `Parser.Do` is typed `Parser<Record<never, never>, …>` (the same type as `Parser<{}, …>`). The root entry's `index.js` no longer ships a source map.
