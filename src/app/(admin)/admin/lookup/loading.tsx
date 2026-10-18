import { PageHeader } from '@/components/admin/page-header'

// Streams straight away while the lookup queries run — staff are on the call.
export default function CallerLookupLoading() {
  return (
    <>
      <PageHeader title="Caller lookup" subtitle="Looking up the caller…" />
      <div className="px-7 py-5">
        <div className="h-40 animate-pulse rounded-xl bg-white shadow-sm" />
      </div>
    </>
  )
}
