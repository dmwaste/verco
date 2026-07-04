'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'
import { SkeletonRow } from '@/components/ui/skeleton'
import { RowActionMenu } from '@/components/admin/row-action-menu'
import { UserFormDialog } from './user-form-dialog'
import type { EditUserData } from './user-form-dialog'
import type { Database } from '@/lib/supabase/types'
import { Th } from '@/components/admin/th'
import { Pagination } from '@/components/admin/pagination'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'
import { StatusBadge } from '@/components/status-badge'
import { getStatusStyle } from '@/lib/ui/status-styles'

type AppRole = Database['public']['Enums']['app_role']

const ROLE_OPTIONS: AppRole[] = [
  'contractor-admin',
  'contractor-staff',
  'field',
  'client-admin',
  'client-staff',
  'ranger',
]


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
    await supabase
      .from('user_roles')
      .update({ is_active: !isCurrentlyActive })
      .eq('id', userRoleId)
    void queryClient.invalidateQueries({ queryKey: ['admin-users'] })
  }

  return (
    <>
      {/* Header */}
      <PageHeader title="Users" subtitle={`${total} user roles`}>
        {canManageUsers && (
          <button
            type="button"
            onClick={openAddDialog}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#293F52] px-4 py-2 text-body-sm font-semibold text-white"
          >
            + Add User
          </button>
        )}
      </PageHeader>

      {/* Filters */}
      <FilterBar>
        <SearchInput
          value={search}
          onChange={handleSearchChange}
          placeholder="Search email, name..."
          ariaLabel="Search users"
        />

        <FilterSelect
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value); setPage(0) }}
          aria-label="Filter by role"
        >
          <option value="">All Roles</option>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>{getStatusStyle('role', r).label}</option>
          ))}
        </FilterSelect>

        <FilterSelect
          value={activeFilter}
          onChange={(e) => { setActiveFilter(e.target.value); setPage(0) }}
          aria-label="Filter by status"
        >
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </FilterSelect>
      </FilterBar>

      {/* Table */}
      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Organisation</Th>
                <Th>Sub-client</Th>
                <Th>Active</Th>
                <Th>Joined</Th>
                {canManageUsers && (
                  <Th />
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
                      <StatusBadge entity="role" status={ur.role} />
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
                      <td className="px-4 py-3 text-right">
                        <RowActionMenu
                          actions={[
                            { label: 'Edit user', onSelect: () => openEditDialog(ur) },
                            {
                              label: ur.is_active ? 'Revoke access' : 'Restore access',
                              onSelect: () => handleRevokeAccess(ur.id, ur.is_active),
                              tone: 'danger',
                            },
                          ]}
                        />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
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
