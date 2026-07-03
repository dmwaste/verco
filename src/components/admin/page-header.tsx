interface PageHeaderProps {
  title: string
  subtitle?: React.ReactNode
  /** Right-side actions (buttons/links) */
  children?: React.ReactNode
}

/** Standard admin page header: title + optional count subtitle + actions. */
export function PageHeader({ title, subtitle, children }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
      <div>
        <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
          {title}
        </h1>
        {subtitle != null && (
          <p className="mt-0.5 text-body-sm text-gray-500">{subtitle}</p>
        )}
      </div>
      {children != null && (
        <div className="flex items-center gap-2.5">{children}</div>
      )}
    </div>
  )
}
