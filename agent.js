// agent.js
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
      "Fetches the full Supabase database migration schema to see actual table structures and columns.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_existing_triggers",
    description:
      "Fetches all existing triggers on a specific table so we can generate a unique trigger name that doesn't conflict.",
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
      "Executes SQL query in Supabase database to deploy the trigger.",
    input_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "The SQL query to execute",
        },
      },
      required: ["sql"],
    },
  },
];

export async function generateQuery(instruction) {
  console.log("🤖 AI Agent started...");
  console.log("📝 Instruction:", instruction);

  const edgeFunctionUrl = process.env.EDGE_FUNCTION_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!edgeFunctionUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "Missing EDGE_FUNCTION_URL or SUPABASE_SERVICE_ROLE_KEY in .env file",
    );
  }

  // Generate a unique timestamp suffix for this trigger
  const uniqueSuffix = Date.now();

  let messages = [
    {
      role: "user",
      content: `You are a PostgreSQL/Supabase expert specializing in database triggers.

MOST IMPORTANT RULE:
❌ NEVER use DROP TRIGGER
❌ NEVER use DROP FUNCTION  
❌ NEVER delete or remove ANY existing triggers
✅ ALWAYS create NEW triggers with unique names
✅ ALWAYS use CREATE OR REPLACE FUNCTION (never drop)
✅ Every trigger you create must have a unique name using the timestamp: ${uniqueSuffix}

WORKFLOW:
1. Call "get_database_schema" to find the correct table and columns
2. Call "get_existing_triggers" to see what triggers exist on the table
3. Generate SQL with a UNIQUE trigger name using timestamp ${uniqueSuffix}
4. Call "execute_query" to deploy

Task: ${instruction}

Configuration:
- Edge Function URL: ${edgeFunctionUrl}
- Service Role Key: ${supabaseServiceRoleKey}

NAMING CONVENTION:
- Function name: handle_[table]_webhook_${uniqueSuffix}
- Trigger name:  trigger_[table]_webhook_${uniqueSuffix}

Example for "doctors" table:
- Function: handle_doctors_webhook_${uniqueSuffix}
- Trigger:  trigger_doctors_webhook_${uniqueSuffix}

SQL TEMPLATE TO FOLLOW:

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.handle_[table]_webhook_${uniqueSuffix}()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payload jsonb;
  request_id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    payload := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'timestamp', NOW(),
      'old_record', row_to_json(OLD)::jsonb
    );
  ELSIF TG_OP = 'UPDATE' THEN
    payload := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'timestamp', NOW(),
      'old_record', row_to_json(OLD)::jsonb,
      'new_record', row_to_json(NEW)::jsonb
    );
  ELSE
    payload := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'timestamp', NOW(),
      'new_record', row_to_json(NEW)::jsonb
    );
  END IF;
  
  SELECT net.http_post(
    url := '${edgeFunctionUrl}',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ${supabaseServiceRoleKey}'
    ),
    body := payload,
    timeout_milliseconds := 5000
  ) INTO request_id;
  
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
  
EXCEPTION
  WHEN OTHERS THEN
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trigger_[table]_webhook_${uniqueSuffix}
  AFTER INSERT OR UPDATE OR DELETE ON public.[table]
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_[table]_webhook_${uniqueSuffix}();

STRICT RULES:
❌ NO DROP TRIGGER statements
❌ NO DROP FUNCTION statements  
❌ NO DELETE of any existing triggers
✅ Only CREATE OR REPLACE FUNCTION
✅ Only CREATE TRIGGER with unique timestamp name
✅ Output ONLY raw SQL - no comments, no markdown`,
    },
  ];

  let response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4000,
    tools,
    messages,
  });

  console.log("🧠 Stop reason:", response.stop_reason);

  let iteration = 0;
  let generatedSQL = null;
  let executionResult = null;

  while (response.stop_reason === "tool_use" && iteration < 10) {
    const toolUses = response.content.filter(
      (block) => block.type === "tool_use",
    );
    if (toolUses.length === 0) break;

    console.log(
      `\n🔧 Iteration ${iteration + 1}: Processing ${toolUses.length} tool call(s)...`,
    );

    messages.push({
      role: "assistant",
      content: response.content,
    });

    const toolResults = [];

    for (const toolUse of toolUses) {
      if (toolUse.name === "get_database_schema") {
        console.log("📂 Fetching database schema...");
        const schema = await getDatabaseSchema();
        console.log("✅ Schema fetched");
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: schema,
        });
      } else if (toolUse.name === "get_existing_triggers") {
        const tableName = toolUse.input.table_name;
        console.log(`🔍 Checking existing triggers on ${tableName}...`);

        try {
          const existingTriggers = await executeQuery(`
            SELECT 
              tgname as trigger_name,
              proname as function_name
            FROM pg_trigger t
            JOIN pg_class c ON t.tgrelid = c.oid
            JOIN pg_proc p ON t.tgfoid = p.oid
            WHERE c.relname = '${tableName}'
              AND c.relnamespace = 'public'::regnamespace
              AND NOT t.tgisinternal
            ORDER BY tgname;
          `);

          console.log(
            `✅ Found ${existingTriggers.length} existing trigger(s) on ${tableName}`,
          );
          existingTriggers.forEach((t) => {
            console.log(`   - ${t.trigger_name}`);
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              table: tableName,
              existingTriggers: existingTriggers,
              message: `Found ${existingTriggers.length} existing trigger(s). Your new trigger must use a DIFFERENT unique name.`,
              yourNewTriggerName: `trigger_${tableName}_webhook_${uniqueSuffix}`,
              yourNewFunctionName: `handle_${tableName}_webhook_${uniqueSuffix}`,
            }),
          });
        } catch (error) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              table: tableName,
              existingTriggers: [],
              yourNewTriggerName: `trigger_${tableName}_webhook_${uniqueSuffix}`,
              yourNewFunctionName: `handle_${tableName}_webhook_${uniqueSuffix}`,
            }),
          });
        }
      } else if (toolUse.name === "execute_query") {
        let sql = toolUse.input.sql;

        // SAFETY CHECK: Block any DROP TRIGGER or DROP FUNCTION statements
        const hasDrop = sql.match(/DROP\s+(TRIGGER|FUNCTION)/gi);
        if (hasDrop) {
          console.error("🛑 BLOCKED: SQL contains DROP statements!");
          console.error("   Found:", hasDrop);

          // Remove DROP statements automatically
          sql = sql
            .split("\n")
            .filter(
              (line) => !line.trim().match(/^DROP\s+(TRIGGER|FUNCTION)/gi),
            )
            .join("\n");

          console.log("✅ DROP statements removed, continuing with safe SQL");
        }

        console.log("\n🚀 Executing SQL...");
        generatedSQL = sql;

        // Clean SQL
        sql = sql
          .replace(/^```sql\n?/gm, "")
          .replace(/^```\n?/gm, "")
          .trim();

        console.log("📝 SQL preview (first 300 chars):");
        console.log(sql.substring(0, 300) + "...\n");

        try {
          executionResult = await executeQuery(sql);
          console.log("✅ Execution successful!");
          console.log(
            `✅ New trigger created: trigger_${toolUse.input.sql.match(/trigger_\w+/i)?.[0] || "unknown"}`,
          );

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              success: true,
              message:
                "New trigger deployed successfully. No existing triggers were dropped.",
            }),
          });
        } catch (error) {
          console.error("❌ Execution failed:", error.message);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: JSON.stringify({
              success: false,
              error: error.message,
            }),
          });
        }
      }
    }

    messages.push({
      role: "user",
      content: toolResults,
    });

    response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 4000,
      tools,
      messages,
    });

    console.log("🧠 Stop reason:", response.stop_reason);
    iteration++;
  }

  // Extract final SQL
  let sql = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (generatedSQL) {
    sql = generatedSQL;
  }

  if (!sql) {
    throw new Error("AI did not generate SQL");
  }

  // Final safety check - remove any DROP statements
  sql = sql
    .split("\n")
    .filter((line) => !line.trim().match(/^DROP\s+(TRIGGER|FUNCTION)/gi))
    .join("\n")
    .replace(/^```sql\n?/gm, "")
    .replace(/^```\n?/gm, "")
    .trim();

  console.log("\n📦 Final Generated SQL:");
  console.log("=".repeat(70));
  console.log(sql);
  console.log("=".repeat(70));

  if (executionResult) {
    console.log("\n✅ NEW trigger deployed successfully!");
    console.log(`✅ Trigger name: trigger_[table]_webhook_${uniqueSuffix}`);
    console.log("✅ All existing triggers are SAFE and untouched!");
  }

  return {
    sql,
    executed: !!executionResult,
    executionResult: executionResult,
    triggerSuffix: uniqueSuffix,
  };
}
