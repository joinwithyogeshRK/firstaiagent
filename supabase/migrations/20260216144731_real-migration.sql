-- ============================================================================
-- EXTENSIONS
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- CUSTOM TYPES
-- ============================================================================
CREATE TYPE appointment_status AS ENUM (
  'pending',
  'confirmed',
  'completed',
  'cancelled'
);

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Profiles table (patient accounts)
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text UNIQUE NOT NULL,
  full_name text NOT NULL,
  phone text,
  medical_id text,
  avatar_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  CONSTRAINT profiles_full_name_not_empty CHECK (length(trim(full_name)) > 0)
);

CREATE INDEX profiles_email_idx ON public.profiles(email);
CREATE INDEX profiles_medical_id_idx ON public.profiles(medical_id);

-- ============================================================================
-- APPLICATION TABLES
-- ============================================================================

-- Doctors table (managed via Supabase dashboard)
CREATE TABLE public.doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
,
  full_name text NOT NULL,
  specialty text NOT NULL,
  photo_url text,
  rating numeric(3, 2) CHECK (rating >= 0 AND rating <= 5),
  bio text,
  location text,
  available_days text[], -- Array of days: ['Monday', 'Tuesday', 'Wednesday']
  available_time_start time,
  available_time_end time,
  consultation_duration_minutes integer DEFAULT 30,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  CONSTRAINT doctors_full_name_not_empty CHECK (length(trim(full_name)) > 0),
  CONSTRAINT doctors_specialty_not_empty CHECK (length(trim(specialty)) > 0),
  CONSTRAINT doctors_duration_positive CHECK (consultation_duration_minutes > 0)
);

CREATE INDEX doctors_specialty_idx ON public.doctors(specialty);
CREATE INDEX doctors_location_idx ON public.doctors(location);
CREATE INDEX doctors_active_idx ON public.doctors(is_active) WHERE is_active = true;
CREATE INDEX doctors_rating_idx ON public.doctors(rating DESC);

-- Appointments table (patient bookings)
CREATE TABLE public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  appointment_date date NOT NULL,
  appointment_time time NOT NULL,
  status appointment_status NOT NULL DEFAULT 'pending',
  booking_reference text UNIQUE NOT NULL,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  CONSTRAINT appointments_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES public.profiles(id)
    ON DELETE CASCADE,
    
  CONSTRAINT appointments_doctor_id_fkey
    FOREIGN KEY (doctor_id)
    REFERENCES public.doctors(id)
    ON DELETE RESTRICT,
    
  CONSTRAINT appointments_date_not_past CHECK (appointment_date >= CURRENT_DATE)
);

CREATE INDEX appointments_user_id_idx ON public.appointments(user_id);
CREATE INDEX appointments_doctor_id_idx ON public.appointments(doctor_id);
CREATE INDEX appointments_date_idx ON public.appointments(appointment_date);
CREATE INDEX appointments_status_idx ON public.appointments(status);
CREATE INDEX appointments_reference_idx ON public.appointments(booking_reference);
CREATE INDEX appointments_upcoming_idx ON public.appointments(user_id, appointment_date, appointment_time) 
  WHERE status IN ('pending', 'confirmed');

-- ============================================================================
-- TRIGGER FUNCTIONS
-- ============================================================================

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$;

-- Update timestamp function
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

-- Generate unique booking reference
CREATE OR REPLACE FUNCTION public.generate_booking_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.booking_reference IS NULL THEN
    NEW.booking_reference := 'APT-' || upper(substring(NEW.id::text, 1, 8));
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW 
  EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW 
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_doctors_updated_at
  BEFORE UPDATE ON public.doctors
  FOR EACH ROW 
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_appointments_updated_at
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW 
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER generate_appointment_reference
  BEFORE INSERT ON public.appointments
  FOR EACH ROW 
  EXECUTE FUNCTION public.generate_booking_reference();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

-- Profiles policies (Category A: User-owned)
CREATE POLICY "profiles_select_policy" ON public.profiles
  FOR SELECT USING (true);

CREATE POLICY "profiles_update_policy" ON public.profiles
  FOR UPDATE USING ((SELECT auth.uid()) = id) WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "profiles_delete_policy" ON public.profiles
  FOR DELETE USING ((SELECT auth.uid()) = id);

-- Doctors policies (Category B: Business data - SELECT only, managed via dashboard)
CREATE POLICY "doctors_select_policy" ON public.doctors
  FOR SELECT USING (true);

-- Appointments policies (Category A: User-owned)
CREATE POLICY "appointments_select_policy" ON public.appointments
  FOR SELECT USING (true);

CREATE POLICY "appointments_insert_policy" ON public.appointments
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "appointments_update_policy" ON public.appointments
  FOR UPDATE USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "appointments_delete_policy" ON public.appointments
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- STORAGE BUCKETS
-- ============================================================================

-- Doctor photos bucket (public)
INSERT INTO storage.buckets (id, name, public)
VALUES ('doctor-photos', 'doctor-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Patient avatars bucket (public)
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- STORAGE POLICIES
-- ============================================================================

-- Doctor photos policies
CREATE POLICY "Doctor photos are publicly accessible"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'doctor-photos');

CREATE POLICY "Authenticated users can upload doctor photos"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'doctor-photos' 
    AND (SELECT auth.uid()) IS NOT NULL
  );

CREATE POLICY "Authenticated users can update doctor photos"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'doctor-photos' 
    AND (SELECT auth.uid()) IS NOT NULL
  );

CREATE POLICY "Authenticated users can delete doctor photos"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'doctor-photos' 
    AND (SELECT auth.uid()) IS NOT NULL
  );

-- Avatar bucket policies
CREATE POLICY "Avatar images are publicly accessible"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

CREATE POLICY "Users can upload their own avatar"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars' 
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users can update their own avatar"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars' 
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users can delete their own avatar"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars' 
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );

-- ============================================================================
-- RPC FUNCTIONS
-- ============================================================================

-- Get available time slots for a doctor on a specific date
CREATE OR REPLACE FUNCTION public.get_available_time_slots(
  p_doctor_id uuid,
  p_date date
)
RETURNS TABLE (
  time_slot time,
  is_available boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_time time;
  v_end_time time;
  v_duration integer;
  v_current_time time;
BEGIN
  -- Get doctor's availability settings
  SELECT available_time_start, available_time_end, consultation_duration_minutes
  INTO v_start_time, v_end_time, v_duration
  FROM public.doctors
  WHERE id = p_doctor_id AND is_active = true;

  IF v_start_time IS NULL THEN
    RETURN;
  END IF;

  -- Generate time slots
  v_current_time := v_start_time;
  WHILE v_current_time < v_end_time LOOP
    RETURN QUERY
    SELECT 
      v_current_time,
      NOT EXISTS (
        SELECT 1 FROM public.appointments
        WHERE doctor_id = p_doctor_id
          AND appointment_date = p_date
          AND appointment_time = v_current_time
          AND status IN ('pending', 'confirmed')
      );
    
    v_current_time := v_current_time + (v_duration || ' minutes')::interval;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_available_time_slots TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_available_time_slots TO anon;