import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Default transform allows http/https/mailto but strips tel: — council phone
 * links need it. Everything else still flows through the default, so
 * javascript: and friends stay stripped. */
function urlTransform(url: string): string {
  return url.toLowerCase().startsWith('tel:') ? url : defaultUrlTransform(url)
}

/*
 * FaqAnswer — markdown renderer for FAQ answer content.
 *
 * Deliberately directive-free so one component serves two render contexts:
 *
 *   (public)/contact/page.tsx [RSC]        admin faqs-tab.tsx ['use client']
 *        │ rendered on the server               │ bundled client-side
 *        ▼                                      ▼
 *    <FaqAnswer>                            <FaqAnswer>
 *    nodes serialise into the RSC           live preview, re-renders
 *    payload — react-markdown never         on every keystroke
 *    ships in the public bundle
 *
 * Security: no rehype-raw — raw HTML in answers stays inert text, and
 * react-markdown's default URL transform strips javascript: hrefs. Do not
 * add rehype-raw; answers are admin-authored multi-tenant content rendered
 * on unauthenticated public pages.
 */
export function FaqAnswer({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={urlTransform}
      disallowedElements={['img']}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="mb-1">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-gray-700">{children}</strong>,
        a: ({ href, children }) => {
          // case-insensitive; also catches protocol-relative //host links
          const isExternal = /^(https?:)?\/\//i.test(href ?? '')
          return (
            <a
              href={href}
              className="font-medium text-[var(--brand)] underline"
              {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              {children}
            </a>
          )
        },
        table: ({ children }) => (
          <div className="mb-2 overflow-x-auto last:mb-0">
            <table className="w-full border-collapse text-left">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border-b border-gray-200 py-1.5 pr-3 align-top font-semibold text-gray-700">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border-b border-gray-100 py-1.5 pr-3 align-top">{children}</td>
        ),
      }}
    >
      {markdown}
    </ReactMarkdown>
  )
}
