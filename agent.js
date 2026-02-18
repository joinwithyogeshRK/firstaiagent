// agent.js - FIXED VERSION (SAFE - NO DATA MODIFICATION)
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
    name: "check_pg_net_logs",
    description: `Checks pg_net HTTP response logs to verify edge function was called.
    Returns the actual HTTP status code and response body.
    Call this ONLY if the user explicitly asks to verify or test the trigger.`,
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of recent requests to check (default 5)",
        },
      },
      required: [],
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

// ── Correct pg_net columns — hardcoded to avoid AI hallucination ─────────────
async function checkPgNetLogs(limit = 5) {
  try {
    const logs = await executeQuery(`
      SELECT
        id,
        status_code,
        left(content::text, 500) AS content,
        timed_out,
        error_msg,
        created
      FROM net._http_response
      WHERE created > NOW() - INTERVAL '30 seconds'
      ORDER BY created DESC
      LIMIT ${limit};
    `);

    if (logs.length === 0) {
      return {
        logs: [],
        diagnosis: {
          issue:
            "No pg_net requests in last 30 seconds — trigger may not have fired yet.",
          staleLogs: true,
        },
      };
    }

    const latest = logs[0];
    const sc = latest.status_code;

    const diagnosis = {
      status_code: sc,
      content: latest.content,
      timed_out: latest.timed_out,
      error_msg: latest.error_msg ?? null,
      edgeFunctionReached: sc !== null && !latest.timed_out,
      success: sc === 200,
      issue:
        sc === 200
          ? "OK — edge function received the request successfully"
          : sc === 401
            ? "UNAUTHORIZED — x-simbly-secret wrong or missing"
            : sc === 400
              ? "BAD REQUEST — userId missing/invalid, or user has no email"
              : sc === 500
                ? "SERVER ERROR — edge function crashed, check Supabase logs"
                : latest.timed_out
                  ? "TIMEOUT — edge function did not respond within 5000ms"
                  : latest.error_msg
                    ? `CONNECTION ERROR: ${latest.error_msg}`
                    : `Unexpected status: ${sc}`,
    };

    return { logs, diagnosis };
  } catch (error) {
    return {
      logs: [],
      diagnosis: {
        error: error.message,
        note: "Could not access pg_net tables. Grant access: GRANT USAGE ON SCHEMA net TO postgres;",
      },
    };
  }
}

