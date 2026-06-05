'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'
import { SkeletonRow } from '@/components/ui/skeleton'
import { UserFormDialog } from './user-form-dialog'
import type { EditUserData } from './user-form-dialog'
import type { Database } from '@/lib/supabase/types'

type AppRole = Database['public']['Enums']['app_role']

const ROLE_OPTIONS: AppRole[] = [
  'contractor-admin',
  'contractor-staff',
  'field',
  'client-admin',
  'client-staff',
  'ranger',
]

const ROLE_STYLE: Record<AppRole, { bg: string; text: string; label: string }> = {
  'contractor-admin': { bg: 'bg-[#293F52]/10', text: 'text-[#293F52]', label: 'Contractor Admin' },
  'contractor-staff': { bg: 'bg-[#293F52]/10', text: 'text-[#293F52]', label: 'Contractor Staff' },
  field: { bg: 'bg-purple-50', text: 'text-purple-700', label: 'Contractor Field' },
  'client-admin': { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Client Admin' },
  'client-staff': { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Client Staff' },
  ranger: { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Client Ranger' },
  resident: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Resident' },
  strata: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Strata' },
}

const PAGE_SIZE = 50

interface UsersClientProps {
  /** Selected tenant from the admin switcher. Scopes the list to that client's
   *  users PLUS contractor-tier staff (client_id IS NULL) — never hide D&M's own
   *  staff, who manage every client. */
  clientId: string
}

export function UsersClient({ clientId }: UsersClientProps) {
  const supabase = createClient()
  const queryClient = useQueryClient()

  // Fetch current user's role to conditionally show Add/Edit buttons
  const { data: callerRole } = useQuery({
    queryKey: ['current-user-role'],
    queryFn: async () => {
      const { data } = await supabase.rpc('current_user_role')
      return (data as AppRole) ?? null
    },
  })

  const canManageUsers = callerRole === 'contractor-admin' || callerRole === 'client-admin'

  const [page, setPage] = useState(0)
  const [roleFilter, setRoleFilter] = useState('')
  const [activeFilter, setActiveFilter] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editData, setEditData] = useState<EditUserData | null>(null)
  const [actionMenuId, setActionMenuId] = useState<string | null>(null)

  const searchTimerRef = useState<ReturnType<typeof setTimeout> | null>(null)
  function handleSearchChange(value: string) {
    setSearch(value)
    if (searchTimerRef[0]) clearTimeout(searchTimerRef[0])
    const timer = setTimeout(() => {
      setDebouncedSearch(value)
      setPage(0)
    }, 300)
    searchTimerRef[1](timer)
  }

  const { data: usersData, isLoading } = useQuery({
    queryKey: ['admin-users', clientId, roleFilter, activeFilter, debouncedSearch, page],
    queryFn: async () => {
      let query = supabase
        .from('user_roles')
        .select(
          // VER-219: VER-216's composite FK (sub_client_id, client_id) → sub_client(id, client_id)
          // breaks BOTH PostgREST embed-by-column resolutions on this table:
          //   - `client:client_id(...)`         → ambiguous (two FK paths from client_id)
          //   - `sub_client:sub_client_id(...)` → PostgREST cannot map sub_client_id to one
          //                                       target column (composite FK references both
          //                                       sub_client.id AND sub_client.client_id)
          // Both must use the explicit FK-name disambiguator. PR #81 only fixed the client
          // embed and left sub_client broken — page continued to return PGRST200 / HTTP 400
          // ("Could not find a relationship between 'user_roles' and 'sub_client_id'").
          // Captured in `feedback-composite-fk-breaks-embed.md`.
          `id, role, is_active, created_at, client_id, contractor_id, sub_client_id,
           profiles!inner(id, email, display_name, contacts(first_name, last_name, full_name, mobile_e164)),
           client:user_roles_client_id_fkey(name),
           contractor:contractor_id(name),
           sub_client:user_roles_sub_client_fk(code, name)`,
          { count: 'exact' }
        )
        .not('role', 'in', '("resident")')
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      // Scope to the selected tenant's users, but keep contractor-tier staff
      // (client_id IS NULL) visible — they manage every client.
      if (clientId) query = query.or(`client_id.eq.${clientId},client_id.is.null`)
      if (roleFilter) query = query.eq('role', roleFilter as AppRole)
      if (activeFilter === 'active') query = query.eq('is_active', true)
      if (activeFilter === 'inactive') query = query.eq('is_active', false)
      if (debouncedSearch) {
        query = query.or(
          buildSearchOrFilter(
            ['profiles.email', 'profiles.display_name'],
            debouncedSearch
          ),
          { referencedTable: 'profiles' }
        )
      }

      const { data, count } = await query
      return { users: data ?? [], total: count ?? 0 }
    },
  })

  const users = usersData?.users ?? []
  const total = usersData?.total ?? 0

  function openAddDialog() {
    setEditData(null)
    setDialogOpen(true)
  }

  function openEditDialog(ur: (typeof users)[number]) {
    const profile = ur.profiles as unknown as {
      id: string
      email: string
      display_name: string | null
      contacts: { first_name: string; last_name: string; full_name: string; mobile_e164: string | null } | null
    }
    // Fall back to splitting display_name on first space if there's no contact row.
    const fallback = (profile.display_name ?? '').trim()
    const fallbackFirst = fallback.split(' ', 1)[0] ?? ''
    const fallbackLast = fallback.includes(' ') ? fallback.slice(fallback.indexOf(' ') + 1) : ''
    setEditData({
      user_id: profile.id,
      first_name: profile.contacts?.first_name ?? fallbackFirst,
      last_name: profile.contacts?.last_name ?? fallbackLast,
      email: profile.email,
      mobile_e164: profile.contacts?.mobile_e164 ?? null,
      role: ur.role as AppRole,
      contractor_id: (ur as unknown as { contractor_id: string | null }).contractor_id,
      client_id: (ur as unknown as { client_id: string | null }).client_id,
      sub_client_id: (ur as unknown as { sub_client_id: string | null }).sub_client_id,
    })
    setDialogOpen(true)
  }

  async function handleRevokeAccess(userRoleId: string, isCurrentlyActive: boolean) {
    setActionMenuId(null)
    await supabase
      .from('user_roles')
      .update({ is_active: !isCurrentlyActive })
      .eq('id', userRoleId)
    void queryClient.invalidateQueries({ queryKey: ['admin-users'] })
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            Users
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            {total} user roles
          </p>
        </div>
        {canManageUsers && (
          <button
            type="button"
            onClick={openAddDialog}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white"
          >
            + Add User
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2.5 px-7 py-4">
        <div className="flex w-60 items-center gap-2 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search email, name..."
            aria-label="Search users"
            className="w-full border-none bg-transparent text-body-sm text-gray-900 outline-none placeholder:text-gray-300"
          />
        </div>

        <select
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value); setPage(0) }}
          aria-label="Filter by role"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All Roles</option>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>{ROLE_STYLE[r].label}</option>
          ))}
        </select>

        <select
          value={activeFilter}
          onChange={(e) => { setActiveFilter(e.target.value); setPage(0) }}
          aria-label="Filter by status"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
        >
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Name</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Email</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Role</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Organisation</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Sub-client</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Active</th>
                <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Joined</th>
                {canManageUsers && (
                  <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500"></th>
                )}
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={canManageUsers ? 8 : 7} />
              ))}
              {!isLoading && users.length === 0 && (
                <tr><td colSpan={canManageUsers ? 8 : 7} className="px-4 py-8 text-center text-sm text-gray-400">No users found</td></tr>
              )}
              {users.map((ur) => {
                const profile = ur.profiles as unknown as { id: string; email: string; display_name: string | null; contacts: { full_name: string; mobile_e164: string | null } | null }
                const client = ur.client as { name: string } | null
                const contractor = ur.contractor as { name: string } | null
                const subClient = (ur as unknown as { sub_client: { code: string; name: string } | null }).sub_client
                const rs = ROLE_STYLE[ur.role as AppRole]
                const name = profile?.contacts?.full_name ?? profile?.display_name ?? '—'
                const org = contractor?.name ?? client?.name ?? '—'
                const subClientLabel = subClient ? `${subClient.code} — ${subClient.name}` : '—'

                return (
                  <tr key={ur.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-3 text-body-sm font-semibold text-[#293F52]">
                      {name}
                    </td>
                    <td className="px-4 py-3 text-body-sm text-gray-600">
                      {profile?.email ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${rs.bg} ${rs.text}`}>
                        {rs.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {org}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {subClientLabel}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex size-2 rounded-full ${ur.is_active ? 'bg-emerald-400' : 'bg-gray-300'}`} />
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {formatDistanceToNow(new Date(ur.created_at), { addSuffix: true })}
                    </td>
                    {canManageUsers && (
                      <td className="relative px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setActionMenuId(actionMenuId === ur.id ? null : ur.id)}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
                          </svg>
                        </button>
                        {actionMenuId === ur.id && (
                          <div className="absolute bottom-full right-4 z-10 mb-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                            <button
                              type="button"
                              onClick={() => { setActionMenuId(null); openEditDialog(ur) }}
                              className="block w-full px-4 py-2 text-left text-body-sm text-gray-700 hover:bg-gray-50"
                            >
                              Edit user
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRevokeAccess(ur.id, ur.is_active)}
                              className="block w-full px-4 py-2 text-left text-body-sm text-red-600 hover:bg-gray-50"
                            >
                              {ur.is_active ? 'Revoke access' : 'Restore access'}
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {total > PAGE_SIZE && (
          <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
            <span>Showing {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, total)} of {total}</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium disabled:opacity-30">Previous</button>
              <button type="button" onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * PAGE_SIZE >= total} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium disabled:opacity-30">Next</button>
            </div>
          </div>
        )}
      </div>

      {/* Shared dialog for Add / Edit */}
      {canManageUsers && callerRole && (
        <UserFormDialog
          callerRole={callerRole}
          editData={editData}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </>
  )
}
