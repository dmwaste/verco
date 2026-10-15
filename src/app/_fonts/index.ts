import localFont from 'next/font/local'

/**
 * Brand fonts, self-hosted so a build never fetches Google Fonts. Google
 * intermittently answers build-time requests with `/l/font?kit=…&skey=…` URLs
 * that next/font/google can't parse, failing CI and production deploy builds.
 *
 * The .woff2 files are Google's own latin + latin-ext subsets, byte-identical
 * to what next/font/google served (OFL licences alongside). Each subset is its
 * own localFont() carrying Google's unicode-range, so — as before — browsers
 * only download latin-ext when a page contains such characters (e.g. "Łukasz").
 * globals.css lists each -ext variable BEFORE its latin one: the latin variable
 * ends with the metric-matched Arial fallback, which would otherwise catch
 * latin-ext characters first. next/font needs literal option values, hence the
 * repeated range strings.
 */

export const poppins = localFont({
  src: [
    { path: './poppins-latin-500.woff2', weight: '500' },
    { path: './poppins-latin-600.woff2', weight: '600' },
    { path: './poppins-latin-700.woff2', weight: '700' },
  ],
  variable: '--font-poppins',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
})

export const poppinsExt = localFont({
  src: [
    { path: './poppins-latin-ext-500.woff2', weight: '500' },
    { path: './poppins-latin-ext-600.woff2', weight: '600' },
    { path: './poppins-latin-ext-700.woff2', weight: '700' },
  ],
  variable: '--font-poppins-ext',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
    },
  ],
})

// DM Sans is a variable font: one file covers the 400–600 range.
export const dmSans = localFont({
  src: './dm-sans-latin.woff2',
  weight: '400 600',
  variable: '--font-dm-sans',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
})

export const dmSansExt = localFont({
  src: './dm-sans-latin-ext.woff2',
  weight: '400 600',
  variable: '--font-dm-sans-ext',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
    },
  ],
})
