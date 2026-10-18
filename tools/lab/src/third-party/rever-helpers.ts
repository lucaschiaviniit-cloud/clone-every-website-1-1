// Selected unmodified functions. Copyright 2026 TaeVirus. Apache-2.0; see licenses/.
export interface HarHeader {
  name: string
  value: string
}

/** Convert a header record into HAR's name/value array form. */
export function toHeaders(h: Record<string, string> | undefined): HarHeader[] {
  if (!h) return []
  const out: HarHeader[] = []
  for (const [name, value] of Object.entries(h)) {
    // CDP folds repeated header fields (Set-Cookie, Warning, ...) into one
    // '\n'-joined value; HAR requires one entry per field line, and header
    // field-values themselves can never contain a raw newline, so splitting
    // is always safe.
    for (const line of value.split('\n')) {
      out.push({ name, value: line })
    }
  }
  return out
}

export function detectBundler(body: string): { name: string; signature: string } {
  const head = body.slice(0, 8000)
  const tail = body.slice(-4000)
  const both = head + tail
  if (/__vite__|import\.meta\.(?:url|env|hot)/.test(both))
    return { name: 'vite', signature: 'import.meta / __vite__' }
  if (/\bturbopack\b/i.test(both)) return { name: 'turbopack', signature: 'turbopack marker' }
  if (/__webpack_require__|webpackJsonp|webpackChunk/.test(both))
    return { name: 'webpack', signature: '__webpack_require__ / webpackJsonp' }
  if (/require=function\s*\(/.test(head) && /browserify/i.test(both))
    return { name: 'browserify', signature: 'browserify runtime' }
  if (/Object\.defineProperty\(exports/.test(head) && /import\s*\{[^}]+\}\s*from\s*["']/.test(both))
    return { name: 'rollup', signature: 'rollup ESM output' }
  return { name: 'unknown', signature: '' }
}
