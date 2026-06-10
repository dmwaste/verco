/**
 * Human-readable labels for database column names, used by the audit trail resolver.
 */

/** Columns to exclude from the audit diff display (noise fields). */
export const NOISE_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'client_id',
  'contractor_id',
  'fy_id',
  'attio_person_id',
  'attio_person_web_url',
  'attio_record_id',
  'last_synced_by',
  'google_place_id',
  'has_geocode',
  'address', // raw address — formatted_address is the human-readable version
  // collection_stop sync metadata — machine stamps, not operator actions
  'pushed_at',
  'routes_pulled_at',
  'external_deleted_at',
])

/** Map of column name → human-readable label. */
export const FIELD_LABELS: Record<string, string> = {
  // Booking
  status: 'Status',
  ref: 'Reference',
  type: 'Type',
  location: 'Location',
  notes: 'Notes',
  property_id: 'Property',
  collection_area_id: 'Collection Area',
  contact_id: 'Contact',
  cancelled_at: 'Cancelled At',
  cancelled_by: 'Cancelled By',
  cancellation_reason: 'Cancellation Reason',
  deleted_at: 'Deleted At',
  geo_address: 'Location (GPS)',
  photos: 'Photos',
  id_waste_types: 'Waste Types',
  id_volume: 'Estimated Volume',

  // Booking item
  booking_id: 'Booking',
  service_id: 'Service',
  service_type_id: 'Service',
  collection_date_id: 'Collection Date',
  no_services: 'Quantity',
  actual_services: 'Actual Quantity',
  unit_price_cents: 'Unit Price',
  is_extra: 'Extra Item',

  // Contact
  full_name: 'Name', // generated column — kept for legacy audit_log entries
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  mobile_e164: 'Mobile',

  // NCN / NP
  reason: 'Reason',
  resolution_notes: 'Resolution Notes',
  contractor_fault: 'Contractor Fault',
  reported_at: 'Reported At',
  reported_by: 'Reported By',
  resolved_at: 'Resolved At',
  resolved_by: 'Resolved By',
  rescheduled_booking_id: 'Rescheduled Booking',
  rescheduled_date: 'Rescheduled Date',

  // Service ticket
  subject: 'Subject',
  description: 'Description',
  priority: 'Priority',
  category: 'Category',
  channel: 'Channel',
  assigned_to: 'Assigned To',
  first_response_at: 'First Response At',
  closed_at: 'Closed At',
  display_id: 'Ticket ID',

  // Ticket response
  ticket_id: 'Ticket',
  author_id: 'Author',
  author_type: 'Author Type',
  message: 'Message',
  is_internal: 'Internal Note',

  // Collection date
  date: 'Date',
  is_open: 'Open for Bookings',
  max_capacity: 'Max Capacity',

  // Eligible properties
  address: 'Address',
  formatted_address: 'Formatted Address',
  latitude: 'Latitude',
  longitude: 'Longitude',
  is_mud: 'Multi-Unit Dwelling',

  // Strata user properties
  user_id: 'User',

  // Client (white-label config)
  name: 'Name',
  slug: 'Slug',
  custom_domain: 'Custom Domain',
  is_active: 'Active',
  logo_light_url: 'Logo (Light)',
  logo_dark_url: 'Logo (Dark)',
  primary_colour: 'Primary Colour',
  accent_colour: 'Accent Colour',
  service_name: 'Service Name',
  hero_banner_url: 'Hero Banner',
  show_powered_by: 'Show "Powered By"',
  landing_headline: 'Landing Headline',
  landing_subheading: 'Landing Subheading',
  contact_name: 'Contact Name',
  contact_phone: 'Contact Phone',
  contact_email: 'Contact Email',
  privacy_policy_url: 'Privacy Policy URL',
  email_footer_html: 'Email Footer HTML',
  faq_items: 'FAQ Items',
  sms_sender_id: 'SMS Sender ID',
  reply_to_email: 'Reply-To Email',
  email_from_name: 'Email From Name',
  sms_reminder_days_before: 'SMS Reminder Days Before',

  // Collection area
  code: 'Code',
  dm_job_code: 'DM-Ops Job Code',
  sub_client_id: 'Sub-Client',

  // Collection stop (field-crew stop model)
  stream: 'Waste Stream',
  services_summary: 'Services',
  external_order_ref: 'Routing Order Ref',
  pushed_at: 'Pushed to Routing At',
  last_push_error: 'Last Push Error',
  external_deleted_at: 'Routing Order Deleted At',
  driver_serial: 'Crew (Driver Serial)',
  driver_name: 'Crew Name',
  stop_sequence: 'Collection Number',
  scheduled_at: 'Planned Arrival',
  routes_pulled_at: 'Routes Pulled At',
  completed_at: 'Completed At',
  completed_by: 'Completed By',
  collection_stop_id: 'Collection Stop',
  waste_stream: 'Waste Stream',

  // Allocation rules / service rules
  category_id: 'Category',
  max_collections: 'Max Collections',
  extra_unit_price: 'Extra Unit Price',

  // Allocation override
  extra_allocations: 'Extra Allocations',
  created_by: 'Created By',

  // Refund request
  amount_cents: 'Amount',
  stripe_refund_id: 'Stripe Refund ID',
  reviewed_by: 'Reviewed By',
  reviewed_at: 'Reviewed At',
}

/**
 * FK columns that should be resolved to display names from referenced tables.
 * Maps column name → { table, column } to look up.
 */
export const FK_RESOLVE_MAP: Record<string, { table: string; column: string }> = {
  service_id: { table: 'service', column: 'name' },
  service_type_id: { table: 'service', column: 'name' },
  collection_area_id: { table: 'collection_area', column: 'name' },
  contact_id: { table: 'contacts', column: 'full_name' },
  property_id: { table: 'eligible_properties', column: 'formatted_address' },
  collection_date_id: { table: 'collection_date', column: 'date' },
  booking_id: { table: 'booking', column: 'ref' },
  rescheduled_booking_id: { table: 'booking', column: 'ref' },
  ticket_id: { table: 'service_ticket', column: 'display_id' },
  assigned_to: { table: 'profiles', column: 'display_name' },
  reported_by: { table: 'profiles', column: 'display_name' },
  resolved_by: { table: 'profiles', column: 'display_name' },
  cancelled_by: { table: 'profiles', column: 'display_name' },
  author_id: { table: 'profiles', column: 'display_name' },
  user_id: { table: 'profiles', column: 'display_name' },
  created_by: { table: 'profiles', column: 'display_name' },
  reviewed_by: { table: 'profiles', column: 'display_name' },
  category_id: { table: 'category', column: 'name' },
  sub_client_id: { table: 'sub_client', column: 'name' },
}
