// agent.js - CLEAN PAYLOAD VERSION
import Anthropic from "@anthropic-ai/sdk";
import { getDatabaseSchema } from "./tools/getDatabaseSchema.js";
import { executeQuery } from "./tools/executeQuery.js";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const tools = [
  {
    name: "get_database_schema",
    description:
      "Fetches the full Supabase database migration schema. Also returns a list of all available table names.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "resolve_table_name",
    description: `Intelligently resolves a user's table reference to the actual database table name.
    Examples:
    - "cart" → "cart_items"
    - "payment" → "payments"
    - "doctor" → "doctors"
    - "appointment" → "appointments"
    Call this FIRST before any other tools when the user mentions a table.`,
    input_schema: {
      type: "object",
      properties: {
        user_table_reference: {
          type: "string",
          description:
            "The table name the user mentioned (e.g., 'cart', 'payment', 'doctor')",
        },
      },
      required: ["user_table_reference"],
    },
  },
  {
    name: "get_auth_user_id",
    description: `Finds the correct auth user ID for a given table.
    Checks if the table has a user_id column that links to auth.users.
    ALWAYS call this before generating the trigger SQL.`,
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
      "Executes SQL query in Supabase database. ONLY for CREATE/ALTER statements, NEVER for INSERT/UPDATE/DELETE.",
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

  if (!edgeFunctionUrl || !supabaseAnonKey || !simblyIngestSecret) {
    throw new Error(
      "Missing one of: EDGE_FUNCTION_URL, SUPABASE_ANON_KEY, SIMBLY_INGEST_SECRET",
    );
  }

  const uniqueSuffix = Date.now();

  // Helper: Resolve table name using AI intelligence
  async function resolveTableName(userReference) {
    try {
      // Get all tables with their columns
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

      // Let AI decide the best match using Claude
      const aiResponse = await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `You are a database expert helping resolve table names.

User said: "${userReference}"

Available tables in database:
${tableInfo.map((t) => `- ${t.name} (columns: ${t.columns.join(", ")})`).join("\n")}

Task: Which table does the user most likely want?

Consider:
- Singular/plural variations (cart → cart_items, payment → payments)
- Related concepts (cart could mean cart_items, shopping_cart, user_carts)
- Column names (if table has "cart" in columns, it's cart-related)
- Context (payment → payments table with amount/status columns)

Respond with ONLY a JSON object:
{
  "table": "exact_table_name",
  "confidence": "high|medium|low",
  "reasoning": "brief explanation"
}

If NO good match exists, respond:
{
  "table": null,
  "confidence": "none",
  "reasoning": "No table matches '${userReference}'"
}`,
          },
        ],
      });

      const aiText = aiResponse.content
        .find((b) => b.type === "text")
        ?.text.trim();

      // Parse AI response
      let aiDecision;
      try {
        const cleaned = aiText
          .replace(/^```json\n?/gm, "")
          .replace(/^```\n?/gm, "")
          .trim();
        aiDecision = JSON.parse(cleaned);
      } catch {
        // Fallback if AI response isn't valid JSON
        return {
          resolved: null,
          error: `Could not parse AI decision. Available tables: ${tableInfo.map((t) => t.name).join(", ")}`,
        };
      }

      if (!aiDecision.table) {
        return {
          resolved: null,
          error: `${aiDecision.reasoning}. Available tables: ${tableInfo.map((t) => t.name).join(", ")}`,
        };
      }

      return {
        resolved: aiDecision.table,
        confidence: aiDecision.confidence,
        explanation: aiDecision.reasoning,
        exact: aiDecision.table === userReference,
      };
    } catch (error) {
      return { resolved: null, error: error.message };
    }
  }

  let messages = [
    {
      role: "user",
      content: `You are a PostgreSQL/Supabase expert specializing in database triggers.

🚨 CRITICAL SAFETY RULES:
====================================================================
1. ❌ NEVER write UPDATE, INSERT, DELETE queries on production tables
2. ❌ NEVER modify user data, payment data, or any production data
3. ✅ ONLY create triggers and functions
====================================================================

WORKFLOW (follow in EXACT order):
1. Call "resolve_table_name" — find the actual table name from user's reference
2. Call "get_database_schema" — understand ALL columns
3. Call "get_auth_user_id" — find userId column
4. Call "get_existing_triggers" — check what exists
5. Call "execute_query" — deploy trigger (CREATE only)
6. Tell user: "Trigger created on [actual_table_name]! Manually update a row to test."

Task: ${instruction}

====================================================================
EDGE FUNCTION AUTH:
====================================================================
URL: ${edgeFunctionUrl}
Headers:
  "Content-Type"    : "application/json"
  "Authorization"   : "Bearer ${supabaseAnonKey}"
  "x-simbly-secret" : "${simblyIngestSecret}"

====================================================================
PAYLOAD STRUCTURE - SUPER CLEAN:
====================================================================

{
  "event": "payments.updated",       ← table.operation
  "userId": "uuid-here",             ← auth user UUID
  "properties": {
    "id": "row-uuid",                ← PRIMARY KEY ONLY
    "operation": "UPDATE",           ← INSERT/UPDATE/DELETE
    "changed_field": "status",       ← which field changed (UPDATE only)
    "old_value": "pending",          ← old value (UPDATE only)
    "new_value": "completed",        ← new value (UPDATE only)
    "timestamp": "2024-01-01T...",
    
    // Add ONLY for payment/transaction tables:
    "amount": "100.00",
    "currency": "USD",
    "status": "completed"
  }
}

🚨 CRITICAL RULES FOR PROPERTIES:
❌ DO NOT include: event, userId, user_id, email, user_email, user_name
❌ DO NOT spread entire row_to_json(NEW)
✅ ONLY include: id, operation, changed_field, old/new values, timestamp
✅ For payments: also include amount, currency, status

====================================================================
SQL TEMPLATE - CLEAN PAYLOAD:
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

  -- ── Get row ID and user ID ───────────────────────────────────────────────
  IF TG_OP = 'DELETE' THEN
    uid_val := OLD.[user_id_column]::text;
    row_id  := OLD.id::text;
  ELSE
    uid_val := NEW.[user_id_column]::text;
    row_id  := NEW.id::text;
  END IF;

  IF uid_val IS NULL OR uid_val = '' THEN
    RAISE WARNING 'Simbly: no userId for % on %, skipping', TG_OP, TG_TABLE_NAME;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── Set event name ────────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    evt_name := TG_TABLE_NAME || '.created';
  ELSIF TG_OP = 'UPDATE' THEN
    evt_name := TG_TABLE_NAME || '.updated';
  ELSE
    evt_name := TG_TABLE_NAME || '.deleted';
  END IF;

  -- ── Detect changes (UPDATE only) ──────────────────────────────────────────
  IF TG_OP = 'UPDATE' THEN
    -- AI: Check important columns from schema
    -- Example for payments table:
    
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      changed_field := 'status';
      old_value     := COALESCE(OLD.status::text, '');
      new_value     := COALESCE(NEW.status::text, '');
      
      -- Only send for meaningful transitions
      IF NOT (OLD.status = 'pending' AND NEW.status IN ('completed', 'failed')) THEN
        RAISE LOG 'Simbly: Status change not meaningful, skipping';
        RETURN NEW;
      END IF;
    ELSE
      -- No meaningful change
      RAISE LOG 'Simbly: UPDATE but no important changes, skipping';
      RETURN NEW;
    END IF;
  END IF;

  -- ── Build CLEAN payload ───────────────────────────────────────────────────
  -- 🚨 CRITICAL: DO NOT include userId, email, or user_name in properties!
  --    They're already in the top-level event object
  
  payload := jsonb_build_object(
    'event',  evt_name,
    'userId', uid_val,
    'properties', jsonb_build_object(
      'id',            row_id,
      'operation',     TG_OP,
      'changed_field', changed_field,
      'old_value',     old_value,
      'new_value',     new_value,
      'timestamp',     NOW()
      -- AI: Add these ONLY for payment tables:
      -- 'amount',     NEW.amount::text,
      -- 'currency',   NEW.currency,
      -- 'status',     NEW.status::text
    )
  );

  -- ── Fire HTTP request ─────────────────────────────────────────────────────
  SELECT net.http_post(
    url     := '${edgeFunctionUrl}',
    headers := jsonb_build_object(
      'Content-Type',    'application/json',
      'Authorization',   'Bearer ${supabaseAnonKey}',
      'x-simbly-secret', '${simblyIngestSecret}'
    ),
    body    := payload,
    timeout_milliseconds := 5000
  ) INTO req_id;

  RAISE LOG 'Simbly: % req_id=% uid=% event=%', TG_OP, req_id, uid_val, evt_name;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Simbly trigger failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trigger_[table]_simbly_${uniqueSuffix}
  AFTER INSERT OR UPDATE OR DELETE ON public.[table]
  FOR EACH ROW EXECUTE FUNCTION public.handle_[table]_simbly_${uniqueSuffix}();

ALTER TABLE public.[table]
  ENABLE TRIGGER trigger_[table]_simbly_${uniqueSuffix};

====================================================================
AI INSTRUCTIONS:
====================================================================

1. Replace [table] with actual table name
2. Replace [user_id_column] with: user_id, id, or hardcoded UUID
3. For UPDATE: detect which column changed (status, amount, etc.)
4. Only send for MEANINGFUL changes:
   - Status: pending→completed ✅
   - Status: completed→completed ❌
5. For payment tables, add amount/currency/status to properties
6. For non-payment tables, remove those fields
7. 🚨 NEVER add userId, email, user_name to properties (they're top-level)

NAMING:
Function : handle_[table]_simbly_${uniqueSuffix}
Trigger  : trigger_[table]_simbly_${uniqueSuffix}`,
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
      // ── resolve_table_name ─────────────────────────────────────────────
      if (toolUse.name === "resolve_table_name") {
        const userRef = toolUse.input.user_table_reference;
        console.log(`🔍 Resolving table name: "${userRef}"...`);

        const result = await resolveTableName(userRef);

        if (result.resolved) {
          if (result.exact) {
            console.log(`   ✅ Exact match: ${result.resolved}`);
          } else {
            console.log(
              `   🧠 AI resolved: "${userRef}" → "${result.resolved}"`,
            );
            console.log(`   Confidence: ${result.confidence}`);
            console.log(`   Reasoning: ${result.explanation}`);
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              userReference: userRef,
              resolvedTable: result.resolved,
              confidence: result.confidence,
              exact: result.exact,
              explanation: result.explanation,
              message: `Proceeding with table: ${result.resolved}`,
            }),
          });
        } else {
          console.error(`   ❌ ${result.error}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: JSON.stringify({
              error: result.error,
              userReference: userRef,
            }),
          });
        }

        // ── get_database_schema ────────────────────────────────────────────
      } else if (toolUse.name === "get_database_schema") {
        console.log("📂 Fetching database schema...");
        const schema = await getDatabaseSchema();
        console.log("✅ Schema fetched");
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: schema,
        });

        // ── get_auth_user_id ───────────────────────────────────────────────
      } else if (toolUse.name === "get_auth_user_id") {
        const tableName = toolUse.input.table_name;
        console.log(`🔐 Finding auth userId for table: ${tableName}...`);

        try {
          const columns = await executeQuery(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = '${tableName}'
            ORDER BY ordinal_position;
          `);

          const columnNames = columns.map((c) => c.column_name);
          console.log(`   Columns: ${columnNames.join(", ")}`);

          // Find distinct status values
          let statusValues = [];
          if (columnNames.includes("status")) {
            const statuses = await executeQuery(`
              SELECT DISTINCT status FROM public.${tableName} WHERE status IS NOT NULL LIMIT 20;
            `).catch(() => []);
            statusValues = statuses.map((s) => s.status);
            console.log(`   Status values: ${statusValues.join(", ")}`);
          }

          const hasUserId = columnNames.includes("user_id");
          const hasId = columnNames.includes("id");

          let strategy = null,
            exampleId = null,
            explanation = "";

          if (hasUserId) {
            const link = await executeQuery(`
              SELECT p.user_id::text AS auth_user_id
              FROM public.${tableName} p
              JOIN auth.users u ON u.id = p.user_id LIMIT 1;
            `).catch(() => []);
            if (link.length > 0) {
              strategy = "use_user_id_column";
              exampleId = link[0].auth_user_id;
              explanation = "Use NEW.user_id::text";
              console.log(`   ✅ user_id → auth.users`);
            }
          }

          if (!strategy && hasId) {
            const link = await executeQuery(`
              SELECT t.id::text AS auth_user_id
              FROM public.${tableName} t
              JOIN auth.users u ON u.id = t.id LIMIT 1;
            `).catch(() => []);
            if (link.length > 0) {
              strategy = "use_id_column";
              exampleId = link[0].auth_user_id;
              explanation = "Use NEW.id::text";
              console.log(`   ✅ id → auth.users`);
            }
          }

          if (!strategy) {
            const admin = await executeQuery(`
              SELECT id::text AS auth_user_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
            `);
            if (admin.length > 0) {
              strategy = "use_fixed_admin_id";
              exampleId = admin[0].auth_user_id;
              explanation = `Hardcoded admin UUID: '${exampleId}'`;
              console.log(`   ⚠️  Fallback to admin user`);
            }
          }

          console.log(`   ✅ Trigger will apply to ALL ROWS in ${tableName}`);

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              table: tableName,
              columns: columnNames,
              strategy,
              exampleAuthUserId: exampleId,
              explanation,
              statusValues,
              newUserId:
                strategy === "use_user_id_column"
                  ? "NEW.user_id::text"
                  : strategy === "use_id_column"
                    ? "NEW.id::text"
                    : `'${exampleId}'`,
              oldUserId:
                strategy === "use_user_id_column"
                  ? "OLD.user_id::text"
                  : strategy === "use_id_column"
                    ? "OLD.id::text"
                    : `'${exampleId}'`,
            }),
          });
        } catch (error) {
          console.error("❌ get_auth_user_id failed:", error.message);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: JSON.stringify({ error: error.message }),
          });
        }

        // ── get_existing_triggers ──────────────────────────────────────────
      } else if (toolUse.name === "get_existing_triggers") {
        const tableName = toolUse.input.table_name;
        console.log(`🔍 Checking existing triggers on ${tableName}...`);

        try {
          const existing = await executeQuery(`
            SELECT tgname AS trigger_name FROM pg_trigger t
            JOIN pg_class c ON t.tgrelid = c.oid
            WHERE c.relname = '${tableName}'
              AND c.relnamespace = 'public'::regnamespace
              AND NOT t.tgisinternal
            ORDER BY tgname;
          `);
          console.log(`   Found ${existing.length} trigger(s)`);
          existing.forEach((t) => console.log(`   - ${t.trigger_name}`));

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              table: tableName,
              existingTriggers: existing,
              newTriggerName: `trigger_${tableName}_simbly_${uniqueSuffix}`,
              newFunctionName: `handle_${tableName}_simbly_${uniqueSuffix}`,
            }),
          });
        } catch (error) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ table: tableName, existingTriggers: [] }),
          });
        }

        // ── execute_query ──────────────────────────────────────────────────
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
              console.error("🚨 BLOCKED: Data modification query!");
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

        // Strip DROP statements
        if (sql.match(/DROP\s+(TRIGGER|FUNCTION)/gi)) {
          console.warn("🛑 Removing DROP statements...");
          sql = sql
            .split("\n")
            .filter((l) => !l.trim().match(/^DROP\s+(TRIGGER|FUNCTION)/gi))
            .join("\n");
        }

        sql = sql
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/^```sql\n?/gm, "")
          .replace(/^```\n?/gm, "")
          .trim();

        generatedSQL = sql;
        console.log("\n🚀 Deploying trigger...");

        try {
          executionResult = await executeQuery(sql);
          console.log("✅ Trigger deployed!");
          console.log("⚠️  Test by manually updating a row in your database");

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              success: true,
              message:
                "✅ Trigger deployed with clean payload! Test by updating a row.",
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

  // Extract final SQL
  let sql = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (generatedSQL) sql = generatedSQL;
  if (!sql) throw new Error("AI did not generate SQL");

  sql = sql
    .split("\n")
    .filter((l) => !l.trim().match(/^DROP\s+(TRIGGER|FUNCTION)/gi))
    .join("\n")
    .replace(/\\n/g, "\n")
    .replace(/^```sql\n?/gm, "")
    .replace(/^```\n?/gm, "")
    .trim();

  console.log("\n📦 Final SQL:");
  console.log("=".repeat(70));
  console.log(sql);
  console.log("=".repeat(70));

  if (executionResult) {
    console.log("\n✅ Simbly trigger DEPLOYED with CLEAN payload!");
    console.log("   ✓ Top level: event, userId");
    console.log(
      "   ✓ Properties: id, operation, changed_field, old/new values",
    );
    console.log("   ✓ NO duplicate userId/email in properties");
    console.log("   ✓ Minimal and efficient");
  }

  return {
    sql,
    executed: !!executionResult,
    executionResult,
    triggerSuffix: uniqueSuffix,
  };
}
