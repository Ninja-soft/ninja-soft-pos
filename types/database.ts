// =============================================================================
// GENERADO AUTOMÁTICAMENTE — no editar a mano.
// Origen: Supabase project hrkditzrsavehnhngakb (dev/staging).
// Regenerar con: pnpm db:types
// =============================================================================

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
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
        Relationships: []
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
        Relationships: []
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
        Relationships: []
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
        Relationships: []
      }
      customers: {
        Row: {
          address: string | null
          created_at: string
          deleted_at: string | null
          document_number: string | null
          document_type: string | null
          email: string | null
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
          created_at?: string
          deleted_at?: string | null
          document_number?: string | null
          document_type?: string | null
          email?: string | null
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
          created_at?: string
          deleted_at?: string | null
          document_number?: string | null
          document_type?: string | null
          email?: string | null
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
        Relationships: []
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
        Relationships: []
      }
      plans: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          key: string
          limits: Json
          monthly_price_ars: number
          name: string
          yearly_price_ars: number | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key: string
          limits?: Json
          monthly_price_ars: number
          name: string
          yearly_price_ars?: number | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key?: string
          limits?: Json
          monthly_price_ars?: number
          name?: string
          yearly_price_ars?: number | null
        }
        Relationships: []
      }
      products: {
        Row: {
          barcode: string | null
          category_id: string | null
          cost: number | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          id: string
          image_url: string | null
          is_active: boolean
          metadata: Json
          name: string
          price: number
          sku: string | null
          stock: number
          stock_min: number | null
          tenant_id: string
          unit: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          barcode?: string | null
          category_id?: string | null
          cost?: number | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          metadata?: Json
          name: string
          price: number
          sku?: string | null
          stock?: number
          stock_min?: number | null
          tenant_id?: string
          unit?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          barcode?: string | null
          category_id?: string | null
          cost?: number | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          metadata?: Json
          name?: string
          price?: number
          sku?: string | null
          stock?: number
          stock_min?: number | null
          tenant_id?: string
          unit?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      sale_items: {
        Row: {
          created_at: string
          discount: number
          id: string
          product_id: string
          product_name: string
          quantity: number
          sale_id: string
          sku: string | null
          subtotal: number
          tenant_id: string
          unit_price: number
        }
        Insert: {
          created_at?: string
          discount?: number
          id?: string
          product_id: string
          product_name: string
          quantity: number
          sale_id: string
          sku?: string | null
          subtotal: number
          tenant_id?: string
          unit_price: number
        }
        Update: {
          created_at?: string
          discount?: number
          id?: string
          product_id?: string
          product_name?: string
          quantity?: number
          sale_id?: string
          sku?: string | null
          subtotal?: number
          tenant_id?: string
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "sale_items_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
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
        Relationships: []
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
        }
        Relationships: [
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
        Relationships: []
      }
      subscriptions: {
        Row: {
          billing_cycle: string
          cancel_at_period_end: boolean | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
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
          plan_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: []
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
        Relationships: []
      }
      tenant_users: {
        Row: {
          created_at: string
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
          created_at?: string
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
          created_at?: string
          id?: string
          invited_at?: string | null
          joined_at?: string | null
          role?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
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
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          is_internal: boolean
          locale: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          is_internal?: boolean
          locale?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          is_internal?: boolean
          locale?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      adjust_product_stock: {
        Args: {
          p_delta: number
          p_notes?: string
          p_product_id: string
          p_reason: string
        }
        Returns: number
      }
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
      is_internal: { Args: never; Returns: boolean }
      open_cash_shift: {
        Args: { p_opening_amount: number; p_register_id: string }
        Returns: string
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
