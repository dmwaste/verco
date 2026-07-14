export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      allocation_conversion_rule: {
        Row: {
          created_at: string
          from_allocation_rules_id: string
          from_units: number
          id: string
          is_active: boolean
          to_allocation_rules_id: string
          to_service_id: string
          to_units: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          from_allocation_rules_id: string
          from_units: number
          id?: string
          is_active?: boolean
          to_allocation_rules_id: string
          to_service_id: string
          to_units: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          from_allocation_rules_id?: string
          from_units?: number
          id?: string
          is_active?: boolean
          to_allocation_rules_id?: string
          to_service_id?: string
          to_units?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "allocation_conversion_rule_from_allocation_rules_id_fkey"
            columns: ["from_allocation_rules_id"]
            isOneToOne: false
            referencedRelation: "allocation_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_conversion_rule_to_allocation_rules_id_fkey"
            columns: ["to_allocation_rules_id"]
            isOneToOne: false
            referencedRelation: "allocation_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_conversion_rule_to_service_id_fkey"
            columns: ["to_service_id"]
            isOneToOne: false
            referencedRelation: "service"
            referencedColumns: ["id"]
          },
        ]
      }
      allocation_override: {
        Row: {
          created_at: string
          created_by: string
          extra_allocations: number
          fy_id: string
          id: string
          property_id: string
          reason: string
          service_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          extra_allocations: number
          fy_id: string
          id?: string
          property_id: string
          reason: string
          service_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          extra_allocations?: number
          fy_id?: string
          id?: string
          property_id?: string
          reason?: string
          service_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "allocation_override_fy_id_fkey"
            columns: ["fy_id"]
            isOneToOne: false
            referencedRelation: "financial_year"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_override_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "eligible_properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_override_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "v_mud_next_expected"
            referencedColumns: ["property_id"]
          },
          {
            foreignKeyName: "allocation_override_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "service"
            referencedColumns: ["id"]
          },
        ]
      }
      allocation_rules: {
        Row: {
          category_id: string
          collection_area_id: string
          created_at: string
          id: string
          max_collections: number
          updated_at: string
        }
        Insert: {
          category_id: string
          collection_area_id: string
          created_at?: string
          id?: string
          max_collections: number
          updated_at?: string
        }
        Update: {
          category_id?: string
          collection_area_id?: string
          created_at?: string
          id?: string
          max_collections?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "allocation_rules_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_rules_collection_area_id_fkey"
            columns: ["collection_area_id"]
            isOneToOne: false
            referencedRelation: "collection_area"
            referencedColumns: ["id"]
          },
        ]
      }
      allocation_swap: {
        Row: {
          allocation_conversion_rule_id: string
          booking_id: string
          collection_area_id: string
          created_at: string
          fy_id: string
          id: string
          property_id: string
        }
        Insert: {
          allocation_conversion_rule_id: string
          booking_id: string
          collection_area_id: string
          created_at?: string
          fy_id: string
          id?: string
          property_id: string
        }
        Update: {
          allocation_conversion_rule_id?: string
          booking_id?: string
          collection_area_id?: string
          created_at?: string
          fy_id?: string
          id?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "allocation_swap_allocation_conversion_rule_id_fkey"
            columns: ["allocation_conversion_rule_id"]
            isOneToOne: false
            referencedRelation: "allocation_conversion_rule"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_swap_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_swap_collection_area_id_fkey"
            columns: ["collection_area_id"]
            isOneToOne: false
            referencedRelation: "collection_area"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_swap_fy_id_fkey"
            columns: ["fy_id"]
            isOneToOne: false
            referencedRelation: "financial_year"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_swap_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "eligible_properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_swap_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "v_mud_next_expected"
            referencedColumns: ["property_id"]
          },
        ]
      }
      app_module: {
        Row: {
          app: string
          category: string
          icon: string | null
          id: string
          name: string
          route: string | null
          sort_order: number
        }
        Insert: {
          app: string
          category: string
          icon?: string | null
          id: string
          name: string
          route?: string | null
          sort_order?: number
        }
        Update: {
          app?: string
          category?: string
          icon?: string | null
          id?: string
          name?: string
          route?: string | null
          sort_order?: number
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          changed_by: string | null
          client_id: string | null
          contractor_id: string | null
          created_at: string
          id: string
          new_data: Json | null
          old_data: Json | null
          record_id: string
          table_name: string
        }
        Insert: {
          action: string
          changed_by?: string | null
          client_id?: string | null
          contractor_id?: string | null
          created_at?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          record_id: string
          table_name: string
        }
        Update: {
          action?: string
          changed_by?: string | null
          client_id?: string | null
          contractor_id?: string | null
          created_at?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor"
            referencedColumns: ["id"]
          },
        ]
      }
      booking: {
        Row: {
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          client_id: string
          collection_area_id: string
          contact_id: string | null
          contractor_id: string
          created_at: string
          created_by: string | null
          created_via: string
          crew_id: string | null
          deleted_at: string | null
          fy_id: string
          geo_address: string | null
          id: string
          id_volume: string | null
          id_waste_types: string[]
          latitude: number | null
          location: string | null
          longitude: number | null
          notes: string | null
          photos: string[]
          property_id: string | null
          ref: string
          status: Database["public"]["Enums"]["booking_status"]
          terms_accepted_at: string | null
          terms_accepted_by: string | null
          terms_accepted_channel: string | null
          terms_accepted_text: string | null
          terms_version: number | null
          type: Database["public"]["Enums"]["booking_type"]
          updated_at: string
        }
        Insert: {
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id: string
          collection_area_id: string
          contact_id?: string | null
          contractor_id: string
          created_at?: string
          created_by?: string | null
          created_via?: string
          crew_id?: string | null
          deleted_at?: string | null
          fy_id: string
          geo_address?: string | null
          id?: string
          id_volume?: string | null
          id_waste_types?: string[]
          latitude?: number | null
          location?: string | null
          longitude?: number | null
          notes?: string | null
          photos?: string[]
          property_id?: string | null
          ref: string
          status?: Database["public"]["Enums"]["booking_status"]
          terms_accepted_at?: string | null
          terms_accepted_by?: string | null
          terms_accepted_channel?: string | null
          terms_accepted_text?: string | null
          terms_version?: number | null
          type?: Database["public"]["Enums"]["booking_type"]
          updated_at?: string
        }
        Update: {
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id?: string
          collection_area_id?: string
          contact_id?: string | null
          contractor_id?: string
          created_at?: string
          created_by?: string | null
          created_via?: string
          crew_id?: string | null
          deleted_at?: string | null
          fy_id?: string
          geo_address?: string | null
          id?: string
          id_volume?: string | null
          id_waste_types?: string[]
          latitude?: number | null
          location?: string | null
          longitude?: number | null
          notes?: string | null
          photos?: string[]
          property_id?: string | null
          ref?: string
          status?: Database["public"]["Enums"]["booking_status"]
          terms_accepted_at?: string | null
          terms_accepted_by?: string | null
          terms_accepted_channel?: string | null
          terms_accepted_text?: string | null
          terms_version?: number | null
          type?: Database["public"]["Enums"]["booking_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_collection_area_id_fkey"
            columns: ["collection_area_id"]
            isOneToOne: false
            referencedRelation: "collection_area"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_fy_id_fkey"
            columns: ["fy_id"]
            isOneToOne: false
            referencedRelation: "financial_year"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "eligible_properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "v_mud_next_expected"
            referencedColumns: ["property_id"]
          },
        ]
      }
      booking_item: {
        Row: {
          actual_services: number | null
          booking_id: string
          collection_date_id: string
          created_at: string
          id: string
          is_extra: boolean
          no_services: number
          service_id: string
          unit_price_cents: number
          updated_at: string
        }
        Insert: {
          actual_services?: number | null
          booking_id: string
          collection_date_id: string
          created_at?: string
          id?: string
          is_extra?: boolean
          no_services?: number
          service_id: string
          unit_price_cents?: number
          updated_at?: string
        }
        Update: {
          actual_services?: number | null
          booking_id?: string
          collection_date_id?: string
          created_at?: string
          id?: string
          is_extra?: boolean
          no_services?: number
          service_id?: string
          unit_price_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_item_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_item_collection_date_id_fkey"
            columns: ["collection_date_id"]
            isOneToOne: false
            referencedRelation: "collection_date"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_item_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "service"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_payment: {
        Row: {
          amount_cents: number
          booking_id: string
          client_id: string
          contractor_id: string
          created_at: string
          currency: string
          id: string
          status: string
          stripe_charge_id: string | null
          stripe_payment_intent: string | null
          stripe_session_id: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          booking_id: string
          client_id: string
          contractor_id: string
          created_at?: string
          currency?: string
          id?: string
          status?: string
          stripe_charge_id?: string | null
          stripe_payment_intent?: string | null
          stripe_session_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          booking_id?: string
          client_id?: string
          contractor_id?: string
          created_at?: string
          currency?: string
          id?: string
          status?: string
          stripe_charge_id?: string | null
          stripe_payment_intent?: string | null
          stripe_session_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_payment_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_payment_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_payment_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_survey: {
        Row: {
          booking_id: string
          client_id: string
          created_at: string
          id: string
          responses: Json | null
          submitted_at: string | null
          token: string
        }
        Insert: {
          booking_id: string
          client_id: string
          created_at?: string
          id?: string
          responses?: Json | null
          submitted_at?: string | null
          token: string
        }
        Update: {
          booking_id?: string
          client_id?: string
          created_at?: string
          id?: string
          responses?: Json | null
          submitted_at?: string | null
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_survey_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_survey_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
        ]
      }
      bug_report: {
        Row: {
          assigned_to: string | null
          browser_info: string | null
          category: Database["public"]["Enums"]["bug_report_category"]
          client_id: string | null
          collection_area_id: string | null
          created_at: string
          description: string | null
          display_id: string
          github_issue_number: number | null
          github_issue_url: string | null
          id: string
          linear_issue_id: string | null
          linear_issue_url: string | null
          page_url: string | null
          priority: Database["public"]["Enums"]["bug_report_priority"]
          reporter_id: string
          resolution_notes: string | null
          resolved_at: string | null
          source_app: string
          status: Database["public"]["Enums"]["bug_report_status"]
          title: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          browser_info?: string | null
          category?: Database["public"]["Enums"]["bug_report_category"]
          client_id?: string | null
          collection_area_id?: string | null
          created_at?: string
          description?: string | null
          display_id?: string
          github_issue_number?: number | null
          github_issue_url?: string | null
          id?: string
          linear_issue_id?: string | null
          linear_issue_url?: string | null
          page_url?: string | null
          priority?: Database["public"]["Enums"]["bug_report_priority"]
          reporter_id: string
          resolution_notes?: string | null
          resolved_at?: string | null
          source_app: string
          status?: Database["public"]["Enums"]["bug_report_status"]
          title: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          browser_info?: string | null
          category?: Database["public"]["Enums"]["bug_report_category"]
          client_id?: string | null
          collection_area_id?: string | null
          created_at?: string
          description?: string | null
          display_id?: string
          github_issue_number?: number | null
          github_issue_url?: string | null
          id?: string
          linear_issue_id?: string | null
          linear_issue_url?: string | null
          page_url?: string | null
          priority?: Database["public"]["Enums"]["bug_report_priority"]
          reporter_id?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          source_app?: string
          status?: Database["public"]["Enums"]["bug_report_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bug_report_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bug_report_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bug_report_collection_area_id_fkey"
            columns: ["collection_area_id"]
            isOneToOne: false
            referencedRelation: "collection_area"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bug_report_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bug_report_attachment: {
        Row: {
          bug_report_id: string
          created_at: string
          file_name: string
          file_path: string
          file_size: number | null
          file_type: string | null
          id: string
          uploaded_by: string
        }
        Insert: {
          bug_report_id: string
          created_at?: string
          file_name: string
          file_path: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          uploaded_by: string
        }
        Update: {
          bug_report_id?: string
          created_at?: string
          file_name?: string
          file_path?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "bug_report_attachment_bug_report_id_fkey"
            columns: ["bug_report_id"]
            isOneToOne: false
            referencedRelation: "bug_report"
            referencedColumns: ["id"]
          },
        ]
      }
      bug_report_comment: {
        Row: {
          author_id: string
          bug_report_id: string
          comment: string
          created_at: string
          id: string
          is_internal: boolean
        }
        Insert: {
          author_id: string
          bug_report_id: string
          comment: string
          created_at?: string
          id?: string
          is_internal?: boolean
        }
        Update: {
          author_id?: string
          bug_report_id?: string
          comment?: string
          created_at?: string
          id?: string
          is_internal?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "bug_report_comment_bug_report_id_fkey"
            columns: ["bug_report_id"]
            isOneToOne: false
            referencedRelation: "bug_report"
            referencedColumns: ["id"]
          },
        ]
      }
      capacity_pool: {
        Row: {
          code: string
          contractor_id: string
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          code: string
          contractor_id: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          code?: string
          contractor_id?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "capacity_pool_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor"
            referencedColumns: ["id"]
          },
        ]
      }
      capacity_pool_schedule: {
        Row: {
          anc_capacity_limit: number
          bulk_capacity_limit: number
          capacity_pool_id: string
          created_at: string
          day_of_week: number
          id: string
          id_capacity_limit: number
          is_active: boolean
          updated_at: string
        }
        Insert: {
          anc_capacity_limit?: number
          bulk_capacity_limit?: number
          capacity_pool_id: string
          created_at?: string
          day_of_week: number
          id?: string
          id_capacity_limit?: number
          is_active?: boolean
          updated_at?: string
        }
        Update: {
          anc_capacity_limit?: number
          bulk_capacity_limit?: number
          capacity_pool_id?: string
          created_at?: string
          day_of_week?: number
          id?: string
          id_capacity_limit?: number
          is_active?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "capacity_pool_schedule_capacity_pool_id_fkey"
            columns: ["capacity_pool_id"]
            isOneToOne: false
            referencedRelation: "capacity_pool"
            referencedColumns: ["id"]
          },
        ]
      }
      category: {
        Row: {
          code: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      client: {
        Row: {
          accent_colour: string | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          contractor_id: string
          created_at: string
          custom_domain: string | null
          email_footer_html: string | null
          email_from_name: string | null
          faq_items: Json | null
          favicon_url: string | null
          hero_banner_url: string | null
          id: string
          is_active: boolean
          landing_headline: string | null
          landing_subheading: string | null
          logo_dark_url: string | null
          logo_light_url: string | null
          name: string
          place_out_hours_before: number
          primary_colour: string | null
          privacy_policy_url: string | null
          reply_to_email: string | null
          service_name: string | null
          show_powered_by: boolean
          slug: string
          sms_reminder_days_before: number | null
          sms_sender_id: string | null
          terms_markdown: string | null
          terms_version: number
          twilio_messaging_service_sid: string | null
          updated_at: string
        }
        Insert: {
          accent_colour?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          contractor_id: string
          created_at?: string
          custom_domain?: string | null
          email_footer_html?: string | null
          email_from_name?: string | null
          faq_items?: Json | null
          favicon_url?: string | null
          hero_banner_url?: string | null
          id?: string
          is_active?: boolean
          landing_headline?: string | null
          landing_subheading?: string | null
          logo_dark_url?: string | null
          logo_light_url?: string | null
          name: string
          place_out_hours_before?: number
          primary_colour?: string | null
          privacy_policy_url?: string | null
          reply_to_email?: string | null
          service_name?: string | null
          show_powered_by?: boolean
          slug: string
          sms_reminder_days_before?: number | null
          sms_sender_id?: string | null
          terms_markdown?: string | null
          terms_version?: number
          twilio_messaging_service_sid?: string | null
          updated_at?: string
        }
        Update: {
          accent_colour?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          contractor_id?: string
          created_at?: string
          custom_domain?: string | null
          email_footer_html?: string | null
          email_from_name?: string | null
          faq_items?: Json | null
          favicon_url?: string | null
          hero_banner_url?: string | null
          id?: string
          is_active?: boolean
          landing_headline?: string | null
          landing_subheading?: string | null
          logo_dark_url?: string | null
          logo_light_url?: string | null
          name?: string
          place_out_hours_before?: number
          primary_colour?: string | null
          privacy_policy_url?: string | null
          reply_to_email?: string | null
          service_name?: string | null
          show_powered_by?: boolean
          slug?: string
          sms_reminder_days_before?: number | null
          sms_sender_id?: string | null
          terms_markdown?: string | null
          terms_version?: number
          twilio_messaging_service_sid?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor"
            referencedColumns: ["id"]
          },
        ]
      }
      client_survey_config: {
        Row: {
          client_id: string
          created_at: string
          id: string
          is_active: boolean
          questions: Json
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          questions?: Json
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          questions?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_survey_config_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_area: {
        Row: {
          capacity_pool_id: string | null
          client_id: string
          code: string
          contractor_id: string
          created_at: string
          dm_job_code: string | null
          id: string
          is_active: boolean
          name: string
          sub_client_id: string | null
          updated_at: string
        }
        Insert: {
          capacity_pool_id?: string | null
          client_id: string
          code: string
          contractor_id: string
          created_at?: string
          dm_job_code?: string | null
          id?: string
          is_active?: boolean
          name: string
          sub_client_id?: string | null
          updated_at?: string
        }
        Update: {
          capacity_pool_id?: string | null
          client_id?: string
          code?: string
          contractor_id?: string
          created_at?: string
          dm_job_code?: string | null
          id?: string
          is_active?: boolean
          name?: string
          sub_client_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_area_capacity_pool_id_fkey"
            columns: ["capacity_pool_id"]
            isOneToOne: false
            referencedRelation: "capacity_pool"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_area_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_area_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_area_sub_client_id_fkey"
            columns: ["sub_client_id"]
            isOneToOne: false
            referencedRelation: "sub_client"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_date: {
        Row: {
          anc_capacity_limit: number
          anc_is_closed: boolean
          anc_units_booked: number
          bulk_capacity_limit: number
          bulk_is_closed: boolean
          bulk_units_booked: number
          collection_area_id: string
          created_at: string
          date: string
          for_mud: boolean
          id: string
          id_capacity_limit: number
          id_is_closed: boolean
          id_units_booked: number
          is_open: boolean
          locked_closed: boolean
          updated_at: string
        }
        Insert: {
          anc_capacity_limit?: number
          anc_is_closed?: boolean
          anc_units_booked?: number
          bulk_capacity_limit?: number
          bulk_is_closed?: boolean
          bulk_units_booked?: number
          collection_area_id: string
          created_at?: string
          date: string
          for_mud?: boolean
          id?: string
          id_capacity_limit?: number
          id_is_closed?: boolean
          id_units_booked?: number
          is_open?: boolean
          locked_closed?: boolean
          updated_at?: string
        }
        Update: {
          anc_capacity_limit?: number
          anc_is_closed?: boolean
          anc_units_booked?: number
          bulk_capacity_limit?: number
          bulk_is_closed?: boolean
          bulk_units_booked?: number
          collection_area_id?: string
          created_at?: string
          date?: string
          for_mud?: boolean
          id?: string
          id_capacity_limit?: number
          id_is_closed?: boolean
          id_units_booked?: number
          is_open?: boolean
          locked_closed?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_date_collection_area_id_fkey"
            columns: ["collection_area_id"]
            isOneToOne: false
            referencedRelation: "collection_area"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_date_pool: {
        Row: {
          anc_capacity_limit: number
          anc_is_closed: boolean
          anc_units_booked: number
          bulk_capacity_limit: number
          bulk_is_closed: boolean
          bulk_units_booked: number
          capacity_pool_id: string
          created_at: string
          date: string
          id: string
          id_capacity_limit: number
          id_is_closed: boolean
          id_units_booked: number
          locked_closed: boolean
          updated_at: string
        }
        Insert: {
          anc_capacity_limit?: number
          anc_is_closed?: boolean
          anc_units_booked?: number
          bulk_capacity_limit?: number
          bulk_is_closed?: boolean
          bulk_units_booked?: number
          capacity_pool_id: string
          created_at?: string
          date: string
          id?: string
          id_capacity_limit?: number
          id_is_closed?: boolean
          id_units_booked?: number
          locked_closed?: boolean
          updated_at?: string
        }
        Update: {
          anc_capacity_limit?: number
          anc_is_closed?: boolean
          anc_units_booked?: number
          bulk_capacity_limit?: number
          bulk_is_closed?: boolean
          bulk_units_booked?: number
          capacity_pool_id?: string
          created_at?: string
          date?: string
          id?: string
          id_capacity_limit?: number
          id_is_closed?: boolean
          id_units_booked?: number
          locked_closed?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_date_pool_capacity_pool_id_fkey"
            columns: ["capacity_pool_id"]
            isOneToOne: false
            referencedRelation: "capacity_pool"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_run_meta: {
        Row: {
          created_at: string
          date: string
          depot_labels: Json
          driver_name: string | null
          driver_serial: string
          finish_time: string | null
          id: string
          routes_pulled_at: string | null
          start_time: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          date: string
          depot_labels?: Json
          driver_name?: string | null
          driver_serial: string
          finish_time?: string | null
          id?: string
          routes_pulled_at?: string | null
          start_time?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          date?: string
          depot_labels?: Json
          driver_name?: string | null
          driver_serial?: string
          finish_time?: string | null
          id?: string
          routes_pulled_at?: string | null
          start_time?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      collection_schedule: {
        Row: {
          anc_capacity_limit: number
          bulk_capacity_limit: number
          collection_area_id: string
          created_at: string
          day_of_week: number
          id: string
          id_capacity_limit: number
          is_active: boolean
          updated_at: string
        }
        Insert: {
          anc_capacity_limit?: number
          bulk_capacity_limit?: number
          collection_area_id: string
          created_at?: string
          day_of_week: number
          id?: string
          id_capacity_limit?: number
          is_active?: boolean
          updated_at?: string
        }
        Update: {
          anc_capacity_limit?: number
          bulk_capacity_limit?: number
          collection_area_id?: string
          created_at?: string
          day_of_week?: number
          id?: string
          id_capacity_limit?: number
          is_active?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_schedule_collection_area_id_fkey"
            columns: ["collection_area_id"]
            isOneToOne: false
            referencedRelation: "collection_area"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_stop: {
        Row: {
          address: string | null
          booking_id: string
          cancelled_at: string | null
          client_id: string
          collection_date_id: string
          completed_at: string | null
          completed_by: string | null
          completion_synced_at: string | null
          created_at: string
          driver_name: string | null
          driver_notes: string | null
          driver_serial: string | null
          external_deleted_at: string | null
          external_order_ref: string | null
          id: string
          last_push_error: string | null
          latitude: number | null
          longitude: number | null
          pushed_at: string | null
          routes_pulled_at: string | null
          scheduled_at: string | null
          services_summary: Json
          status: Database["public"]["Enums"]["stop_status"]
          stop_sequence: number | null
          stream: Database["public"]["Enums"]["waste_stream"]
          updated_at: string
          waste_location: string | null
        }
        Insert: {
          address?: string | null
          booking_id: string
          cancelled_at?: string | null
          client_id: string
          collection_date_id: string
          completed_at?: string | null
          completed_by?: string | null
          completion_synced_at?: string | null
          created_at?: string
          driver_name?: string | null
          driver_notes?: string | null
          driver_serial?: string | null
          external_deleted_at?: string | null
          external_order_ref?: string | null
          id?: string
          last_push_error?: string | null
          latitude?: number | null
          longitude?: number | null
          pushed_at?: string | null
          routes_pulled_at?: string | null
          scheduled_at?: string | null
          services_summary?: Json
          status?: Database["public"]["Enums"]["stop_status"]
          stop_sequence?: number | null
          stream: Database["public"]["Enums"]["waste_stream"]
          updated_at?: string
          waste_location?: string | null
        }
        Update: {
          address?: string | null
          booking_id?: string
          cancelled_at?: string | null
          client_id?: string
          collection_date_id?: string
          completed_at?: string | null
          completed_by?: string | null
          completion_synced_at?: string | null
          created_at?: string
          driver_name?: string | null
          driver_notes?: string | null
          driver_serial?: string | null
          external_deleted_at?: string | null
          external_order_ref?: string | null
          id?: string
          last_push_error?: string | null
          latitude?: number | null
          longitude?: number | null
          pushed_at?: string | null
          routes_pulled_at?: string | null
          scheduled_at?: string | null
          services_summary?: Json
          status?: Database["public"]["Enums"]["stop_status"]
          stop_sequence?: number | null
          stream?: Database["public"]["Enums"]["waste_stream"]
          updated_at?: string
          waste_location?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "collection_stop_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_stop_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_stop_collection_date_id_fkey"
            columns: ["collection_date_id"]
            isOneToOne: false
            referencedRelation: "collection_date"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_stop_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          created_at: string
          email: string
          first_name: string
          full_name: string
          id: string
          last_name: string
          last_synced_by: string | null
          mobile_e164: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          first_name?: string
          full_name?: string
          id?: string
          last_name?: string
          last_synced_by?: string | null
          mobile_e164?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          first_name?: string
          full_name?: string
          id?: string
          last_name?: string
          last_synced_by?: string | null
          mobile_e164?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      contractor: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      eligible_properties: {
        Row: {
          address: string
          auth_form_url: string | null
          collection_area_id: string | null
          collection_cadence:
            | Database["public"]["Enums"]["collection_cadence"]
            | null
          created_at: string
          external_id: string | null
          external_source: string | null
          formatted_address: string | null
          google_place_id: string | null
          has_geocode: boolean
          id: string
          is_eligible: boolean
          is_mud: boolean
          latitude: number | null
          longitude: number | null
          mud_code: string | null
          mud_onboarding_status:
            | Database["public"]["Enums"]["mud_onboarding_status"]
            | null
          strata_contact_id: string | null
          unit_count: number
          updated_at: string
          waste_location_notes: string | null
        }
        Insert: {
          address: string
          auth_form_url?: string | null
          collection_area_id?: string | null
          collection_cadence?:
            | Database["public"]["Enums"]["collection_cadence"]
            | null
          created_at?: string
          external_id?: string | null
          external_source?: string | null
          formatted_address?: string | null
          google_place_id?: string | null
          has_geocode?: boolean
          id?: string
          is_eligible?: boolean
          is_mud?: boolean
          latitude?: number | null
          longitude?: number | null
          mud_code?: string | null
          mud_onboarding_status?:
            | Database["public"]["Enums"]["mud_onboarding_status"]
            | null
          strata_contact_id?: string | null
          unit_count?: number
          updated_at?: string
          waste_location_notes?: string | null
        }
        Update: {
          address?: string
          auth_form_url?: string | null
          collection_area_id?: string | null
          collection_cadence?:
            | Database["public"]["Enums"]["collection_cadence"]
            | null
          created_at?: string
          external_id?: string | null
          external_source?: string | null
          formatted_address?: string | null
          google_place_id?: string | null
          has_geocode?: boolean
          id?: string
          is_eligible?: boolean
          is_mud?: boolean
          latitude?: number | null
          longitude?: number | null
          mud_code?: string | null
          mud_onboarding_status?:
            | Database["public"]["Enums"]["mud_onboarding_status"]
            | null
          strata_contact_id?: string | null
          unit_count?: number
          updated_at?: string
          waste_location_notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "eligible_properties_collection_area_id_fkey"
            columns: ["collection_area_id"]
            isOneToOne: false
            referencedRelation: "collection_area"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eligible_properties_strata_contact_id_fkey"
            columns: ["strata_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_year: {
        Row: {
          created_at: string
          end_date: string
          id: string
          is_current: boolean
          label: string
          rollover_date: string
          start_date: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          end_date: string
          id?: string
          is_current?: boolean
          label: string
          rollover_date: string
          start_date: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          end_date?: string
          id?: string
          is_current?: boolean
          label?: string
          rollover_date?: string
          start_date?: string
          updated_at?: string
        }
        Relationships: []
      }
      hubspot_sync_state: {
        Row: {
          created_at: string
          cursor_id: string | null
          cursor_updated_at: string | null
          entity: string
          last_error: string | null
          last_rows_synced: number | null
          last_run_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          cursor_id?: string | null
          cursor_updated_at?: string | null
          entity: string
          last_error?: string | null
          last_rows_synced?: number | null
          last_run_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          cursor_id?: string | null
          cursor_updated_at?: string | null
          entity?: string
          last_error?: string | null
          last_rows_synced?: number | null
          last_run_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      non_conformance_notice: {
        Row: {
          booking_id: string
          client_id: string
          collection_stop_id: string | null
          contractor_fault: boolean
          created_at: string
          id: string
          notes: string | null
          photos: string[]
          reason: Database["public"]["Enums"]["ncn_reason"]
          reported_at: string
          reported_by: string | null
          rescheduled_booking_id: string | null
          rescheduled_date: string | null
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["ncn_status"]
          updated_at: string
        }
        Insert: {
          booking_id: string
          client_id: string
          collection_stop_id?: string | null
          contractor_fault?: boolean
          created_at?: string
          id?: string
          notes?: string | null
          photos?: string[]
          reason: Database["public"]["Enums"]["ncn_reason"]
          reported_at?: string
          reported_by?: string | null
          rescheduled_booking_id?: string | null
          rescheduled_date?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["ncn_status"]
          updated_at?: string
        }
        Update: {
          booking_id?: string
          client_id?: string
          collection_stop_id?: string | null
          contractor_fault?: boolean
          created_at?: string
          id?: string
          notes?: string | null
          photos?: string[]
          reason?: Database["public"]["Enums"]["ncn_reason"]
          reported_at?: string
          reported_by?: string | null
          rescheduled_booking_id?: string | null
          rescheduled_date?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["ncn_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "non_conformance_notice_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "non_conformance_notice_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "non_conformance_notice_collection_stop_id_fkey"
            columns: ["collection_stop_id"]
            isOneToOne: false
            referencedRelation: "collection_stop"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "non_conformance_notice_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "non_conformance_notice_rescheduled_booking_id_fkey"
            columns: ["rescheduled_booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "non_conformance_notice_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      nothing_presented: {
        Row: {
          booking_id: string
          client_id: string
          collection_stop_id: string | null
          contractor_fault: boolean
          created_at: string
          id: string
          notes: string | null
          photos: string[]
          reported_at: string
          reported_by: string | null
          rescheduled_booking_id: string | null
          rescheduled_date: string | null
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["np_status"]
          updated_at: string
        }
        Insert: {
          booking_id: string
          client_id: string
          collection_stop_id?: string | null
          contractor_fault?: boolean
          created_at?: string
          id?: string
          notes?: string | null
          photos?: string[]
          reported_at?: string
          reported_by?: string | null
          rescheduled_booking_id?: string | null
          rescheduled_date?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["np_status"]
          updated_at?: string
        }
        Update: {
          booking_id?: string
          client_id?: string
          collection_stop_id?: string | null
          contractor_fault?: boolean
          created_at?: string
          id?: string
          notes?: string | null
          photos?: string[]
          reported_at?: string
          reported_by?: string | null
          rescheduled_booking_id?: string | null
          rescheduled_date?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["np_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "nothing_presented_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nothing_presented_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nothing_presented_collection_stop_id_fkey"
            columns: ["collection_stop_id"]
            isOneToOne: false
            referencedRelation: "collection_stop"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nothing_presented_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nothing_presented_rescheduled_booking_id_fkey"
            columns: ["rescheduled_booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nothing_presented_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_log: {
        Row: {
          booking_id: string | null
          channel: string
          client_id: string
          contact_id: string | null
          created_at: string
          delivery_detail: string | null
          delivery_status: string | null
          delivery_updated_at: string | null
          error_message: string | null
          id: string
          notification_type: string
          reference_id: string | null
          status: string
          to_address: string
        }
        Insert: {
          booking_id?: string | null
          channel: string
          client_id: string
          contact_id?: string | null
          created_at?: string
          delivery_detail?: string | null
          delivery_status?: string | null
          delivery_updated_at?: string | null
          error_message?: string | null
          id?: string
          notification_type: string
          reference_id?: string | null
          status?: string
          to_address: string
        }
        Update: {
          booking_id?: string | null
          channel?: string
          client_id?: string
          contact_id?: string | null
          created_at?: string
          delivery_detail?: string | null
          delivery_status?: string | null
          delivery_updated_at?: string | null
          error_message?: string | null
          id?: string
          notification_type?: string
          reference_id?: string | null
          status?: string
          to_address?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_log_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_log_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_log_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          contact_id: string | null
          created_at: string
          display_name: string | null
          email: string
          id: string
          updated_at: string
        }
        Insert: {
          contact_id?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          updated_at?: string
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      public_holiday: {
        Row: {
          created_at: string
          date: string
          id: string
          jurisdiction: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          date: string
          id?: string
          jurisdiction?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          date?: string
          id?: string
          jurisdiction?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      refund_request: {
        Row: {
          amount_cents: number
          booking_id: string
          client_id: string
          contact_id: string
          created_at: string
          id: string
          reason: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          stripe_refund_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          booking_id: string
          client_id: string
          contact_id: string
          created_at?: string
          id?: string
          reason?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          stripe_refund_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          booking_id?: string
          client_id?: string
          contact_id?: string
          created_at?: string
          id?: string
          reason?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          stripe_refund_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "refund_request_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_request_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_request_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refund_request_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          action: Database["public"]["Enums"]["app_permission_action"]
          created_at: string
          id: string
          module_id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
        }
        Insert: {
          action: Database["public"]["Enums"]["app_permission_action"]
          created_at?: string
          id?: string
          module_id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at?: string
        }
        Update: {
          action?: Database["public"]["Enums"]["app_permission_action"]
          created_at?: string
          id?: string
          module_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "app_module"
            referencedColumns: ["id"]
          },
        ]
      }
      service: {
        Row: {
          category_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
          waste_stream: Database["public"]["Enums"]["waste_stream"]
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
          waste_stream: Database["public"]["Enums"]["waste_stream"]
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
          waste_stream?: Database["public"]["Enums"]["waste_stream"]
        }
        Relationships: [
          {
            foreignKeyName: "service_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["id"]
          },
        ]
      }
      service_rules: {
        Row: {
          collection_area_id: string
          created_at: string
          extra_unit_price: number
          id: string
          max_collections: number
          service_id: string
          updated_at: string
        }
        Insert: {
          collection_area_id: string
          created_at?: string
          extra_unit_price?: number
          id?: string
          max_collections: number
          service_id: string
          updated_at?: string
        }
        Update: {
          collection_area_id?: string
          created_at?: string
          extra_unit_price?: number
          id?: string
          max_collections?: number
          service_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_rules_collection_area_id_fkey"
            columns: ["collection_area_id"]
            isOneToOne: false
            referencedRelation: "collection_area"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_rules_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "service"
            referencedColumns: ["id"]
          },
        ]
      }
      service_ticket: {
        Row: {
          assigned_to: string | null
          booking_id: string | null
          category: Database["public"]["Enums"]["ticket_category"]
          channel: Database["public"]["Enums"]["ticket_channel"]
          client_id: string
          closed_at: string | null
          contact_id: string
          created_at: string
          display_id: string
          first_response_at: string | null
          id: string
          message: string
          priority: Database["public"]["Enums"]["ticket_priority"]
          resolved_at: string | null
          status: Database["public"]["Enums"]["ticket_status"]
          subject: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          booking_id?: string | null
          category?: Database["public"]["Enums"]["ticket_category"]
          channel?: Database["public"]["Enums"]["ticket_channel"]
          client_id: string
          closed_at?: string | null
          contact_id: string
          created_at?: string
          display_id: string
          first_response_at?: string | null
          id?: string
          message: string
          priority?: Database["public"]["Enums"]["ticket_priority"]
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["ticket_status"]
          subject: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          booking_id?: string | null
          category?: Database["public"]["Enums"]["ticket_category"]
          channel?: Database["public"]["Enums"]["ticket_channel"]
          client_id?: string
          closed_at?: string | null
          contact_id?: string
          created_at?: string
          display_id?: string
          first_response_at?: string | null
          id?: string
          message?: string
          priority?: Database["public"]["Enums"]["ticket_priority"]
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["ticket_status"]
          subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_ticket_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_ticket_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "booking"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_ticket_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_ticket_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      sla_config: {
        Row: {
          client_id: string
          created_at: string
          first_response_hours: number
          id: string
          is_active: boolean
          priority: Database["public"]["Enums"]["ticket_priority"]
          resolution_hours: number
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          first_response_hours?: number
          id?: string
          is_active?: boolean
          priority: Database["public"]["Enums"]["ticket_priority"]
          resolution_hours?: number
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          first_response_hours?: number
          id?: string
          is_active?: boolean
          priority?: Database["public"]["Enums"]["ticket_priority"]
          resolution_hours?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sla_config_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
        ]
      }
      strata_user_properties: {
        Row: {
          created_at: string
          id: string
          property_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          property_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          property_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "strata_user_properties_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "eligible_properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "strata_user_properties_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "v_mud_next_expected"
            referencedColumns: ["property_id"]
          },
          {
            foreignKeyName: "strata_user_properties_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sub_client: {
        Row: {
          client_id: string
          code: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          client_id: string
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sub_client_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_log: {
        Row: {
          created_at: string
          direction: string
          entity_id: string
          entity_type: string
          error_message: string | null
          id: string
          payload: Json | null
          status: string
        }
        Insert: {
          created_at?: string
          direction: string
          entity_id: string
          entity_type: string
          error_message?: string | null
          id?: string
          payload?: Json | null
          status?: string
        }
        Update: {
          created_at?: string
          direction?: string
          entity_id?: string
          entity_type?: string
          error_message?: string | null
          id?: string
          payload?: Json | null
          status?: string
        }
        Relationships: []
      }
      ticket_response: {
        Row: {
          author_id: string
          author_type: string
          channel: string
          created_at: string
          id: string
          is_internal: boolean
          message: string
          ticket_id: string
          updated_at: string
        }
        Insert: {
          author_id: string
          author_type: string
          channel?: string
          created_at?: string
          id?: string
          is_internal?: boolean
          message: string
          ticket_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          author_type?: string
          channel?: string
          created_at?: string
          id?: string
          is_internal?: boolean
          message?: string
          ticket_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_response_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_response_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "service_ticket"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          client_id: string | null
          contractor_id: string | null
          created_at: string
          id: string
          is_active: boolean
          role: Database["public"]["Enums"]["app_role"]
          sub_client_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          client_id?: string | null
          contractor_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          role: Database["public"]["Enums"]["app_role"]
          sub_client_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          client_id?: string | null
          contractor_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          role?: Database["public"]["Enums"]["app_role"]
          sub_client_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_sub_client_fk"
            columns: ["sub_client_id", "client_id"]
            isOneToOne: false
            referencedRelation: "sub_client"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "user_roles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_mud_next_expected: {
        Row: {
          collection_cadence:
            | Database["public"]["Enums"]["collection_cadence"]
            | null
          last_date: string | null
          next_expected_date: string | null
          property_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      accessible_client_ids: { Args: never; Returns: string[] }
      assignable_ticket_staff: {
        Args: { p_ticket_id: string }
        Returns: {
          name: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }[]
      }
      bulk_update_booking_item_actuals: {
        Args: { p_booking_id: string; p_updates: Json }
        Returns: undefined
      }
      client_has_terms: { Args: { p_client_id: string }; Returns: boolean }
      close_imminent_collection_dates: { Args: never; Returns: Json }
      collection_area_is_active: {
        Args: { p_area_id: string }
        Returns: boolean
      }
      create_booking_with_capacity_check: {
        Args: {
          p_actor_id?: string
          p_area_code: string
          p_client_id: string
          p_collection_area_id: string
          p_collection_date_id: string
          p_contact_id: string
          p_contractor_id: string
          p_created_via?: string
          p_fy_id: string
          p_items: Json
          p_location: string
          p_notes: string
          p_property_id: string
          p_status: string
          p_terms_accepted?: boolean
          p_terms_channel?: string
          p_type?: string
        }
        Returns: Json
      }
      create_id_booking_with_capacity_check: {
        Args: {
          p_collection_area_id: string
          p_collection_date_id: string
          p_geo_address: string
          p_latitude: number
          p_longitude: number
          p_notes: string
          p_photos: string[]
          p_volume: string
          p_waste_types: string[]
        }
        Returns: Json
      }
      create_mud_booking_with_capacity_check: {
        Args: {
          p_collection_date_id: string
          p_items: Json
          p_notes?: string
          p_property_id: string
          p_terms_accepted?: boolean
        }
        Returns: Json
      }
      current_user_client_allows_property: {
        Args: { p_property_id: string }
        Returns: boolean
      }
      current_user_client_id: { Args: never; Returns: string }
      current_user_contact_id: { Args: never; Returns: string }
      current_user_contact_id_by_email: { Args: never; Returns: string }
      current_user_contractor_id: { Args: never; Returns: string }
      current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      current_user_sub_client_id: { Args: never; Returns: string }
      generate_booking_ref: { Args: { p_area_code: string }; Returns: string }
      get_collections_trend: {
        Args: {
          p_area_id?: string
          p_client_id: string
          p_from?: string
          p_to?: string
        }
        Returns: {
          collections: number
          month: string
        }[]
      }
      get_notices_monthly: {
        Args: {
          p_area_id?: string
          p_client_id: string
          p_from?: string
          p_to?: string
        }
        Returns: {
          month: string
          ncn_contractor: number
          ncn_other: number
          np_contractor: number
          np_other: number
        }[]
      }
      get_on_time_monthly: {
        Args: {
          p_area_id?: string
          p_client_id: string
          p_from?: string
          p_to?: string
        }
        Returns: {
          completed: number
          month: string
          on_time: number
        }[]
      }
      get_property_allocation_overrides: {
        Args: { p_fy_id?: string; p_property_id: string }
        Returns: {
          extra_allocations: number
          service_id: string
        }[]
      }
      get_property_fy_usage: {
        Args: {
          p_exclude_booking_id?: string
          p_fy_id?: string
          p_property_id: string
        }
        Returns: {
          units: number
          usage_key: string
          usage_kind: string
        }[]
      }
      get_property_penetration: {
        Args: {
          p_area_id?: string
          p_client_id: string
          p_from?: string
          p_to?: string
        }
        Returns: {
          booked: number
          eligible: number
        }[]
      }
      get_rect_sla: {
        Args: {
          p_area_id?: string
          p_client_id: string
          p_from?: string
          p_to?: string
        }
        Returns: {
          denominator: number
          numerator: number
          pct: number
        }[]
      }
      get_reports_monthly: {
        Args: {
          p_area_id?: string
          p_client_id: string
          p_from?: string
          p_to?: string
        }
        Returns: {
          month: string
          series: string
          value: number
        }[]
      }
      get_survey_by_token: { Args: { p_token: string }; Returns: Json }
      has_role: {
        Args: { check_role: Database["public"]["Enums"]["app_role"] }
        Returns: boolean
      }
      is_client_staff: { Args: never; Returns: boolean }
      is_contractor_user: { Args: never; Returns: boolean }
      is_field_user: { Args: never; Returns: boolean }
      is_staff_role: { Args: never; Returns: boolean }
      resolve_actor_names: {
        Args: { p_user_ids: string[] }
        Returns: {
          name: string
          user_id: string
        }[]
      }
      resolve_booking_redirect: {
        Args: { p_ref: string }
        Returns: {
          custom_domain: string
          is_active: boolean
        }[]
      }
      retry_notification_log: { Args: { log_id: string }; Returns: string }
      submit_survey_by_token: {
        Args: { p_responses: Json; p_token: string }
        Returns: Json
      }
      update_booking_items_in_place: {
        Args: {
          p_actor_id?: string
          p_booking_id: string
          p_collection_date_id: string
          p_expected_items?: Json
          p_items: Json
          p_location?: string
          p_notes?: string
        }
        Returns: Json
      }
      upsert_strata_contact_and_link: {
        Args: {
          p_email: string
          p_first_name: string
          p_last_name: string
          p_mobile_e164: string
          p_property_id: string
        }
        Returns: Json
      }
      user_sub_client_allows_area: {
        Args: { area_id: string }
        Returns: boolean
      }
      user_sub_client_allows_booking: {
        Args: { booking_id_in: string }
        Returns: boolean
      }
    }
    Enums: {
      app_permission_action: "view" | "create" | "edit" | "delete" | "manage"
      app_role:
        | "contractor-admin"
        | "contractor-staff"
        | "field"
        | "client-admin"
        | "client-staff"
        | "ranger"
        | "resident"
        | "strata"
      booking_status:
        | "Pending Payment"
        | "Submitted"
        | "Confirmed"
        | "Scheduled"
        | "Completed"
        | "Cancelled"
        | "Non-conformance"
        | "Nothing Presented"
        | "Rebooked"
        | "Missed Collection"
      booking_type:
        | "Residential"
        | "MUD"
        | "Illegal Dumping"
        | "Call Back - DM"
        | "Call Back - Client"
      bug_report_category:
        | "ui"
        | "data"
        | "performance"
        | "access"
        | "booking"
        | "collection"
        | "billing"
        | "other"
      bug_report_priority: "low" | "medium" | "high" | "critical"
      bug_report_status:
        | "new"
        | "triaged"
        | "in_progress"
        | "resolved"
        | "closed"
        | "wont_fix"
      capacity_bucket: "bulk" | "anc" | "id"
      collection_cadence: "Ad-hoc" | "Annual" | "Bi-annual" | "Quarterly"
      mud_onboarding_status: "Contact Made" | "Registered" | "Inactive"
      ncn_reason:
        | "Collection Limit Exceeded"
        | "Items Obstructed or Not On Verge"
        | "Building Waste"
        | "Car Parts"
        | "Asbestos / Fibre Fence"
        | "Food or Domestic Waste"
        | "Glass"
        | "Medical Waste"
        | "Tyres"
        | "Greens in Container"
        | "Hazardous Waste"
        | "Items Oversize"
        | "Other"
      ncn_status:
        | "Open"
        | "Under Review"
        | "Resolved"
        | "Rescheduled"
        | "Issued"
        | "Disputed"
        | "Closed"
      np_status:
        | "Open"
        | "Under Review"
        | "Resolved"
        | "Rebooked"
        | "Issued"
        | "Disputed"
        | "Closed"
      stop_status:
        | "Pending"
        | "Completed"
        | "Non-conformance"
        | "Nothing Presented"
        | "Cancelled"
      ticket_category:
        | "general"
        | "booking"
        | "billing"
        | "service"
        | "complaint"
        | "other"
      ticket_channel: "portal" | "phone" | "email" | "form"
      ticket_priority: "low" | "normal" | "high" | "urgent"
      ticket_status:
        | "open"
        | "in_progress"
        | "waiting_on_customer"
        | "resolved"
        | "closed"
      waste_stream: "general" | "green" | "ancillary" | "illegal_dumping"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_permission_action: ["view", "create", "edit", "delete", "manage"],
      app_role: [
        "contractor-admin",
        "contractor-staff",
        "field",
        "client-admin",
        "client-staff",
        "ranger",
        "resident",
        "strata",
      ],
      booking_status: [
        "Pending Payment",
        "Submitted",
        "Confirmed",
        "Scheduled",
        "Completed",
        "Cancelled",
        "Non-conformance",
        "Nothing Presented",
        "Rebooked",
        "Missed Collection",
      ],
      booking_type: [
        "Residential",
        "MUD",
        "Illegal Dumping",
        "Call Back - DM",
        "Call Back - Client",
      ],
      bug_report_category: [
        "ui",
        "data",
        "performance",
        "access",
        "booking",
        "collection",
        "billing",
        "other",
      ],
      bug_report_priority: ["low", "medium", "high", "critical"],
      bug_report_status: [
        "new",
        "triaged",
        "in_progress",
        "resolved",
        "closed",
        "wont_fix",
      ],
      capacity_bucket: ["bulk", "anc", "id"],
      collection_cadence: ["Ad-hoc", "Annual", "Bi-annual", "Quarterly"],
      mud_onboarding_status: ["Contact Made", "Registered", "Inactive"],
      ncn_reason: [
        "Collection Limit Exceeded",
        "Items Obstructed or Not On Verge",
        "Building Waste",
        "Car Parts",
        "Asbestos / Fibre Fence",
        "Food or Domestic Waste",
        "Glass",
        "Medical Waste",
        "Tyres",
        "Greens in Container",
        "Hazardous Waste",
        "Items Oversize",
        "Other",
      ],
      ncn_status: [
        "Open",
        "Under Review",
        "Resolved",
        "Rescheduled",
        "Issued",
        "Disputed",
        "Closed",
      ],
      np_status: [
        "Open",
        "Under Review",
        "Resolved",
        "Rebooked",
        "Issued",
        "Disputed",
        "Closed",
      ],
      stop_status: [
        "Pending",
        "Completed",
        "Non-conformance",
        "Nothing Presented",
        "Cancelled",
      ],
      ticket_category: [
        "general",
        "booking",
        "billing",
        "service",
        "complaint",
        "other",
      ],
      ticket_channel: ["portal", "phone", "email", "form"],
      ticket_priority: ["low", "normal", "high", "urgent"],
      ticket_status: [
        "open",
        "in_progress",
        "waiting_on_customer",
        "resolved",
        "closed",
      ],
      waste_stream: ["general", "green", "ancillary", "illegal_dumping"],
    },
  },
} as const
