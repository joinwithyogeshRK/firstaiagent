import Anthropic from "@anthropic-ai/sdk";
import { getDatabaseSchema } from "./tools/getDatabaseSchema.js";
import { executeQuery } from "./tools/executeQuery.js";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const tools = [
  {
    name: "get_database_schema",
    description: "Fetches the full Supabase database migration schema.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "resolve_table_name",
    description: `Resolves user's table reference to actual database table name.
    Examples: "cart" → "cart_items", "payment" → "payments", "user" → "profiles"`,
    input_schema: {
      type: "object",
      properties: {
        user_table_reference: {
          type: "string",
          description: "The table name the user mentioned",
        },
      },
      required: ["user_table_reference"],
    },
  },
  {
    name: "get_auth_user_id",
    description: `Finds the correct auth user ID column for a table.`,
    input_schema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "The table name to find auth user ID for",
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "get_existing_triggers",
    description: "Fetches all existing triggers on a specific table.",
    input_schema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "The table name to check for existing triggers",
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "execute_query",
    description:
      "Executes SQL query in Supabase database. ONLY for CREATE statements.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SQL query to execute" },
      },
      required: ["sql"],
    },
  },
];

export async function generateQuery(instruction) {
  console.log("🤖 AI Agent started...");
  console.log("📝 Instruction:", instruction);

  const edgeFunctionUrl = process.env.EDGE_FUNCTION_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const simblyIngestSecret = process.env.SIMBLY_INGEST_SECRET;
  const adminEmail = process.env.ADMIN_EMAIL; // Admin email from chat/setup

  if (!edgeFunctionUrl || !supabaseAnonKey || !simblyIngestSecret) {
    throw new Error(
      "Missing one of: EDGE_FUNCTION_URL, SUPABASE_ANON_KEY, SIMBLY_INGEST_SECRET",
    );
  }

  const uniqueSuffix = Date.now();

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER: Get Admin User ID from Email
  // ═══════════════════════════════════════════════════════════════════════════

  async function getAdminUserId() {
    if (!adminEmail) {
      return null;
    }

    try {
      // Try to find user by email in profiles table first
      const profileResult = await executeQuery(`
        SELECT id FROM profiles WHERE email = '${adminEmail}' LIMIT 1
      `).catch(() => []);

      if (profileResult.length > 0) {
        console.log(`   ✅ Found admin in profiles: ${adminEmail}`);
        return profileResult[0].id;
      }

      // Fallback: Check auth.users
      const authResult = await executeQuery(`
        SELECT id FROM auth.users WHERE email = '${adminEmail}' LIMIT 1
      `).catch(() => []);

      if (authResult.length > 0) {
        console.log(`   ✅ Found admin in auth.users: ${adminEmail}`);
        return authResult[0].id;
      }

      console.warn(`   ⚠️  Admin email not found: ${adminEmail}`);
      return null;
    } catch (error) {
      console.error(`   ❌ Error fetching admin ID: ${error.message}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: ANALYZE INSTRUCTION
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n🧠 Analyzing instruction...");

  const analysisResponse = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `You are an expert at understanding user intent for database triggers.

Analyze this instruction: "${instruction}"

Extract these details and respond ONLY with valid JSON:

{
  "notification_mode": "user" | "admin",
  "table_hint": "string (table name mentioned or implied)",
  "event_type": "INSERT" | "UPDATE" | "DELETE" | "INSERT OR UPDATE" | "INSERT OR UPDATE OR DELETE",
  "custom_properties": ["field1", "field2"] (empty array if none mentioned),
  "needs_amount_currency": true | false,
  "reasoning": "brief explanation of your analysis"
}

Guidelines:
- notification_mode = "admin" if instruction says "notify me", "send me", "I want to know", "alert me"
- notification_mode = "user" if it's about notifying the user themselves
- table_hint = best guess of table name from context (cart, payment, order, user, profile, etc.)
- event_type = what database operation triggers the email
- custom_properties = specific fields user wants in the email (name, phone, address, etc.)
- needs_amount_currency = true for payment/cart/order/transaction related events, false for signup/profile

Examples:

"notify me when a new user signs up"
{
  "notification_mode": "admin",
  "table_hint": "users",
  "event_type": "INSERT",
  "custom_properties": [],
  "needs_amount_currency": false,
  "reasoning": "Admin wants to be notified about new user signups"
}

"send email to user when payment is completed with amount and currency"
{
  "notification_mode": "user",
  "table_hint": "payment",
  "event_type": "UPDATE",
  "custom_properties": ["amount", "currency"],
  "needs_amount_currency": true,
  "reasoning": "User gets email when their payment completes, include payment details"
}

"when order is placed, send me customer name and shipping address"
{
  "notification_mode": "admin",
  "table_hint": "orders",
  "event_type": "INSERT",
  "custom_properties": ["customer_name", "shipping_address"],
  "needs_amount_currency": true,
  "reasoning": "Admin notification for new orders with customer details"
}

Now analyze: "${instruction}"`,
      },
    ],
  });

  const analysisText =
    analysisResponse.content.find((b) => b.type === "text")?.text.trim() ||
    "{}";

  let analysis;
  try {
    const cleaned = analysisText
      .replace(/^```json\n?/gm, "")
      .replace(/^```\n?/gm, "")
      .trim();
    analysis = JSON.parse(cleaned);
  } catch {
    analysis = {
      notification_mode: "user",
      table_hint: "unknown",
      event_type: "INSERT OR UPDATE OR DELETE",
      custom_properties: [],
      needs_amount_currency: false,
      reasoning: "Failed to parse, using defaults",
    };
  }

  console.log("   📊 Analysis:");
  console.log(
    `   - Mode: ${analysis.notification_mode === "admin" ? "🔔 ADMIN NOTIFICATION" : "👤 USER NOTIFICATION"}`,
  );
  console.log(`   - Table hint: ${analysis.table_hint}`);
  console.log(`   - Event: ${analysis.event_type}`);
  console.log(
    `   - Custom properties: ${analysis.custom_properties.length > 0 ? analysis.custom_properties.join(", ") : "none"}`,
  );
  console.log(
    `   - Needs amount/currency: ${analysis.needs_amount_currency ? "YES" : "NO"}`,
  );
  console.log(`   - Reasoning: ${analysis.reasoning}`);

  // Get admin user ID if admin notification mode
  let adminUserId = null;
  if (analysis.notification_mode === "admin") {
    if (!adminEmail) {
      console.warn(
        "\n⚠️  WARNING: Admin notification requested but ADMIN_EMAIL not set in .env",
      );
      console.warn("   The trigger will be created but emails won't be sent.");
      console.warn(
        "   Please add ADMIN_EMAIL=admin@yourdomain.com to .env file",
      );
    } else {
      console.log(`\n🔍 Looking up admin user ID for: ${adminEmail}...`);
      adminUserId = await getAdminUserId();

      if (!adminUserId) {
        console.warn(
          `\n⚠️  WARNING: Could not find user with email: ${adminEmail}`,
        );
        console.warn(
          "   Make sure this email exists in your auth.users or profiles table",
        );
      } else {
        console.log(`   ✅ Admin user ID: ${adminUserId}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: RESOLVE TABLE NAME
  // ═══════════════════════════════════════════════════════════════════════════

  async function resolveTableName(userReference) {
    try {
      const tables = await executeQuery(`
        SELECT 
          t.table_name,
          array_agg(c.column_name ORDER BY c.ordinal_position) as columns
        FROM information_schema.tables t
        JOIN information_schema.columns c ON c.table_name = t.table_name 
          AND c.table_schema = t.table_schema
        WHERE t.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
        GROUP BY t.table_name
        ORDER BY t.table_name;
      `);

      const tableInfo = tables.map((t) => ({
        name: t.table_name,
        columns: t.columns,
      }));

      console.log(
        `   Available tables: ${tableInfo.map((t) => t.name).join(", ")}`,
      );

      const aiResponse = await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `You are a database expert resolving table names.

User said: "${userReference}"

Available tables:
${tableInfo.map((t) => `- ${t.name} (columns: ${t.columns.join(", ")})`).join("\n")}

Which table? Respond ONLY with JSON:
{
  "table": "exact_table_name",
  "confidence": "high|medium|low",
  "reasoning": "brief explanation"
}

If no match: {"table": null, "confidence": "none", "reasoning": "explanation"}`,
          },
        ],
      });

      const aiText = aiResponse.content
        .find((b) => b.type === "text")
        ?.text.trim();
      const cleaned = aiText
        .replace(/^```json\n?/gm, "")
        .replace(/^```\n?/gm, "")
        .trim();
      const aiDecision = JSON.parse(cleaned);

      if (!aiDecision.table) {
        return {
          resolved: null,
          error: `${aiDecision.reasoning}. Available: ${tableInfo.map((t) => t.name).join(", ")}`,
        };
      }

      return {
        resolved: aiDecision.table,
        confidence: aiDecision.confidence,
        explanation: aiDecision.reasoning,
      };
    } catch (error) {
      return { resolved: null, error: error.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: BUILD SYSTEM PROMPT WITH ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  const systemPrompt = `You are a PostgreSQL/Supabase expert creating database triggers.

🚨 CRITICAL SAFETY RULES:
====================================================================
1. ❌ NEVER write UPDATE, INSERT, DELETE queries on production tables
2. ❌ NEVER modify user data
3. ✅ ONLY create triggers and functions
====================================================================

📊 ANALYZED INSTRUCTION:
====================================================================
Notification Mode: ${analysis.notification_mode === "admin" ? "ADMIN (notify website owner)" : "USER (notify the user themselves)"}
Table Hint: ${analysis.table_hint}
Event Type: ${analysis.event_type}
Custom Properties: ${analysis.custom_properties.length > 0 ? analysis.custom_properties.join(", ") : "none requested"}
Needs Amount/Currency: ${analysis.needs_amount_currency ? "YES" : "NO"}
Reasoning: ${analysis.reasoning}
====================================================================

WORKFLOW:
1. Call "resolve_table_name" with table hint: "${analysis.table_hint}"
2. Call "get_database_schema"
3. Call "get_auth_user_id" for the resolved table
4. Call "get_existing_triggers"
5. Call "execute_query" with the trigger SQL
6. Tell user: "Trigger created! Test by updating a row."

Task: ${instruction}

====================================================================
EDGE FUNCTION CONFIG:
====================================================================
URL: ${edgeFunctionUrl}
Headers:
  "Content-Type": "application/json"
  "Authorization": "Bearer ${supabaseAnonKey}"
  "x-simbly-secret": "${simblyIngestSecret}"

====================================================================
NOTIFICATION MODE LOGIC:
====================================================================

${
  analysis.notification_mode === "admin"
    ? `
🔔 ADMIN NOTIFICATION MODE:
- Admin Email: ${adminEmail || "NOT_SET"}
- Admin User ID: ${adminUserId || "NOT_FOUND"}
- Event name: "profiles.updated" (HARDCODED - never changes)
- Properties: Include details about the NEW user/order/payment

Example payload for admin:
{
  "event": "profiles.updated",
  "userId": "${adminUserId || "ADMIN_ID_HERE"}",
  "properties": {
    "notification_type": "admin_alert",
    "trigger_user_id": "uuid-of-customer",
    "trigger_user_email": "customer@example.com",
    "order_id": "order-123",
    ${analysis.custom_properties.length > 0 ? analysis.custom_properties.map((p) => `"${p}": NEW.${p}`).join(",\n    ") : ""}
    ${analysis.needs_amount_currency ? `"amount": NEW.amount,\n    "currency": NEW.currency,` : ""}
    "timestamp": NOW()
  }
}

CRITICAL: The admin gets notified, NOT the customer.
`
    : `
👤 USER NOTIFICATION MODE:
- userId: NEW.user_id or NEW.id (the user from the row)
- Event name: table.event (e.g., "payments.updated")
- Properties: Include relevant data for the user

Example payload for user:
{
  "event": "payments.updated",
  "userId": "user-uuid-from-row",
  "properties": {
    "id": "row-id",
    "operation": "UPDATE",
    "changed_field": "status",
    "old_value": "pending",
    "new_value": "completed",
    ${analysis.custom_properties.length > 0 ? analysis.custom_properties.map((p) => `"${p}": NEW.${p}`).join(",\n    ") : ""}
    ${analysis.needs_amount_currency ? `"amount": NEW.amount,\n    "currency": NEW.currency,` : ""}
    "timestamp": NOW()
  }
}
`
}

====================================================================
CUSTOM PROPERTIES:
====================================================================
${
  analysis.custom_properties.length > 0
    ? `
User requested these specific fields in properties:
${analysis.custom_properties.map((p) => `- ${p}`).join("\n")}

Make sure to include them in the payload using NEW.${analysis.custom_properties[0]}, etc.
Check the schema to confirm these columns exist.
`
    : `
No custom properties requested. Use defaults:
- id, operation, changed_field, old_value, new_value, timestamp
`
}

====================================================================
AMOUNT/CURRENCY LOGIC:
====================================================================
${
  analysis.needs_amount_currency
    ? `
This is a financial event (payment/cart/order/transaction).
ALWAYS include in properties:
- "amount": NEW.amount (or NEW.total_amount, etc.)
- "currency": NEW.currency
`
    : `
This is NOT a financial event (signup/profile/etc.).
DO NOT include amount or currency.
`
}

====================================================================
SQL TEMPLATE:
====================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.handle_[table]_simbly_${uniqueSuffix}()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  payload       jsonb;
  req_id        bigint;
  evt_name      text;
  uid_val       text;
  changed_field text := '';
  old_value     text := '';
  new_value     text := '';
  row_id        text;
BEGIN

  ${
    analysis.notification_mode === "admin"
      ? `
  -- ADMIN NOTIFICATION MODE
  uid_val := '${adminUserId || "MISSING_ADMIN_ID"}';  -- Fixed admin ID
  row_id  := ${analysis.event_type.includes("DELETE") ? "OLD" : "NEW"}.id::text;
  
  evt_name := TG_TABLE_NAME || '.' || 
    CASE 
      WHEN TG_OP = 'INSERT' THEN 'created'
      WHEN TG_OP = 'UPDATE' THEN 'updated'
      ELSE 'deleted'
    END || '.admin_alert';

  -- Build admin notification payload
  payload := jsonb_build_object(
    'event', evt_name,
    'userId', uid_val,
    'properties', jsonb_build_object(
      'notification_type', 'admin_alert',
      'trigger_user_id', ${analysis.event_type.includes("DELETE") ? "OLD" : "NEW"}.user_id::text,
      'id', row_id,
      'operation', TG_OP,
      'timestamp', NOW()
      ${analysis.custom_properties.length > 0 ? ",\n      " + analysis.custom_properties.map((p) => `'${p}', NEW.${p}`).join(",\n      ") : ""}
      ${analysis.needs_amount_currency ? ",\n      'amount', NEW.amount,\n      'currency', NEW.currency" : ""}
    )
  );
  `
      : `
  -- USER NOTIFICATION MODE
  IF TG_OP = 'DELETE' THEN
    uid_val := OLD.[user_id_column]::text;
    row_id  := OLD.id::text;
  ELSE
    uid_val := NEW.[user_id_column]::text;
    row_id  := NEW.id::text;
  END IF;

  IF uid_val IS NULL OR uid_val = '' THEN
    RAISE WARNING 'Simbly: no userId, skipping';
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Set event name
  IF TG_OP = 'INSERT' THEN
    evt_name := TG_TABLE_NAME || '.created';
  ELSIF TG_OP = 'UPDATE' THEN
    evt_name := TG_TABLE_NAME || '.updated';
  ELSE
    evt_name := TG_TABLE_NAME || '.deleted';
  END IF;

  -- Detect changes for UPDATE
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      changed_field := 'status';
      old_value := COALESCE(OLD.status::text, '');
      new_value := COALESCE(NEW.status::text, '');
    ELSE
      RAISE LOG 'Simbly: No meaningful change, skipping';
      RETURN NEW;
    END IF;
  END IF;

  -- Build user notification payload
  payload := jsonb_build_object(
    'event', evt_name,
    'userId', uid_val,
    'properties', jsonb_build_object(
      'id', row_id,
      'operation', TG_OP,
      'changed_field', changed_field,
      'old_value', old_value,
      'new_value', new_value,
      'timestamp', NOW()
      ${analysis.custom_properties.length > 0 ? ",\n      " + analysis.custom_properties.map((p) => `'${p}', NEW.${p}`).join(",\n      ") : ""}
      ${analysis.needs_amount_currency ? ",\n      'amount', NEW.amount,\n      'currency', NEW.currency" : ""}
    )
  );
  `
  }

  -- Fire HTTP request
  SELECT net.http_post(
    url := '${edgeFunctionUrl}',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ${supabaseAnonKey}',
      'x-simbly-secret', '${simblyIngestSecret}'
    ),
    body := payload,
    timeout_milliseconds := 5000
  ) INTO req_id;

  RAISE LOG 'Simbly: % req_id=% uid=%', evt_name, req_id, uid_val;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Simbly trigger failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trigger_[table]_simbly_${uniqueSuffix}
  ${analysis.event_type === "INSERT" ? "AFTER INSERT" : analysis.event_type === "UPDATE" ? "AFTER UPDATE" : analysis.event_type === "DELETE" ? "AFTER DELETE" : "AFTER INSERT OR UPDATE OR DELETE"} ON public.[table]
  FOR EACH ROW EXECUTE FUNCTION public.handle_[table]_simbly_${uniqueSuffix}();

ALTER TABLE public.[table]
  ENABLE TRIGGER trigger_[table]_simbly_${uniqueSuffix};

====================================================================
AI INSTRUCTIONS:
====================================================================
1. Use resolve_table_name with hint: "${analysis.table_hint}"
2. Replace [table] with resolved table name
3. Replace [user_id_column] with correct column (user_id, id, etc.)
4. Include custom properties if requested: ${analysis.custom_properties.join(", ")}
5. ${analysis.needs_amount_currency ? "INCLUDE amount and currency" : "DO NOT include amount or currency"}
6. ${analysis.notification_mode === "admin" ? `Use fixed admin ID: '${adminUserId || "MISSING"}'` : "Use dynamic user ID from row"}`;

  let messages = [
    {
      role: "user",
      content: systemPrompt,
    },
  ];

  let response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8000,
    tools,
    messages,
  });

  console.log("🧠 Stop reason:", response.stop_reason);

  let iteration = 0;
  let generatedSQL = null;
  let executionResult = null;

  while (response.stop_reason === "tool_use" && iteration < 15) {
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break;

    console.log(
      `\n🔧 Iteration ${iteration + 1}: ${toolUses.map((t) => t.name).join(", ")}`,
    );

    messages.push({ role: "assistant", content: response.content });
    const toolResults = [];

    for (const toolUse of toolUses) {
      if (toolUse.name === "resolve_table_name") {
        const userRef = toolUse.input.user_table_reference;
        console.log(`🔍 Resolving table: "${userRef}"...`);
        const result = await resolveTableName(userRef);

        if (result.resolved) {
          console.log(`   ✅ Resolved: ${result.resolved}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              resolvedTable: result.resolved,
              confidence: result.confidence,
              explanation: result.explanation,
            }),
          });
        } else {
          console.error(`   ❌ ${result.error}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: JSON.stringify({ error: result.error }),
          });
        }
      } else if (toolUse.name === "get_database_schema") {
        console.log("📂 Fetching schema...");
        const schema = await getDatabaseSchema();
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: schema,
        });
      } else if (toolUse.name === "get_auth_user_id") {
        const tableName = toolUse.input.table_name;
        console.log(`🔐 Finding auth userId for: ${tableName}...`);

        try {
          const columns = await executeQuery(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = '${tableName}'
            ORDER BY ordinal_position;
          `);

          const columnNames = columns.map((c) => c.column_name);

          let strategy = null,
            exampleId = null;

          if (columnNames.includes("user_id")) {
            strategy = "use_user_id_column";
            console.log(`   ✅ Found user_id column`);
          } else if (columnNames.includes("id")) {
            strategy = "use_id_column";
            console.log(`   ✅ Using id column`);
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              table: tableName,
              columns: columnNames,
              strategy,
              newUserId:
                strategy === "use_user_id_column"
                  ? "NEW.user_id::text"
                  : "NEW.id::text",
              oldUserId:
                strategy === "use_user_id_column"
                  ? "OLD.user_id::text"
                  : "OLD.id::text",
            }),
          });
        } catch (error) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: JSON.stringify({ error: error.message }),
          });
        }
      } else if (toolUse.name === "get_existing_triggers") {
        const tableName = toolUse.input.table_name;
        console.log(`🔍 Checking triggers on ${tableName}...`);

        try {
          const existing = await executeQuery(`
            SELECT tgname AS trigger_name FROM pg_trigger t
            JOIN pg_class c ON t.tgrelid = c.oid
            WHERE c.relname = '${tableName}'
              AND c.relnamespace = 'public'::regnamespace
              AND NOT t.tgisinternal;
          `);
          console.log(`   Found ${existing.length} trigger(s)`);

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              table: tableName,
              existingTriggers: existing,
            }),
          });
        } catch (error) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ existingTriggers: [] }),
          });
        }
      } else if (toolUse.name === "execute_query") {
        let sql = toolUse.input.sql;

        // Block data modification
        const dangerousPatterns = [
          /^\s*UPDATE\s+(?!pg_)/i,
          /^\s*INSERT\s+INTO\s+(?!pg_)/i,
          /^\s*DELETE\s+FROM\s+(?!pg_)/i,
        ];

        let isBlocked = false;
        for (const line of sql.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("--")) continue;

          for (const pattern of dangerousPatterns) {
            if (trimmed.match(pattern)) {
              console.error("🚨 BLOCKED: Data modification!");
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                is_error: true,
                content: JSON.stringify({
                  error: "BLOCKED: Data modification not allowed.",
                }),
              });
              isBlocked = true;
              break;
            }
          }
          if (isBlocked) break;
        }

        if (isBlocked) continue;

        sql = sql
          .replace(/\\n/g, "\n")
          .replace(/^```sql\n?/gm, "")
          .replace(/^```\n?/gm, "")
          .trim();

        generatedSQL = sql;
        console.log("\n🚀 Deploying...");

        try {
          executionResult = await executeQuery(sql);
          console.log("✅ Deployed!");

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              success: true,
              message: "Trigger deployed! Test by updating a row.",
            }),
          });
        } catch (error) {
          console.error("❌ Failed:", error.message);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: JSON.stringify({ success: false, error: error.message }),
          });
        }
      }
    }

    messages.push({ role: "user", content: toolResults });

    response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 8000,
      tools,
      messages,
    });

    console.log("🧠 Stop reason:", response.stop_reason);
    iteration++;
  }

  let sql = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (generatedSQL) sql = generatedSQL;
  if (!sql) throw new Error("AI did not generate SQL");

  console.log("\n📦 Final SQL:");
  console.log("=".repeat(70));
  console.log(sql);
  console.log("=".repeat(70));

  if (executionResult) {
    console.log("\n✅ ULTIMATE TRIGGER DEPLOYED!");
    console.log(
      `   ✓ Mode: ${analysis.notification_mode === "admin" ? "🔔 ADMIN NOTIFICATION" : "👤 USER NOTIFICATION"}`,
    );
    console.log(`   ✓ Event: ${analysis.event_type}`);
    console.log(
      `   ✓ Amount/Currency: ${analysis.needs_amount_currency ? "Included" : "Not needed"}`,
    );
    if (analysis.custom_properties.length > 0) {
      console.log(
        `   ✓ Custom properties: ${analysis.custom_properties.join(", ")}`,
      );
    }
  }

  return {
    sql,
    executed: !!executionResult,
    executionResult,
    triggerSuffix: uniqueSuffix,
    analysis,
  };
}
