-- E-commerce Platform Schema Migration
-- Order: extensions → tables → functions → triggers → policies → storage → realtime

-- 1. Database Configuration
ALTER DATABASE postgres SET row_security = on;

-- 2. Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 3. Custom Types
CREATE TYPE product_type AS ENUM ('digital', 'physical');
CREATE TYPE order_status AS ENUM ('pending', 'processing', 'shipped', 'delivered', 'cancelled');

-- 4. Tables

-- Profiles table (linked to auth.users)
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text UNIQUE NOT NULL,
  full_name text,
  avatar_url text,
  phone text,
  shipping_address jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Products table
CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  type product_type NOT NULL DEFAULT 'physical'::product_type,
  price numeric(10,2) NOT NULL CHECK (price >= 0),
  image_url text,
  file_url text,
  inventory integer DEFAULT 0 CHECK (inventory >= 0),
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Cart items table
CREATE TABLE public.cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  CONSTRAINT cart_items_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users(id)
    ON DELETE CASCADE,

  CONSTRAINT cart_items_product_id_fkey
    FOREIGN KEY (product_id)
    REFERENCES public.products(id)
    ON DELETE CASCADE,

  UNIQUE(user_id, product_id)
);

-- Wishlists table
CREATE TABLE public.wishlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  product_id uuid NOT NULL,
  created_at timestamptz DEFAULT now(),

  CONSTRAINT wishlists_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users(id)
    ON DELETE CASCADE,

  CONSTRAINT wishlists_product_id_fkey
    FOREIGN KEY (product_id)
    REFERENCES public.products(id)
    ON DELETE CASCADE,

  UNIQUE(user_id, product_id)
);

-- Orders table
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status order_status NOT NULL DEFAULT 'pending'::order_status,
  total_amount numeric(10,2) NOT NULL CHECK (total_amount >= 0),
  shipping_address jsonb NOT NULL,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  CONSTRAINT orders_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users(id)
    ON DELETE CASCADE
);

-- Order items table
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  product_id uuid,
  product_name text NOT NULL,
  product_type product_type NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  price numeric(10,2) NOT NULL CHECK (price >= 0),
  created_at timestamptz DEFAULT now(),

  CONSTRAINT order_items_order_id_fkey
    FOREIGN KEY (order_id)
    REFERENCES public.orders(id)
    ON DELETE CASCADE,

  CONSTRAINT order_items_product_id_fkey
    FOREIGN KEY (product_id)
    REFERENCES public.products(id)
    ON DELETE SET NULL
);

-- Downloads table
CREATE TABLE public.downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  product_id uuid NOT NULL,
  order_id uuid NOT NULL,
  download_count integer DEFAULT 0 CHECK (download_count >= 0),
  max_downloads integer DEFAULT 5 CHECK (max_downloads > 0),
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  CONSTRAINT downloads_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users(id)
    ON DELETE CASCADE,

  CONSTRAINT downloads_product_id_fkey
    FOREIGN KEY (product_id)
    REFERENCES public.products(id)
    ON DELETE CASCADE,

  CONSTRAINT downloads_order_id_fkey
    FOREIGN KEY (order_id)
    REFERENCES public.orders(id)
    ON DELETE CASCADE,

  UNIQUE(user_id, product_id, order_id)
);

-- 5. Indexes
CREATE INDEX cart_items_user_id_idx ON public.cart_items(user_id);
CREATE INDEX cart_items_product_id_idx ON public.cart_items(product_id);
CREATE INDEX wishlists_user_id_idx ON public.wishlists(user_id);
CREATE INDEX wishlists_product_id_idx ON public.wishlists(product_id);
CREATE INDEX orders_user_id_idx ON public.orders(user_id);
CREATE INDEX orders_status_idx ON public.orders(status);
CREATE INDEX order_items_order_id_idx ON public.order_items(order_id);
CREATE INDEX order_items_product_id_idx ON public.order_items(product_id);
CREATE INDEX downloads_user_id_idx ON public.downloads(user_id);
CREATE INDEX downloads_product_id_idx ON public.downloads(product_id);
CREATE INDEX downloads_order_id_idx ON public.downloads(order_id);
CREATE INDEX products_is_active_idx ON public.products(is_active);

-- 6. Functions

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (new.id, new.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$;

-- Update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Create download access when order is completed
CREATE OR REPLACE FUNCTION public.create_download_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only create downloads when order status changes to 'processing' or 'delivered'
  IF NEW.status IN ('processing'::order_status, 'delivered'::order_status) AND 
     (OLD.status IS NULL OR OLD.status = 'pending'::order_status) THEN
    
    INSERT INTO public.downloads (user_id, product_id, order_id, expires_at)
    SELECT 
      NEW.user_id,
      oi.product_id,
      NEW.id,
      now() + interval '1 year'
    FROM public.order_items oi
    INNER JOIN public.products p ON oi.product_id = p.id
    WHERE oi.order_id = NEW.id
      AND p.type = 'digital'::product_type
      AND oi.product_id IS NOT NULL
    ON CONFLICT (user_id, product_id, order_id) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;

-- 7. Triggers

-- Profile creation trigger
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Updated_at triggers
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_cart_items_updated_at
  BEFORE UPDATE ON public.cart_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_downloads_updated_at
  BEFORE UPDATE ON public.downloads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Download access creation trigger
CREATE TRIGGER create_downloads_on_order_complete
  AFTER UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.create_download_access();

-- 8. Row Level Security Policies

-- Profiles RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public profiles are viewable by everyone"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Products RLS
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Active products are viewable by everyone"
  ON public.products FOR SELECT
  TO authenticated
  USING (is_active = true);

-- Cart items RLS
ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own cart items"
  ON public.cart_items FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own cart items"
  ON public.cart_items FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own cart items"
  ON public.cart_items FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own cart items"
  ON public.cart_items FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Wishlists RLS
ALTER TABLE public.wishlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own wishlist"
  ON public.wishlists FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own wishlist items"
  ON public.wishlists FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own wishlist items"
  ON public.wishlists FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Orders RLS
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own orders"
  ON public.orders FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own orders"
  ON public.orders FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own orders"
  ON public.orders FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Order items RLS
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own order items"
  ON public.order_items FOR SELECT
  TO authenticated
  USING (
    order_id IN (
      SELECT id FROM public.orders WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create order items for own orders"
  ON public.order_items FOR INSERT
  TO authenticated
  WITH CHECK (
    order_id IN (
      SELECT id FROM public.orders WHERE user_id = auth.uid()
    )
  );

-- Downloads RLS
ALTER TABLE public.downloads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own downloads"
  ON public.downloads FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own download count"
  ON public.downloads FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 9. Storage Buckets

-- Products bucket (public for product images)
INSERT INTO storage.buckets (id, name, public)
VALUES ('products', 'products', true)
ON CONFLICT (id) DO NOTHING;

-- Digital products bucket (private for downloadable files)
INSERT INTO storage.buckets (id, name, public)
VALUES ('digital-products', 'digital-products', false)
ON CONFLICT (id) DO NOTHING;

-- 10. Storage RLS Policies

-- Products bucket policies (public read)
CREATE POLICY "Product images are publicly accessible"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'products');

-- Digital products bucket policies (user-specific access)
CREATE POLICY "Users can view purchased digital products"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'digital-products' AND
    EXISTS (
      SELECT 1 FROM public.downloads d
      WHERE d.user_id = auth.uid()
        AND (split_part(name, '/', 1) = d.product_id::text)

        AND (d.expires_at IS NULL OR d.expires_at > now())
        AND d.download_count < d.max_downloads
    )
  );