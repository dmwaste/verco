/**
 * Inline brand marks for the root landing page.
 *
 * The Verco wordmark SVG exports are NOT safe as <img> sources — they render
 * the word via <text> + a Google Fonts @import, which <img> contexts never
 * fetch (silent Times fallback). The icon paths are pure vectors, so the
 * lockup here inlines the icon and sets the wordmark in Poppins 700 (already
 * loaded via next/font). Acceptance-checked against the png-1200w exports.
 *
 * The D&M logo is inlined from dm-logo-full-colour.svg with the baked white
 * background <rect> stripped so it sits on any surface.
 */

const VERCO_GREEN = '#00E47C'
const VERCO_CIRCLE = '#234054'
const VERCO_NAVY = '#293F52'

function VercoIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 240"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(8, 0)">
        <path
          fill={VERCO_GREEN}
          d="M224.1,101.9c-7.5-49-53.1-87.6-102.7-86.8,0,0-17.4,0-17.4,0,0,0,0,17.2,0,32.2s8.5,19.5,19.2,20,11.2,1,15.5,2.8c34.2,10.9,46.2,57.9,21.4,83.8-13.4,16.5-36.2,18.6-56.1,17.3-9.7,0-25.1,0-34.7,0,0-15.5,0-32.8,0-49.4,0-11-8.9-20-20-20-14.3,0-30.7,0-32.1,0,0,15.5,0,36.6,0,52.1,0,21.7,0,47.7,0,69.4,8.7,0,26,0,34.7,0,28-.8,59,1.8,86.8-1.4,55.3-8.2,95.8-65.1,85.3-120Z"
        />
        <circle fill={VERCO_CIRCLE} cx="52" cy="49.9" r="34.7" />
      </g>
    </svg>
  )
}

export function VercoLogo({
  variant = 'colour',
  className,
}: {
  variant?: 'colour' | 'reversed'
  className?: string
}) {
  const wordmarkColour = variant === 'reversed' ? '#FFFFFF' : VERCO_NAVY
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <VercoIcon className="h-8 w-8" />
      <span
        className="font-[family-name:var(--font-heading)] text-[22px] font-bold leading-none tracking-[0.02em]"
        style={{ color: wordmarkColour }}
      >
        VERCO
      </span>
    </span>
  )
}

export function DmLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 772.5 238.8"
      className={className}
      role="img"
      aria-label="D&M Waste Management"
    >
      <path
        fill={VERCO_GREEN}
        d="M224.1,101.9c-7.5-49-53.1-87.6-102.7-86.8,0,0-17.4,0-17.4,0,0,0,0,17.2,0,32.2s8.5,19.5,19.2,20,11.2,1,15.5,2.8c34.2,10.9,46.2,57.9,21.4,83.8-13.4,16.5-36.2,18.6-56.1,17.3-9.7,0-25.1,0-34.7,0,0-15.5,0-32.8,0-49.4,0-11-8.9-20-20-20-14.3,0-30.7,0-32.1,0,0,15.5,0,36.6,0,52.1,0,21.7,0,47.7,0,69.4,8.7,0,26,0,34.7,0,28-.8,59,1.8,86.8-1.4,55.3-8.2,95.8-65.1,85.3-120Z"
      />
      <circle fill={VERCO_CIRCLE} cx="52" cy="49.9" r="34.7" />
      <path
        fill={VERCO_NAVY}
        d="M755.2,40.6v155.5h-31.2v-93.2l-34.8,93.2h-30.6l-35-93.5v93.5h-31.2V40.6h38.1l43.6,115.2,43.2-115.2h37.8Z"
      />
      <path
        fill={VERCO_NAVY}
        d="M395.2,77.7c-6.7-11.8-16.1-21-28.4-27.5-12.3-6.5-26.6-9.8-43.1-9.8h-58.4v155.9h58.4c16.3,0,30.6-3.3,42.9-9.8,12.4-6.5,22-15.7,28.6-27.5,6.8-11.8,10.2-25.4,10.2-40.6s-3.4-28.9-10.2-40.6h0ZM361.6,156.7c-9.2,8.9-22,13.5-38.3,13.5h-26.7v-103.7h26.7c16.5,0,29.2,4.6,38.3,13.7s13.7,22,13.7,38.3-4.6,29.2-13.7,38.1Z"
      />
      <path
        fill={VERCO_NAVY}
        d="M474.6,198.4c-11.7,0-21.9-1.9-30.5-5.7-8.4-3.7-15-9-19.5-15.8-4.5-6.7-6.8-14.8-6.8-23.9s2.5-17.7,7.5-25.2c5-7.5,12.7-13.8,22.8-18.6l3.5-1.7-2.4-3c-3.7-4.5-6.3-8.9-7.8-13-1.5-4.1-2.3-8.6-2.3-13.5s1.8-13.2,5.4-18.9c3.6-5.6,8.9-10.1,15.7-13.4,7-3.3,15.5-5,25.2-5s18.2,1.8,24.9,5.3c6.6,3.5,11.7,8.1,15,13.9,2.8,4.9,4.4,10.4,4.6,16.2h-30.3c-.4-3.5-1.7-6.3-3.8-8.4-2.8-2.8-6.4-4.2-10.8-4.2s-8.1,1.3-11,3.9c-3.1,2.7-4.6,6.2-4.6,10.4s1.2,7.5,3.5,11.5c2.1,3.7,5.5,7.9,10,12.5l41.8,40.9,11.9-22.8h31.6s-17,32.3-22.1,40.1l-1.4,2.1,34.5,33.9h-36.1l-15.6-15.2-2.1,1.6c-13.9,10.6-30.9,16-50.4,16ZM466.6,125.1c-11.9,6.1-17.9,14.6-17.9,25.2s2.6,12.2,7.7,16.6c5,4.3,11.7,6.5,19.9,6.5s20.3-3.1,28.6-9.1l2.9-2.1-39.3-38-1.9,1Z"
      />
    </svg>
  )
}
