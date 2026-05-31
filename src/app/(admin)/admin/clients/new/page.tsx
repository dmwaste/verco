import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { NewClientForm } from './new-client-form'

export default async function NewClientPage() {
  // Creating a client is contractor-admin only (client INSERT RLS). Gate the
  // page too so client-tier users can't reach the form. (See QA-A06.)
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'contractor-admin') notFound()

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
          New Client
        </h1>
        <p className="mt-0.5 text-body-sm text-gray-500">
          Set up a new client for your contractor
        </p>
      </div>
      <div className="flex-1 px-7 py-6">
        <NewClientForm />
      </div>
    </div>
  )
}