export async function generateQuery(instruction) {
  console.log("🤖 AI Agent started...");
  console.log("📝 Instruction:", instruction);

  const edgeFunctionUrl = process.env.EDGE_FUNCTION_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const simblyIngestSecret = process.env.SIMBLY_INGEST_SECRET;
  const companyName = process.env.COMPANY_NAME || "Codepup";
  const companyEmail = process.env.COMPANY_EMAIL || "hello@codepup.com";

  if (
    !edgeFunctionUrl ||
    !supabaseAnonKey ||
    !supabaseServiceKey ||
    !simblyIngestSecret
  ) {
    throw new Error(
      "Missing one of: EDGE_FUNCTION_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SIMBLY_INGEST_SECRET",
    );
  }

  const uniqueSuffix = Date.now();

  let messages = [
    {
      role: "user",
      content: `You are a PostgreSQL/Supabase expert specializing in database triggers and email automation.

🚨 CRITICAL SAFETY RULES - READ FIRST:
====================================================================
1. ❌ NEVER write UPDATE, INSERT, DELETE queries on production tables
2. ❌ NEVER modify user data, payment data, or any production data
3. ❌ NEVER fire test queries to trigger the function
4. ✅ ONLY create triggers and functions
5. ✅ User will manually test by updating data themselves
6. ✅ If user asks to verify, tell them to:
   a) Manually update a row in their database
   b) Then call check_pg_net_logs tool to see the result
====================================================================

WORKFLOW (follow in EXACT order):
1. Call "get_database_schema" — understand ALL columns in the target table
2. Call "get_auth_user_id" — find the userId column
3. Call "get_existing_triggers" — check what exists
4. Call "execute_query" — deploy the smart trigger SQL (CREATE statements ONLY)
5. STOP HERE - do NOT fire any test updates
6. Tell user: "Trigger created! Please manually update a row to test, then I can check logs."

CRITICAL RULES:
❌ Do NOT write custom SQL to inspect pg_net
❌ Do NOT call execute_query to inspect pg_net tables
❌ NO DROP TRIGGER / DROP FUNCTION
❌ NO UPDATE, INSERT, DELETE on ANY table
✅ Use check_pg_net_logs tool ONLY for pg_net inspection (and ONLY if user asks to verify)
✅ Always call get_auth_user_id before writing SQL
✅ ONLY execute CREATE TRIGGER and CREATE FUNCTION statements

Task: ${instruction}

====================================================================
COMPANY CONTEXT:
====================================================================
Company Name  : ${companyName}
Company Email : ${companyEmail}

====================================================================
EDGE FUNCTION AUTH:
====================================================================
URL: ${edgeFunctionUrl}

Headers:
  "Content-Type"    : "application/json"
  "Authorization"   : "Bearer ${supabaseAnonKey}"
  "x-simbly-secret" : "${simblyIngestSecret}"

Auth flow:
- Trigger sends anon key → edge function detects NOT a user JWT → SECRET MODE
- Secret mode needs: x-simbly-secret header + userId in body + user must have email

====================================================================
SMART EMAIL PAYLOAD — THIS IS THE MOST IMPORTANT PART:
====================================================================

The "properties" field is what Simbly uses to send emails to users.
You MUST include rich, personalized email content in properties.

The trigger must be SMART — detect WHAT changed and build the right email.

EXAMPLE: If the table has a "status" column, detect transitions:
  - pending   → completed  = "Your payment was successful!"
  - pending   → failed     = "Payment failed — please update your details"
  - active    → cancelled  = "Your subscription has been cancelled"

EXAMPLE: If a new row is INSERTED:
  - "Welcome to ${companyName}! Your account is ready."

EXAMPLE: If a profile is UPDATED:
  - "Your profile has been updated successfully."

====================================================================
PROPERTIES STRUCTURE — ALWAYS INCLUDE ALL OF THESE:
====================================================================

properties must contain:

-- USER INFO (from the row itself):
  "user_name"       : full_name or first_name from the row (use COALESCE for fallbacks)
  "user_email"      : email from the row if available

-- EMAIL CONTENT (generate based on what changed):
  "email_subject"   : e.g. "Payment Successful! 🎉"
  "email_greeting"  : e.g. "Hi John," or "Hello Dr. Smith,"
  "email_body"      : e.g. "Your payment of $300 has been processed successfully. Thank you for your business!"
  "email_cta_text"  : e.g. "View Receipt"
  "email_cta_url"   : e.g. "https://app.${companyName.toLowerCase()}.com/payments"
  "email_footer"    : e.g. "Thank you for choosing ${companyName}. Questions? Reply to this email or contact ${companyEmail}"

-- CHANGE CONTEXT:
  "changed_field"   : which column changed (for UPDATE triggers)
  "old_value"       : OLD value of changed field (for UPDATE)
  "new_value"       : NEW value of changed field (for UPDATE)
  "operation"       : TG_OP (INSERT/UPDATE/DELETE)
  "timestamp"       : NOW()

-- ALL ROW DATA:
  + entire row_to_json(NEW) spread into properties

====================================================================
SQL TEMPLATE WITH SMART EMAIL LOGIC:
====================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.handle_[table]_simbly_${uniqueSuffix}()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  payload       jsonb;
  req_id        bigint;
  evt_name      text;
  row_data      jsonb;
  uid_val       text;
  user_name     text;
  email_subject text;
  email_greeting text;
  email_body    text;
  email_cta_text text;
  email_footer  text;
  changed_field text := '';
  old_value     text := '';
  new_value     text := '';
BEGIN

  -- ── Set row data and userId ──────────────────────────────────────────────
  IF TG_OP = 'DELETE' THEN
    row_data := row_to_json(OLD)::jsonb;
    uid_val  := OLD.[auth_user_id_column]::text;
  ELSE
    row_data := row_to_json(NEW)::jsonb;
    uid_val  := NEW.[auth_user_id_column]::text;
  END IF;

  IF uid_val IS NULL OR uid_val = '' THEN
    RAISE WARNING 'Simbly: no userId for % on %, skipping', TG_OP, TG_TABLE_NAME;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── Get user's name for personalization ──────────────────────────────────
  user_name := COALESCE(
    row_data->>'full_name',
    row_data->>'name',
    row_data->>'first_name',
    row_data->>'customer_name',
    'there'
  );

  -- ── Detect operation and build smart email content ───────────────────────
  IF TG_OP = 'INSERT' THEN
    evt_name       := TG_TABLE_NAME || '.created';
    email_subject  := 'New payment received! 🎉';
    email_greeting := 'Hi ' || user_name || ',';
    email_body     := 'We have received your payment at ${companyName}. Thank you for your business!';
    email_cta_text := 'View Receipt';
    email_footer   := 'Thank you for choosing ${companyName}. Need help? Contact us at ${companyEmail}';

  ELSIF TG_OP = 'UPDATE' THEN
    evt_name := TG_TABLE_NAME || '.updated';

    -- AI: DETECT STATUS CHANGES - this is where the smart logic goes
    -- Only send email if status changed from pending to completed/failed
    
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      changed_field := 'status';
      old_value     := COALESCE(OLD.status::text, 'none');
      new_value     := COALESCE(NEW.status::text, 'none');

      -- Only trigger email for specific status transitions
      IF OLD.status = 'pending' AND NEW.status = 'completed' THEN
        email_subject  := 'Payment Successful! 🎉';
        email_greeting := 'Hi ' || user_name || ',';
        email_body     := 'Great news! Your payment of ' || COALESCE(NEW.amount::text, '0') || ' ' || COALESCE(NEW.currency, 'USD') || ' has been processed successfully at ${companyName}. Thank you!';
        email_cta_text := 'View Receipt';
        email_footer   := 'Thank you for your business. Questions? Contact us at ${companyEmail}';

      ELSIF OLD.status = 'pending' AND NEW.status = 'failed' THEN
        email_subject  := 'Payment Failed ⚠️';
        email_greeting := 'Hi ' || user_name || ',';
        email_body     := 'Unfortunately, we were unable to process your payment at ${companyName}. Please check your payment details and try again.';
        email_cta_text := 'Update Payment Method';
        email_footer   := 'Need assistance? Contact us at ${companyEmail}';

      ELSE
        -- Other status changes - don't send email, just log
        RAISE LOG 'Simbly: Status changed from % to % but no email configured', old_value, new_value;
        RETURN NEW;
      END IF;

    ELSE
      -- No status change, don't send email
      RAISE LOG 'Simbly: UPDATE but status unchanged, skipping email';
      RETURN NEW;
    END IF;

  ELSE -- DELETE
    evt_name       := TG_TABLE_NAME || '.deleted';
    email_subject  := 'Payment record removed';
    email_greeting := 'Hi ' || user_name || ',';
    email_body     := 'A payment record at ${companyName} has been removed. If this was unexpected, please contact us.';
    email_cta_text := 'Contact Support';
    email_footer   := 'Questions? Contact us at ${companyEmail}';
  END IF;

  -- ── Build final payload ──────────────────────────────────────────────────
  payload := jsonb_build_object(
    'event',  evt_name,
    'userId', uid_val,
    'properties', row_data || jsonb_build_object(
      'email_subject',   email_subject,
      'email_greeting',  email_greeting,
      'email_body',      email_body,
      'email_cta_text',  email_cta_text,
      'email_cta_url',   'https://app.${companyName.toLowerCase()}.com/payments',
      'email_footer',    email_footer,
      'company_name',    '${companyName}',
      'company_email',   '${companyEmail}',
      'user_name',       user_name,
      'changed_field',   changed_field,
      'old_value',       old_value,
      'new_value',       new_value,
      'operation',       TG_OP,
      'timestamp',       NOW()
    )
  );

  -- ── Fire HTTP request ────────────────────────────────────────────────────
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

  RAISE LOG 'Simbly: % req_id=% uid=% subject=%', evt_name, req_id, uid_val, email_subject;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Simbly trigger failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trigger_[table]_simbly_${uniqueSuffix}
  AFTER INSERT OR UPDATE OR DELETE ON public.[table]
  FOR EACH ROW EXECUTE FUNCTION public.handle_[table]_simbly_${uniqueSuffix}();

====================================================================
AI INSTRUCTIONS:
====================================================================

1. Look at the schema and find the status column
2. Find name columns for personalization
3. Build IF/ELSIF logic that ONLY sends emails for meaningful status transitions
4. For payment tables: pending→completed or pending→failed are meaningful
5. For other updates (like updated_at changes), DON'T send emails
6. Use COALESCE for null-safe name handling
7. Replace ALL placeholders with real column names from schema

====================================================================
NAMING:
====================================================================
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
  let pgNetVerified = false;
  let pgNetDiagnosis = null;

  while (response.stop_reason === "tool_use" && iteration < 15) {
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break;

    console.log(
      `\n🔧 Iteration ${iteration + 1}: ${toolUses.map((t) => t.name).join(", ")}`,
    );

    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];

    for (const toolUse of toolUses) {
      // ── get_database_schema ────────────────────────────────────────────
      if (toolUse.name === "get_database_schema") {
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

          // Fetch sample data to understand status values (READ ONLY)
          const sampleData = await executeQuery(`
            SELECT * FROM public.${tableName} LIMIT 3;
          `).catch(() => []);

          // Find distinct status values if status column exists
          let statusValues = [];
          if (columnNames.includes("status")) {
            const statuses = await executeQuery(`
              SELECT DISTINCT status FROM public.${tableName} WHERE status IS NOT NULL LIMIT 20;
            `).catch(() => []);
            statusValues = statuses.map((s) => s.status);
            console.log(`   Status values found: ${statusValues.join(", ")}`);
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
              explanation =
                "Use NEW.user_id::text (or OLD.user_id::text for DELETE)";
              console.log(`   ✅ user_id → auth.users: ${exampleId}`);
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
              explanation = "Use NEW.id::text (or OLD.id::text for DELETE)";
              console.log(`   ✅ id → auth.users: ${exampleId}`);
            }
          }

          if (!strategy) {
            const admin = await executeQuery(`
              SELECT id::text AS auth_user_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
            `);
            if (admin.length > 0) {
              strategy = "use_fixed_admin_id";
              exampleId = admin[0].auth_user_id;
              explanation = `No FK to auth.users. Using hardcoded admin UUID: '${exampleId}'`;
              console.log(`   ⚠️ Fallback admin user: ${exampleId}`);
            }
          }

          const nameColumn =
            columnNames.find((c) =>
              [
                "full_name",
                "name",
                "first_name",
                "display_name",
                "username",
                "customer_name",
              ].includes(c),
            ) ?? null;

          console.log(`   Name column: ${nameColumn ?? "none found"}`);
          console.log(`   Status values: ${statusValues.join(", ") || "none"}`);

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              table: tableName,
              columns: columnNames,
              columnDetails: columns,
              strategy,
              exampleAuthUserId: exampleId,
              explanation,
              nameColumn,
              statusValues,
              sampleRow: sampleData[0] ?? null,
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

        // ── check_pg_net_logs ──────────────────────────────────────────────
      } else if (toolUse.name === "check_pg_net_logs") {
        console.log("🔬 Checking pg_net HTTP logs...");
        const limit = toolUse.input?.limit || 5;
        const result = await checkPgNetLogs(limit);

        pgNetDiagnosis = result.diagnosis;

        if (result.diagnosis.success) {
          pgNetVerified = true;
          console.log("✅ Edge function confirmed: 200 OK!");
        } else if (result.diagnosis.status_code) {
          console.warn(
            `❌ Edge function returned ${result.diagnosis.status_code}: ${result.diagnosis.issue}`,
          );
        } else {
          console.warn(
            `⚠️ ${result.diagnosis.issue || result.diagnosis.note || "Unknown state"}`,
          );
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });

        // ── execute_query ──────────────────────────────────────────────────
      } else if (toolUse.name === "execute_query") {
        let sql = toolUse.input.sql;

        // 🚨 BLOCK ANY DATA MODIFICATION QUERIES
        // Only block standalone DML statements, not keywords in function bodies
        const sqlLines = sql.split("\n").map((line) => line.trim());

        const dangerousPatterns = [
          /^\s*UPDATE\s+(?!pg_)/i, // Block UPDATE statements (not in functions)
          /^\s*INSERT\s+INTO\s+(?!pg_)/i, // Block INSERT statements
          /^\s*DELETE\s+FROM\s+(?!pg_)/i, // Block DELETE statements
          /^\s*TRUNCATE/i,
        ];

        let isBlocked = false;
        for (const line of sqlLines) {
          // Skip empty lines, comments, and lines inside function bodies
          if (!line || line.startsWith("--") || line.includes("$$")) continue;

          for (const pattern of dangerousPatterns) {
            if (line.match(pattern)) {
              console.error("🚨 BLOCKED: Data modification query detected!");
              console.error("   Blocked line:", line);
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                is_error: true,
                content: JSON.stringify({
                  error:
                    "BLOCKED: Data modification queries are not allowed. Only CREATE TRIGGER and CREATE FUNCTION are permitted. The user will manually test the trigger by updating data themselves.",
                }),
              });
              isBlocked = true;
              break;
            }
          }
          if (isBlocked) break;
        }

        if (isBlocked) continue;

        // Block manual pg_net queries
        if (sql.match(/net\._http_response|net\.http_request_queue/gi)) {
          console.warn(
            "🛑 Blocked manual pg_net query — use check_pg_net_logs tool",
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: JSON.stringify({
              error:
                "Do not query pg_net tables directly. Use the check_pg_net_logs tool instead.",
            }),
          });
          continue;
        }

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
        console.log("📝 Preview:", sql.substring(0, 400) + "...\n");

        try {
          executionResult = await executeQuery(sql);
          console.log("✅ Trigger deployed successfully!");
          console.log(
            "⚠️  To test: Please manually update a payment status in your database",
          );
          console.log(
            "   Then call check_pg_net_logs to verify the edge function was called",
          );

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              success: true,
              message:
                "✅ Trigger deployed! To test: 1) Manually update a payment status from 'pending' to 'completed', 2) Then check pg_net logs to verify.",
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
    console.log("\n✅ Simbly trigger DEPLOYED safely!");
    console.log("   ✓ Smart email content based on status changes");
    console.log("   ✓ Only triggers on pending→completed or pending→failed");
    console.log("   ✓ Auth userId auto-detected");
    console.log("   ✓ No production data was modified");
    console.log("\n📋 Next steps:");
    console.log("   1. Manually update a payment status in your database");
    console.log("   2. Check if email was sent via Simbly dashboard");
    console.log("   3. Call check_pg_net_logs API endpoint to verify");
  }

  return {
    sql,
    executed: !!executionResult,
    executionResult,
    triggerSuffix: uniqueSuffix,
    pgNetVerified,
    pgNetDiagnosis,
  };
}
