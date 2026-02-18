-- Create payment table for tracking Stripe payments
CREATE TABLE IF NOT EXISTS payment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT UNIQUE,
  client_session_id TEXT,
  payment_intent_id TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  amount DECIMAL(10, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending',
  customer_email TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create webhook_events table for idempotency
CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create user_subscriptions table for pro plan tracking
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free',
  payment_id UUID REFERENCES payment(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS payment_user_id_idx ON payment(user_id);
CREATE INDEX IF NOT EXISTS payment_order_id_idx ON payment(order_id);
CREATE INDEX IF NOT EXISTS payment_status_idx ON payment(status);
CREATE INDEX IF NOT EXISTS payment_session_id_idx ON payment(session_id);
CREATE INDEX IF NOT EXISTS payment_intent_id_idx ON payment(payment_intent_id);
CREATE INDEX IF NOT EXISTS webhook_events_stripe_event_id_idx ON webhook_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS user_subscriptions_user_id_idx ON user_subscriptions(user_id);

-- Add updated_at trigger for payment table
CREATE OR REPLACE FUNCTION update_payment_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_updated_at_trigger
  BEFORE UPDATE ON payment
  FOR EACH ROW
  EXECUTE FUNCTION update_payment_updated_at();

-- Add updated_at trigger for user_subscriptions table
CREATE TRIGGER user_subscriptions_updated_at_trigger
  BEFORE UPDATE ON user_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_payment_updated_at();

-- RLS Policies for payment table
ALTER TABLE payment ENABLE ROW LEVEL SECURITY;

-- Users can view their own payments
CREATE POLICY "Users can view their own payments"
  ON payment FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can do everything (for edge functions)
CREATE POLICY "Service role has full access to payment"
  ON payment FOR ALL
  USING (auth.role() = 'service_role');

-- RLS Policies for webhook_events table (service role only)
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role has full access to webhook_events"
  ON webhook_events FOR ALL
  USING (auth.role() = 'service_role');

-- RLS Policies for user_subscriptions table
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can view their own subscription
CREATE POLICY "Users can view their own subscription"
  ON user_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Service role has full access
CREATE POLICY "Service role has full access to user_subscriptions"
  ON user_subscriptions FOR ALL
  USING (auth.role() = 'service_role');

-- Function to upgrade user to pro plan
CREATE OR REPLACE FUNCTION upgrade_user_to_pro(p_user_id UUID, p_payment_id UUID)
RETURNS VOID AS $$
BEGIN
  INSERT INTO user_subscriptions (user_id, plan, payment_id)
  VALUES (p_user_id, 'pro', p_payment_id)
  ON CONFLICT (user_id) 
  DO UPDATE SET 
    plan = 'pro',
    payment_id = p_payment_id,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;