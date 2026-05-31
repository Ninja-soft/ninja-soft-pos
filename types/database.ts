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
          opened_by: string
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
        Relationships: [
          {
            foreignKeyName: "customers_tenant_id_fkey"
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
      products: {
        Row: {
          barcode: string | null
          brand_id: string | null
          category_id: string | null
          cost: number | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
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
        }
        Insert: {
          barcode?: string | null
          brand_id?: string | null
          category_id?: string | null
          cost?: number | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
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
        }
        Update: {
          barcode?: string | null
          brand_id?: string | null
          category_id?: string | null
          cost?: number | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
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
      sale_items: {
        Row: {
          created_at: string
          discount: number
          id: string
          product_id: string | null
          product_name: string
          quantity: number
          sale_id: string
          serial: string | null
          sku: string | null
          subtotal: number
          tenant_id: string
          unit_price: number
        }
        Insert: {
          created_at?: string
          discount?: number
          id?: string
          product_id?: string | null
          product_name: string
          quantity: number
          sale_id: string
          serial?: string | null
          sku?: string | null
          subtotal: number
          tenant_id?: string
          unit_price: number
        }
        Update: {
          created_at?: string
          discount?: number
          id?: string
          product_id?: string | null
          product_name?: string
          quantity?: number
          sale_id?: string
          serial?: string | null
          sku?: string | null
          subtotal?: number
          tenant_id?: string
          unit_price?: number
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
          tenant_id: string
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
          legal_name: string | null
          logo_path: string | null
          logo_url: string | null
          phone: string | null
          tenant_id: string
          ticket_footer: string | null
          ticket_width: string
          updated_at: string
        }
        Insert: {
          accent?: string | null
          address?: string | null
          cuit?: string | null
          legal_name?: string | null
          logo_path?: string | null
          logo_url?: string | null
          phone?: string | null
          tenant_id: string
          ticket_footer?: string | null
          ticket_width?: string
          updated_at?: string
        }
        Update: {
          accent?: string | null
          address?: string | null
          cuit?: string | null
          legal_name?: string | null
          logo_path?: string | null
          logo_url?: string | null
          phone?: string | null
          tenant_id?: string
          ticket_footer?: string | null
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
          updated_at?: string
        }
        Relationships: []
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
      get_email_smtp: { Args: never; Returns: Json }
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
      internal_set_flag: {
        Args: { p_enabled: boolean; p_flag_key: string; p_tenant_id: string }
        Returns: undefined
      }
      internal_set_industry: {
        Args: { p_industry: string; p_tenant_id: string }
        Returns: undefined
      }
      internal_set_plan: {
        Args: { p_plan_key: string; p_tenant_id: string }
        Returns: undefined
      }
      internal_set_subscription_status: {
        Args: { p_status: string; p_tenant_id: string }
        Returns: undefined
      }
      is_internal: { Args: never; Returns: boolean }
      open_cash_shift: {
        Args: { p_opening_amount: number; p_register_id: string }
        Returns: string
      }
      public_catalog: { Args: { p_slug: string }; Returns: Json }
      sales_report: { Args: { p_from: string; p_to: string }; Returns: Json }
      set_my_tenant_industry: {
        Args: { p_industry: string }
        Returns: undefined
      }
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
        Returns: Database["public"]["Tables"]["products"]["Row"][]
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
