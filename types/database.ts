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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_usage: {
        Row: {
          created_at: string
          id: string
          provider: string | null
          tenant_id: string
          tokens: number
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          provider?: string | null
          tenant_id: string
          tokens?: number
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          provider?: string | null
          tenant_id?: string
          tokens?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          after_data: Json | null
          before_data: Json | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          ip_address: unknown
          reason: string | null
          tenant_id: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          ip_address?: unknown
          reason?: string | null
          tenant_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          ip_address?: unknown
          reason?: string | null
          tenant_id?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      billing_records: {
        Row: {
          amount: number
          created_at: string
          currency: string
          id: string
          medium: string
          notes: string | null
          period_end: string | null
          period_start: string | null
          receipt_ref: string | null
          recorded_by: string | null
          tenant_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          id?: string
          medium: string
          notes?: string | null
          period_end?: string | null
          period_start?: string | null
          receipt_ref?: string | null
          recorded_by?: string | null
          tenant_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          id?: string
          medium?: string
          notes?: string | null
          period_end?: string | null
          period_start?: string | null
          receipt_ref?: string | null
          recorded_by?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_records_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_records_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      brands: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          name: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name: string
          tenant_id?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "brands_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_movements: {
        Row: {
          amount: number
          cash_shift_id: string
          created_at: string
          created_by: string | null
          id: string
          payment_method: string | null
          reason: string | null
          reference_id: string | null
          tenant_id: string
          type: string
        }
        Insert: {
          amount: number
          cash_shift_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          payment_method?: string | null
          reason?: string | null
          reference_id?: string | null
          tenant_id?: string
          type: string
        }
        Update: {
          amount?: number
          cash_shift_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          payment_method?: string | null
          reason?: string | null
          reference_id?: string | null
          tenant_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_movements_cash_shift_id_fkey"
            columns: ["cash_shift_id"]
            isOneToOne: false
            referencedRelation: "cash_shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_movements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_movements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_registers: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          store_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          store_id: string
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          store_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_registers_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_registers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_shifts: {
        Row: {
          cash_register_id: string
          closed_at: string | null
          closed_by: string | null
          closing_amount: number | null
          created_at: string
          difference: number | null
          expected_amount: number | null
          id: string
          notes: string | null
          opened_at: string
          opened_by: string
          opening_amount: number
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          cash_register_id: string
          closed_at?: string | null
          closed_by?: string | null
          closing_amount?: number | null
          created_at?: string
          difference?: number | null
          expected_amount?: number | null
          id?: string
          notes?: string | null
          opened_at?: string
          opened_by?: string
          opening_amount: number
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          cash_register_id?: string
          closed_at?: string | null
          closed_by?: string | null
          closing_amount?: number | null
          created_at?: string
          difference?: number | null
          expected_amount?: number | null
          id?: string
          notes?: string | null
          opened_at?: string
          opened_by?: string
          opening_amount?: number
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_shifts_cash_register_id_fkey"
            columns: ["cash_register_id"]
            isOneToOne: false
            referencedRelation: "cash_registers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_shifts_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_shifts_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_shifts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_z_closures: {
        Row: {
          cash_in: number
          cash_out: number
          cash_shift_id: string
          closed_at: string
          closed_by: string | null
          closing_amount: number
          created_at: string
          difference: number
          discounts_total: number
          expected_amount: number
          id: string
          opened_at: string | null
          opened_by: string | null
          opening_amount: number
          payment_breakdown: Json
          sales_count: number
          sales_total: number
          store_id: string | null
          tenant_id: string
          voids_count: number
          voids_total: number
          z_number: number
        }
        Insert: {
          cash_in?: number
          cash_out?: number
          cash_shift_id: string
          closed_at?: string
          closed_by?: string | null
          closing_amount?: number
          created_at?: string
          difference?: number
          discounts_total?: number
          expected_amount?: number
          id?: string
          opened_at?: string | null
          opened_by?: string | null
          opening_amount?: number
          payment_breakdown?: Json
          sales_count?: number
          sales_total?: number
          store_id?: string | null
          tenant_id?: string
          voids_count?: number
          voids_total?: number
          z_number: number
        }
        Update: {
          cash_in?: number
          cash_out?: number
          cash_shift_id?: string
          closed_at?: string
          closed_by?: string | null
          closing_amount?: number
          created_at?: string
          difference?: number
          discounts_total?: number
          expected_amount?: number
          id?: string
          opened_at?: string | null
          opened_by?: string | null
          opening_amount?: number
          payment_breakdown?: Json
          sales_count?: number
          sales_total?: number
          store_id?: string | null
          tenant_id?: string
          voids_count?: number
          voids_total?: number
          z_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "cash_z_closures_cash_shift_id_fkey"
            columns: ["cash_shift_id"]
            isOneToOne: true
            referencedRelation: "cash_shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_z_closures_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_z_closures_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_z_closures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cashier_profiles: {
        Row: {
          avatar: string | null
          created_at: string
          deleted_at: string | null
          display_name: string
          id: string
          pin_hash: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          avatar?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name: string
          id?: string
          pin_hash?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          avatar?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string
          id?: string
          pin_hash?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cashier_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          is_active: boolean
          name: string
          parent_id: string | null
          sort_order: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          name: string
          parent_id?: string | null
          sort_order?: number
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          name?: string
          parent_id?: string | null
          sort_order?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "categories_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_account_movements: {
        Row: {
          created_at: string
          created_by: string | null
          customer_id: string
          delta: number
          due_date: string | null
          id: string
          reason: string | null
          sale_id: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          customer_id: string
          delta: number
          due_date?: string | null
          id?: string
          reason?: string | null
          sale_id?: string | null
          tenant_id?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          customer_id?: string
          delta?: number
          due_date?: string | null
          id?: string
          reason?: string | null
          sale_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_account_movements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_account_movements_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_account_movements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_groups: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          sort: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          sort?: number
          tenant_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          sort?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_groups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          birth_date: string | null
          created_at: string
          credit_limit: number
          deleted_at: string | null
          document_number: string | null
          document_type: string | null
          email: string | null
          group_id: string | null
          id: string
          is_active: boolean
          iva_condition: string | null
          metadata: Json
          name: string
          notes: string | null
          phone: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          birth_date?: string | null
          created_at?: string
          credit_limit?: number
          deleted_at?: string | null
          document_number?: string | null
          document_type?: string | null
          email?: string | null
          group_id?: string | null
          id?: string
          is_active?: boolean
          iva_condition?: string | null
          metadata?: Json
          name: string
          notes?: string | null
          phone?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          birth_date?: string | null
          created_at?: string
          credit_limit?: number
          deleted_at?: string | null
          document_number?: string | null
          document_type?: string | null
          email?: string | null
          group_id?: string | null
          id?: string
          is_active?: boolean
          iva_condition?: string | null
          metadata?: Json
          name?: string
          notes?: string | null
          phone?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "customer_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      dunning_events: {
        Row: {
          created_at: string
          id: string
          kind: string
          period_key: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          period_key: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          period_key?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dunning_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_templates: {
        Row: {
          enabled: boolean
          html: string
          key: string
          subject: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          enabled?: boolean
          html?: string
          key: string
          subject?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          html?: string
          key?: string
          subject?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          created_at: string
          default_enabled: boolean
          description: string | null
          id: string
          key: string
        }
        Insert: {
          created_at?: string
          default_enabled?: boolean
          description?: string | null
          id?: string
          key: string
        }
        Update: {
          created_at?: string
          default_enabled?: boolean
          description?: string | null
          id?: string
          key?: string
        }
        Relationships: []
      }
      features: {
        Row: {
          description: string | null
          grupo: string
          is_basic: boolean
          key: string
          label: string
          sort: number
        }
        Insert: {
          description?: string | null
          grupo?: string
          is_basic?: boolean
          key: string
          label: string
          sort?: number
        }
        Update: {
          description?: string | null
          grupo?: string
          is_basic?: boolean
          key?: string
          label?: string
          sort?: number
        }
        Relationships: []
      }
      invite_codes: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          is_active: boolean
          kind: string
          max_uses: number | null
          plan_key: string
          trial_days: number | null
          used_count: number
          valid_from: string | null
          valid_until: string | null
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          kind: string
          max_uses?: number | null
          plan_key: string
          trial_days?: number | null
          used_count?: number
          valid_from?: string | null
          valid_until?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          max_uses?: number | null
          plan_key?: string
          trial_days?: number | null
          used_count?: number
          valid_from?: string | null
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invite_codes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      mp_oauth_states: {
        Row: {
          created_at: string
          state: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          state: string
          tenant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          state?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mp_oauth_states_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      mp_payment_intents: {
        Row: {
          amount: number
          created_at: string
          id: string
          init_point: string | null
          mp_payment_id: string | null
          preference_id: string | null
          provider_key: string
          sale_id: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          init_point?: string | null
          mp_payment_id?: string | null
          preference_id?: string | null
          provider_key?: string
          sale_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          init_point?: string | null
          mp_payment_id?: string | null
          preference_id?: string | null
          provider_key?: string
          sale_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mp_payment_intents_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mp_payment_intents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_reads: {
        Row: {
          acked_at: string | null
          archived_at: string | null
          id: string
          notification_id: string
          read_at: string | null
          user_id: string
        }
        Insert: {
          acked_at?: string | null
          archived_at?: string | null
          id?: string
          notification_id: string
          read_at?: string | null
          user_id: string
        }
        Update: {
          acked_at?: string | null
          archived_at?: string | null
          id?: string
          notification_id?: string
          read_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_reads_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_reads_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          action_label: string | null
          action_url: string | null
          body: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          expires_at: string | null
          id: string
          requires_ack: boolean
          severity: string
          target_role: string | null
          target_tenant_id: string | null
          target_user_id: string | null
          title: string
          type: string
        }
        Insert: {
          action_label?: string | null
          action_url?: string | null
          body?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          expires_at?: string | null
          id?: string
          requires_ack?: boolean
          severity?: string
          target_role?: string | null
          target_tenant_id?: string | null
          target_user_id?: string | null
          title: string
          type?: string
        }
        Update: {
          action_label?: string | null
          action_url?: string | null
          body?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          expires_at?: string | null
          id?: string
          requires_ack?: boolean
          severity?: string
          target_role?: string | null
          target_tenant_id?: string | null
          target_user_id?: string | null
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_target_tenant_id_fkey"
            columns: ["target_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_plans: {
        Row: {
          base: string
          brand: string | null
          code: string | null
          created_at: string
          id: string
          installments: number
          is_active: boolean
          label: string
          provider_key: string | null
          sort: number
          surcharge_pct: number
          tenant_id: string
        }
        Insert: {
          base?: string
          brand?: string | null
          code?: string | null
          created_at?: string
          id?: string
          installments?: number
          is_active?: boolean
          label: string
          provider_key?: string | null
          sort?: number
          surcharge_pct?: number
          tenant_id?: string
        }
        Update: {
          base?: string
          brand?: string | null
          code?: string | null
          created_at?: string
          id?: string
          installments?: number
          is_active?: boolean
          label?: string
          provider_key?: string | null
          sort?: number
          surcharge_pct?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_plans_provider_key_fkey"
            columns: ["provider_key"]
            isOneToOne: false
            referencedRelation: "payment_providers"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "payment_plans_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_providers: {
        Row: {
          is_active: boolean
          key: string
          kind: string
          name: string
          sort: number
        }
        Insert: {
          is_active?: boolean
          key: string
          kind: string
          name: string
          sort?: number
        }
        Update: {
          is_active?: boolean
          key?: string
          kind?: string
          name?: string
          sort?: number
        }
        Relationships: []
      }
      payment_secrets: {
        Row: {
          provider_key: string
          secrets: Json
          tenant_id: string
          updated_at: string
        }
        Insert: {
          provider_key: string
          secrets?: Json
          tenant_id: string
          updated_at?: string
        }
        Update: {
          provider_key?: string
          secrets?: Json
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_secrets_provider_key_fkey"
            columns: ["provider_key"]
            isOneToOne: false
            referencedRelation: "payment_providers"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "payment_secrets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          id: string
          metadata: Json
          method: string
          reference: string | null
          sale_id: string
          tenant_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          metadata?: Json
          method: string
          reference?: string | null
          sale_id: string
          tenant_id?: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          metadata?: Json
          method?: string
          reference?: string | null
          sale_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_addons: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          key: string
          label: string
          monthly_price_ars: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key: string
          label: string
          monthly_price_ars?: number
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key?: string
          label?: string
          monthly_price_ars?: number
        }
        Relationships: []
      }
      plans: {
        Row: {
          base_plan_key: string | null
          created_at: string
          description: string | null
          icon: string | null
          id: string
          is_active: boolean
          key: string
          limits: Json
          monthly_price_ars: number
          name: string
          sort: number
          tenant_id: string | null
          trial_days: number
          yearly_price_ars: number | null
        }
        Insert: {
          base_plan_key?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          key: string
          limits?: Json
          monthly_price_ars: number
          name: string
          sort?: number
          tenant_id?: string | null
          trial_days?: number
          yearly_price_ars?: number | null
        }
        Update: {
          base_plan_key?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          key?: string
          limits?: Json
          monthly_price_ars?: number
          name?: string
          sort?: number
          tenant_id?: string | null
          trial_days?: number
          yearly_price_ars?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "plans_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_secrets: {
        Row: {
          key: string
          secrets: Json
          updated_at: string
        }
        Insert: {
          key: string
          secrets?: Json
          updated_at?: string
        }
        Update: {
          key?: string
          secrets?: Json
          updated_at?: string
        }
        Relationships: []
      }
      platform_settings: {
        Row: {
          grace_days: number
          id: boolean
          reminder_days: number
          updated_at: string
        }
        Insert: {
          grace_days?: number
          id?: boolean
          reminder_days?: number
          updated_at?: string
        }
        Update: {
          grace_days?: number
          id?: boolean
          reminder_days?: number
          updated_at?: string
        }
        Relationships: []
      }
      pos_settings: {
        Row: {
          account_due_days: number
          allow_negative_stock: boolean
          auto_email_receipt: boolean
          blind_close: boolean
          close_tolerance: number
          customer_required: Json
          max_discount: Json
          onboarding_dismissed: boolean
          require_close_reason: boolean
          require_customer: boolean
          rounding_multiple: number
          sale_pad: number
          sale_prefix: string
          scanner_beep: boolean
          scanner_dup_ms: number
          scanner_prefix: string
          scanner_suffix: string
          sku_auto: boolean
          sku_prefix: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_due_days?: number
          allow_negative_stock?: boolean
          auto_email_receipt?: boolean
          blind_close?: boolean
          close_tolerance?: number
          customer_required?: Json
          max_discount?: Json
          onboarding_dismissed?: boolean
          require_close_reason?: boolean
          require_customer?: boolean
          rounding_multiple?: number
          sale_pad?: number
          sale_prefix?: string
          scanner_beep?: boolean
          scanner_dup_ms?: number
          scanner_prefix?: string
          scanner_suffix?: string
          sku_auto?: boolean
          sku_prefix?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_due_days?: number
          allow_negative_stock?: boolean
          auto_email_receipt?: boolean
          blind_close?: boolean
          close_tolerance?: number
          customer_required?: Json
          max_discount?: Json
          onboarding_dismissed?: boolean
          require_close_reason?: boolean
          require_customer?: boolean
          rounding_multiple?: number
          sale_pad?: number
          sale_prefix?: string
          scanner_beep?: boolean
          scanner_dup_ms?: number
          scanner_prefix?: string
          scanner_suffix?: string
          sku_auto?: boolean
          sku_prefix?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      price_list_items: {
        Row: {
          created_at: string
          id: string
          price: number
          price_list_id: string
          product_id: string
          tenant_id: string
          updated_at: string
          variant_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          price: number
          price_list_id: string
          product_id: string
          tenant_id: string
          updated_at?: string
          variant_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          price?: number
          price_list_id?: string
          product_id?: string
          tenant_id?: string
          updated_at?: string
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "price_list_items_price_list_id_fkey"
            columns: ["price_list_id"]
            isOneToOne: false
            referencedRelation: "price_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_list_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_list_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_list_items_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      price_lists: {
        Row: {
          adjustment_pct: number | null
          channel: string
          created_at: string
          deleted_at: string | null
          id: string
          is_active: boolean
          name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          adjustment_pct?: number | null
          channel?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          adjustment_pct?: number | null
          channel?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_lists_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      product_images: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          is_primary: boolean
          path: string
          product_id: string
          sort: number
          tenant_id: string
          url: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_primary?: boolean
          path: string
          product_id: string
          sort?: number
          tenant_id: string
          url: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_primary?: boolean
          path?: string
          product_id?: string
          sort?: number
          tenant_id?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_images_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_images_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      product_kit_components: {
        Row: {
          component_product_id: string
          created_at: string
          id: string
          kit_product_id: string
          quantity: number
          tenant_id: string
        }
        Insert: {
          component_product_id: string
          created_at?: string
          id?: string
          kit_product_id: string
          quantity?: number
          tenant_id?: string
        }
        Update: {
          component_product_id?: string
          created_at?: string
          id?: string
          kit_product_id?: string
          quantity?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_kit_components_component_product_id_fkey"
            columns: ["component_product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_kit_components_kit_product_id_fkey"
            columns: ["kit_product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_kit_components_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      product_serials: {
        Row: {
          created_at: string
          id: string
          product_id: string
          sale_id: string | null
          serial: string
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          product_id: string
          sale_id?: string | null
          serial: string
          status?: string
          tenant_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          product_id?: string
          sale_id?: string | null
          serial?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_serials_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_serials_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_serials_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      product_variants: {
        Row: {
          barcode: string | null
          created_at: string
          deleted_at: string | null
          id: string
          option1: string
          option2: string | null
          price_override: number | null
          product_id: string
          sku: string | null
          stock: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          barcode?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          option1: string
          option2?: string | null
          price_override?: number | null
          product_id: string
          sku?: string | null
          stock?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          barcode?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          option1?: string
          option2?: string | null
          price_override?: number | null
          product_id?: string
          sku?: string | null
          stock?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_variants_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_variants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          allow_negative: boolean | null
          barcode: string | null
          brand_id: string | null
          category_id: string | null
          cost: number | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          has_variants: boolean
          id: string
          image_url: string | null
          is_active: boolean
          is_kit: boolean
          is_serialized: boolean
          metadata: Json
          name: string
          price: number
          season: string | null
          sku: string | null
          stock: number
          stock_min: number | null
          tags: string[]
          tax_rate: number
          tenant_id: string
          track_stock: boolean
          unit: string
          updated_at: string
          updated_by: string | null
          variant_axes: Json | null
          warranty_months: number
        }
        Insert: {
          allow_negative?: boolean | null
          barcode?: string | null
          brand_id?: string | null
          category_id?: string | null
          cost?: number | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          has_variants?: boolean
          id?: string
          image_url?: string | null
          is_active?: boolean
          is_kit?: boolean
          is_serialized?: boolean
          metadata?: Json
          name: string
          price: number
          season?: string | null
          sku?: string | null
          stock?: number
          stock_min?: number | null
          tags?: string[]
          tax_rate?: number
          tenant_id?: string
          track_stock?: boolean
          unit?: string
          updated_at?: string
          updated_by?: string | null
          variant_axes?: Json | null
          warranty_months?: number
        }
        Update: {
          allow_negative?: boolean | null
          barcode?: string | null
          brand_id?: string | null
          category_id?: string | null
          cost?: number | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          has_variants?: boolean
          id?: string
          image_url?: string | null
          is_active?: boolean
          is_kit?: boolean
          is_serialized?: boolean
          metadata?: Json
          name?: string
          price?: number
          season?: string | null
          sku?: string | null
          stock?: number
          stock_min?: number | null
          tags?: string[]
          tax_rate?: number
          tenant_id?: string
          track_stock?: boolean
          unit?: string
          updated_at?: string
          updated_by?: string | null
          variant_axes?: Json | null
          warranty_months?: number
        }
        Relationships: [
          {
            foreignKeyName: "products_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      return_reasons: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          label: string
          sort: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          sort?: number
          tenant_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          sort?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "return_reasons_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sale_items: {
        Row: {
          created_at: string
          discount: number
          id: string
          product_id: string | null
          product_name: string
          quantity: number
          returned_qty: number
          sale_id: string
          serial: string | null
          sku: string | null
          subtotal: number
          tenant_id: string
          unit_price: number
          variant_id: string | null
        }
        Insert: {
          created_at?: string
          discount?: number
          id?: string
          product_id?: string | null
          product_name: string
          quantity: number
          returned_qty?: number
          sale_id: string
          serial?: string | null
          sku?: string | null
          subtotal: number
          tenant_id?: string
          unit_price: number
          variant_id?: string | null
        }
        Update: {
          created_at?: string
          discount?: number
          id?: string
          product_id?: string | null
          product_name?: string
          quantity?: number
          returned_qty?: number
          sale_id?: string
          serial?: string | null
          sku?: string | null
          subtotal?: number
          tenant_id?: string
          unit_price?: number
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sale_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      sale_return_items: {
        Row: {
          id: string
          product_id: string | null
          quantity: number
          restock: string
          return_id: string
          sale_item_id: string
          subtotal: number
          unit_price: number
        }
        Insert: {
          id?: string
          product_id?: string | null
          quantity: number
          restock?: string
          return_id: string
          sale_item_id: string
          subtotal: number
          unit_price: number
        }
        Update: {
          id?: string
          product_id?: string | null
          quantity?: number
          restock?: string
          return_id?: string
          sale_item_id?: string
          subtotal?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "sale_return_items_return_id_fkey"
            columns: ["return_id"]
            isOneToOne: false
            referencedRelation: "sale_returns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_return_items_sale_item_id_fkey"
            columns: ["sale_item_id"]
            isOneToOne: false
            referencedRelation: "sale_items"
            referencedColumns: ["id"]
          },
        ]
      }
      sale_returns: {
        Row: {
          created_at: string
          created_by: string | null
          customer_id: string | null
          id: string
          number: number
          reason: string | null
          refund_method: string
          sale_id: string
          tenant_id: string
          total: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          number: number
          reason?: string | null
          refund_method: string
          sale_id: string
          tenant_id?: string
          total?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          number?: number
          reason?: string | null
          refund_method?: string
          sale_id?: string
          tenant_id?: string
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "sale_returns_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_returns_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_returns_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_returns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sales: {
        Row: {
          cash_shift_id: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          discount_total: number
          id: string
          notes: string | null
          number: number
          receipt_email_to: string | null
          receipt_emailed_at: string | null
          status: string
          store_id: string
          subtotal: number
          tax_total: number
          tenant_id: string
          total: number
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          cash_shift_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          discount_total?: number
          id?: string
          notes?: string | null
          number: number
          receipt_email_to?: string | null
          receipt_emailed_at?: string | null
          status?: string
          store_id: string
          subtotal: number
          tax_total?: number
          tenant_id?: string
          total: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          cash_shift_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          discount_total?: number
          id?: string
          notes?: string | null
          number?: number
          receipt_email_to?: string | null
          receipt_emailed_at?: string | null
          status?: string
          store_id?: string
          subtotal?: number
          tax_total?: number
          tenant_id?: string
          total?: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_cash_shift_id_fkey"
            columns: ["cash_shift_id"]
            isOneToOne: false
            referencedRelation: "cash_shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_movements: {
        Row: {
          created_at: string
          created_by: string | null
          delta: number
          id: string
          notes: string | null
          product_id: string
          reason: string
          reference_id: string | null
          store_id: string | null
          tenant_id: string
          variant_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          delta: number
          id?: string
          notes?: string | null
          product_id: string
          reason: string
          reference_id?: string | null
          store_id?: string | null
          tenant_id?: string
          variant_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          delta?: number
          id?: string
          notes?: string | null
          product_id?: string
          reason?: string
          reference_id?: string | null
          store_id?: string | null
          tenant_id?: string
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      store_credit_movements: {
        Row: {
          created_at: string
          created_by: string | null
          customer_id: string
          delta: number
          id: string
          reason: string | null
          sale_return_id: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          customer_id: string
          delta: number
          id?: string
          reason?: string | null
          sale_return_id?: string | null
          tenant_id?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          customer_id?: string
          delta?: number
          id?: string
          reason?: string | null
          sale_return_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_credit_movements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_credit_movements_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_credit_movements_sale_return_id_fkey"
            columns: ["sale_return_id"]
            isOneToOne: false
            referencedRelation: "sale_returns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_credit_movements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          address: string | null
          created_at: string
          deleted_at: string | null
          id: string
          is_active: boolean
          is_default: boolean
          name: string
          phone: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          name: string
          phone?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          name?: string
          phone?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stores_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_addons: {
        Row: {
          addon_key: string
          created_at: string
          id: string
          provider_ref: string | null
          source: string
          status: string
          tenant_id: string
        }
        Insert: {
          addon_key: string
          created_at?: string
          id?: string
          provider_ref?: string | null
          source?: string
          status?: string
          tenant_id: string
        }
        Update: {
          addon_key?: string
          created_at?: string
          id?: string
          provider_ref?: string | null
          source?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_addons_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          billing_cycle: string
          cancel_at_period_end: boolean | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          is_lifetime: boolean
          limit_overrides: Json
          mp_preapproval_id: string | null
          plan_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          billing_cycle?: string
          cancel_at_period_end?: boolean | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          is_lifetime?: boolean
          limit_overrides?: Json
          mp_preapproval_id?: string | null
          plan_id: string
          status: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          billing_cycle?: string
          cancel_at_period_end?: boolean | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          is_lifetime?: boolean
          limit_overrides?: Json
          mp_preapproval_id?: string | null
          plan_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      system_email_config: {
        Row: {
          from_email: string
          from_name: string
          id: boolean
          updated_at: string
        }
        Insert: {
          from_email?: string
          from_name?: string
          id?: boolean
          updated_at?: string
        }
        Update: {
          from_email?: string
          from_name?: string
          id?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      system_email_smtp: {
        Row: {
          from_email: string
          from_name: string
          host: string
          id: boolean
          password: string
          port: number
          secure: boolean
          updated_at: string
          username: string
        }
        Insert: {
          from_email?: string
          from_name?: string
          host?: string
          id?: boolean
          password?: string
          port?: number
          secure?: boolean
          updated_at?: string
          username?: string
        }
        Update: {
          from_email?: string
          from_name?: string
          host?: string
          id?: boolean
          password?: string
          port?: number
          secure?: boolean
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      system_email_templates: {
        Row: {
          html: string
          key: string
          subject: string
          updated_at: string
        }
        Insert: {
          html?: string
          key: string
          subject?: string
          updated_at?: string
        }
        Update: {
          html?: string
          key?: string
          subject?: string
          updated_at?: string
        }
        Relationships: []
      }
      system_emails: {
        Row: {
          created_at: string
          error_message: string | null
          html_content: string | null
          id: string
          kind: string
          recipient: string
          sent_at: string | null
          status: string
          subject: string
          tenant_id: string | null
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          html_content?: string | null
          id?: string
          kind?: string
          recipient: string
          sent_at?: string | null
          status?: string
          subject: string
          tenant_id?: string | null
        }
        Update: {
          created_at?: string
          error_message?: string | null
          html_content?: string | null
          id?: string
          kind?: string
          recipient?: string
          sent_at?: string | null
          status?: string
          subject?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "system_emails_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      system_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      tenant_branding: {
        Row: {
          accent: string | null
          address: string | null
          cuit: string | null
          iva_condition: string | null
          legal_name: string | null
          logo_path: string | null
          logo_url: string | null
          phone: string | null
          tenant_id: string
          ticket_footer: string | null
          ticket_legend: string | null
          ticket_show_logo: boolean
          ticket_show_qr: boolean
          ticket_title: string | null
          ticket_width: string
          updated_at: string
        }
        Insert: {
          accent?: string | null
          address?: string | null
          cuit?: string | null
          iva_condition?: string | null
          legal_name?: string | null
          logo_path?: string | null
          logo_url?: string | null
          phone?: string | null
          tenant_id: string
          ticket_footer?: string | null
          ticket_legend?: string | null
          ticket_show_logo?: boolean
          ticket_show_qr?: boolean
          ticket_title?: string | null
          ticket_width?: string
          updated_at?: string
        }
        Update: {
          accent?: string | null
          address?: string | null
          cuit?: string | null
          iva_condition?: string | null
          legal_name?: string | null
          logo_path?: string | null
          logo_url?: string | null
          phone?: string | null
          tenant_id?: string
          ticket_footer?: string | null
          ticket_legend?: string | null
          ticket_show_logo?: boolean
          ticket_show_qr?: boolean
          ticket_title?: string | null
          ticket_width?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_branding_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_discounts: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          kind: string
          reason: string | null
          tenant_id: string
          valid_from: string
          valid_until: string | null
          value: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          kind: string
          reason?: string | null
          tenant_id: string
          valid_from?: string
          valid_until?: string | null
          value: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          kind?: string
          reason?: string | null
          tenant_id?: string
          valid_from?: string
          valid_until?: string | null
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "tenant_discounts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_discounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_email_smtp: {
        Row: {
          body_template: string
          body_text: string | null
          from_email: string
          from_name: string
          host: string
          password: string
          port: number
          secure: boolean
          tenant_id: string
          updated_at: string
          username: string
        }
        Insert: {
          body_template?: string
          body_text?: string | null
          from_email?: string
          from_name?: string
          host?: string
          password?: string
          port?: number
          secure?: boolean
          tenant_id: string
          updated_at?: string
          username?: string
        }
        Update: {
          body_template?: string
          body_text?: string | null
          from_email?: string
          from_name?: string
          host?: string
          password?: string
          port?: number
          secure?: boolean
          tenant_id?: string
          updated_at?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_email_smtp_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_feature_flags: {
        Row: {
          configured_at: string
          configured_by: string | null
          enabled: boolean
          feature_flag_id: string
          id: string
          tenant_id: string
        }
        Insert: {
          configured_at?: string
          configured_by?: string | null
          enabled: boolean
          feature_flag_id: string
          id?: string
          tenant_id: string
        }
        Update: {
          configured_at?: string
          configured_by?: string | null
          enabled?: boolean
          feature_flag_id?: string
          id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_feature_flags_configured_by_fkey"
            columns: ["configured_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_feature_flags_feature_flag_id_fkey"
            columns: ["feature_flag_id"]
            isOneToOne: false
            referencedRelation: "feature_flags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_feature_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_notes: {
        Row: {
          author_user_id: string | null
          body: string
          created_at: string
          deleted_at: string | null
          id: string
          tenant_id: string
        }
        Insert: {
          author_user_id?: string | null
          body: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          tenant_id: string
        }
        Update: {
          author_user_id?: string | null
          body?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_payment_methods: {
        Row: {
          config: Json
          enabled: boolean
          id: string
          provider_key: string
          sandbox: boolean
          sort: number
          surcharge_pct: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          config?: Json
          enabled?: boolean
          id?: string
          provider_key: string
          sandbox?: boolean
          sort?: number
          surcharge_pct?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          config?: Json
          enabled?: boolean
          id?: string
          provider_key?: string
          sandbox?: boolean
          sort?: number
          surcharge_pct?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_payment_methods_provider_key_fkey"
            columns: ["provider_key"]
            isOneToOne: false
            referencedRelation: "payment_providers"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "tenant_payment_methods_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_users: {
        Row: {
          avatar: string | null
          created_at: string
          display_name: string | null
          id: string
          invited_at: string | null
          joined_at: string | null
          role: string
          status: string
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          invited_at?: string | null
          joined_at?: string | null
          role: string
          status?: string
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          invited_at?: string | null
          joined_at?: string | null
          role?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_users_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          country: string
          created_at: string
          cuit: string | null
          deleted_at: string | null
          id: string
          industry: string | null
          name: string
          slug: string
          status: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          country?: string
          created_at?: string
          cuit?: string | null
          deleted_at?: string | null
          id?: string
          industry?: string | null
          name: string
          slug: string
          status?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          country?: string
          created_at?: string
          cuit?: string | null
          deleted_at?: string | null
          id?: string
          industry?: string | null
          name?: string
          slug?: string
          status?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      ticket_templates: {
        Row: {
          content: Json
          created_at: string
          deleted_at: string | null
          email_active: boolean
          id: string
          is_default: boolean
          kind: string
          mode: string
          name: string
          paper: string
          print_active: boolean
          show_ninjasoft_logo: boolean
          tenant_id: string
          updated_at: string
        }
        Insert: {
          content?: Json
          created_at?: string
          deleted_at?: string | null
          email_active?: boolean
          id?: string
          is_default?: boolean
          kind?: string
          mode?: string
          name: string
          paper?: string
          print_active?: boolean
          show_ninjasoft_logo?: boolean
          tenant_id: string
          updated_at?: string
        }
        Update: {
          content?: Json
          created_at?: string
          deleted_at?: string | null
          email_active?: boolean
          id?: string
          is_default?: boolean
          kind?: string
          mode?: string
          name?: string
          paper?: string
          print_active?: boolean
          show_ninjasoft_logo?: boolean
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          internal_level: string | null
          is_internal: boolean
          locale: string | null
          settings: Json
          suspended_at: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          internal_level?: string | null
          is_internal?: boolean
          locale?: string | null
          settings?: Json
          suspended_at?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          internal_level?: string | null
          is_internal?: boolean
          locale?: string | null
          settings?: Json
          suspended_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      warranty_plans: {
        Row: {
          commission_pct: number
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          label: string
          months: number
          price: number
          price_pct: number
          sort: number
          tenant_id: string
        }
        Insert: {
          commission_pct?: number
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          label: string
          months?: number
          price?: number
          price_pct?: number
          sort?: number
          tenant_id?: string
        }
        Update: {
          commission_pct?: number
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          label?: string
          months?: number
          price?: number
          price_pct?: number
          sort?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "warranty_plans_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _assert_valid_industry: {
        Args: { p_industry: string }
        Returns: undefined
      }
      _dunning_email_html: {
        Args: { p_body: string; p_tenant: string; p_title: string }
        Returns: string
      }
      adjust_product_stock: {
        Args: {
          p_delta: number
          p_notes?: string
          p_product_id: string
          p_reason: string
        }
        Returns: number
      }
      ai_available: { Args: never; Returns: boolean }
      ai_monthly_usage: { Args: never; Returns: number }
      close_cash_shift: {
        Args: { p_closing_amount: number; p_notes?: string; p_shift_id: string }
        Returns: number
      }
      create_sale: {
        Args: {
          p_customer_id?: string
          p_discount_total?: number
          p_items: Json
          p_notes?: string
          p_payments: Json
        }
        Returns: Json
      }
      current_tenant_id: { Args: never; Returns: string }
      gating_summary: { Args: never; Returns: Json }
      get_email_smtp: { Args: never; Returns: Json }
      get_tenant_smtp: { Args: never; Returns: Json }
      internal_clone_plan: {
        Args: {
          p_base_plan_key: string
          p_monthly_price: number
          p_name: string
          p_tenant_id: string
        }
        Returns: string
      }
      internal_extend_trial: {
        Args: { p_days: number; p_tenant_id: string }
        Returns: string
      }
      internal_grant_access: {
        Args: {
          p_free_days?: number
          p_lifetime: boolean
          p_plan_key: string
          p_reason?: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      internal_level: { Args: never; Returns: string }
      internal_list_staff: {
        Args: never
        Returns: {
          created_at: string
          email: string
          full_name: string
          id: string
          internal_level: string
        }[]
      }
      internal_notify: {
        Args: {
          p_action_label?: string
          p_action_url?: string
          p_body?: string
          p_expires_at?: string
          p_requires_ack?: boolean
          p_role: string
          p_severity: string
          p_tenant_id: string
          p_title: string
          p_type: string
          p_user_id: string
        }
        Returns: string
      }
      internal_save_plan: {
        Args: {
          p_description: string
          p_icon: string
          p_id: string
          p_is_active: boolean
          p_key: string
          p_limits: Json
          p_monthly_price: number
          p_name: string
          p_trial_days: number
        }
        Returns: string
      }
      internal_set_addon: {
        Args: { p_active: boolean; p_addon_key: string; p_tenant_id: string }
        Returns: undefined
      }
      internal_set_flag: {
        Args: { p_enabled: boolean; p_flag_key: string; p_tenant_id: string }
        Returns: undefined
      }
      internal_set_industry: {
        Args: { p_industry: string; p_tenant_id: string }
        Returns: undefined
      }
      internal_set_limit_override: {
        Args: {
          p_key: string
          p_reason?: string
          p_tenant_id: string
          p_value: number
        }
        Returns: Json
      }
      internal_set_plan: {
        Args: { p_plan_key: string; p_tenant_id: string }
        Returns: undefined
      }
      internal_set_subscription_status: {
        Args: { p_status: string; p_tenant_id: string }
        Returns: undefined
      }
      internal_set_trial_end: {
        Args: { p_ends_at: string; p_reason?: string; p_tenant_id: string }
        Returns: string
      }
      internal_tenant_health: {
        Args: never
        Returns: {
          active_users: number
          last_login_at: string
          last_sale_at: string
          sales_7d_count: number
          sales_7d_total: number
          tenant_id: string
        }[]
      }
      internal_trial_outcome: {
        Args: { p_outcome: string; p_reason?: string; p_tenant_id: string }
        Returns: undefined
      }
      internal_update_custom_plan: {
        Args: {
          p_limits: Json
          p_monthly_price: number
          p_name: string
          p_plan_id: string
          p_reason?: string
        }
        Returns: undefined
      }
      is_internal: { Args: never; Returns: boolean }
      onboarding_status: { Args: never; Returns: Json }
      open_cash_shift: {
        Args: { p_opening_amount: number; p_register_id: string }
        Returns: string
      }
      public_catalog: { Args: { p_slug: string }; Returns: Json }
      purge_system_emails: { Args: never; Returns: undefined }
      redeem_invite_code: {
        Args: { p_code: string; p_tenant_id: string }
        Returns: Json
      }
      return_sale: {
        Args: {
          p_items: Json
          p_reason?: string
          p_refund?: string
          p_sale_id: string
        }
        Returns: Json
      }
      run_saas_dunning: { Args: never; Returns: Json }
      sales_report: { Args: { p_from: string; p_to: string }; Returns: Json }
      set_my_tenant_industry: {
        Args: { p_industry: string }
        Returns: undefined
      }
      tenant_has_feature: { Args: { p_key: string }; Returns: boolean }
      tenant_limit: { Args: { p_key: string }; Returns: number }
      tenant_members: {
        Args: never
        Returns: {
          avatar: string
          display_name: string
          email: string
          full_name: string
          joined_at: string
          role: string
          status: string
          user_id: string
        }[]
      }
      top_products: {
        Args: { p_limit?: number }
        Returns: {
          allow_negative: boolean | null
          barcode: string | null
          brand_id: string | null
          category_id: string | null
          cost: number | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          has_variants: boolean
          id: string
          image_url: string | null
          is_active: boolean
          is_kit: boolean
          is_serialized: boolean
          metadata: Json
          name: string
          price: number
          season: string | null
          sku: string | null
          stock: number
          stock_min: number | null
          tags: string[]
          tax_rate: number
          tenant_id: string
          track_stock: boolean
          unit: string
          updated_at: string
          updated_by: string | null
          variant_axes: Json | null
          warranty_months: number
        }[]
        SetofOptions: {
          from: "*"
          to: "products"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      void_sale: {
        Args: { p_reason: string; p_sale_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
