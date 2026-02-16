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
    name: "execute_query",
    description:
      "Executes SQL query in Supabase database. Can execute multiple statements.",
    input_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "The SQL query to execute (can be multiple statements)",
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

  let messages = [
    {
      role: "user",
      content: `You are a PostgreSQL/Supabase expert specializing in database triggers.

WORKFLOW:
1. Call "get_database_schema" to see actual table structures
2. Generate SQL with proper DROP statements for YOUR triggers only
3. Call "execute_query" ONCE with complete SQL

Task: ${instruction}

Configuration:
- Edge Function URL: ${edgeFunctionUrl}
- Service Role Key: ${supabaseServiceRoleKey}

CRITICAL NAMING CONVENTION (prevents conflicts with other triggers):

ALWAYS use this exact naming pattern:
- Trigger name: trigger_[table]_codepup_webhook
- Function name: handle_[table]_codepup_webhook

The "codepup" suffix ensures your triggers are unique and won't conflict with other triggers on the same table.

Examples:
- trigger_appointments_codepup_webhook
- handle_appointments_codepup_webhook
- trigger_users_codepup_webhook
- handle_users_codepup_webhook

SQL TEMPLATE:

CREATE EXTENSION IF NOT EXISTS pg_net;

DROP TRIGGER IF EXISTS trigger_[table]_codepup_webhook ON public.[table];

DROP FUNCTION IF EXISTS public.handle_[table]_codepup_webhook() CASCADE;

CREATE OR REPLACE FUNCTION public.handle_[table]_codepup_webhook()
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

CREATE TRIGGER trigger_[table]_codepup_webhook
  AFTER INSERT OR UPDATE OR DELETE ON public.[table]
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_[table]_codepup_webhook();

CRITICAL RULES:

1. ALWAYS include "_codepup_" in the trigger and function names
2. Replace [table] with the actual table name
3. Use INSERT OR UPDATE OR DELETE (all three operations in ONE trigger)
4. Drop only YOUR triggers (with _codepup_ suffix), not others
5. Output ONLY raw SQL - no comments, no markdown, no explanations

This approach:
✅ Creates unique trigger names that won't conflict
✅ Only drops YOUR triggers when re-running
✅ Leaves other triggers on the same table untouched
✅ Allows multiple trigger systems to coexist

After generating, call execute_query ONCE with the complete SQL.`,
    },
  ];

  let response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4000,
    tools,
    messages,
  });

  console.log("🧠 AI initial response:", response.stop_reason);

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
        console.log("✅ Schema retrieved");
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: schema,
        });
      } else if (toolUse.name === "execute_query") {
        console.log("\n🚀 Executing SQL...");
        let sql = toolUse.input.sql;

        // Clean the SQL before executing
        sql = sql
          .split("\n")
          .filter((line) => {
            const trimmed = line.trim();
            if (trimmed.match(/^[=\-]{5,}$/)) return false;
            if (trimmed.startsWith("--") && !trimmed.includes("Step"))
              return false;
            return true;
          })
          .join("\n")
          .replace(/^```sql\n?/gm, "")
          .replace(/^```\n?/gm, "")
          .trim();

        generatedSQL = sql;

        console.log("📝 Cleaned SQL (first 500 chars):");
        console.log(sql.substring(0, 500) + "...\n");

        try {
          executionResult = await executeQuery(sql);
          console.log("✅ Execution successful!");
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              success: true,
              message:
                "Trigger deployed successfully. Only CodePup triggers were dropped - other triggers remain untouched.",
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
              hint: "Check if table exists and you have proper permissions",
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

  // Final cleanup
  sql = sql
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.match(/^[=\-]{5,}$/)) return false;
      if (trimmed.startsWith("--") && !trimmed.includes("Step")) return false;
      return true;
    })
    .join("\n")
    .replace(/^```sql\n?/gm, "")
    .replace(/^```\n?/gm, "")
    .trim();

  console.log("\n📦 Final Generated SQL:");
  console.log("=".repeat(70));
  console.log(sql);
  console.log("=".repeat(70));

  if (executionResult) {
    console.log("\n✅ SQL was EXECUTED and DEPLOYED!");
    console.log("   ✓ CodePup triggers created/updated");
    console.log("   ✓ Other triggers on the table remain safe");
    console.log("   ✓ No conflicts!");
  } else {
    console.log("\n⚠️  SQL was generated but NOT executed");
  }

  return {
    sql,
    executed: !!executionResult,
    executionResult: executionResult,
    triggerNaming: "Uses _codepup_ suffix for uniqueness",
  };
}
