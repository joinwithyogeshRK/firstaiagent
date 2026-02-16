// server.js
import "dotenv/config";
import express from "express";
import { generateQuery } from "./agent.js";

const app = express();
app.use(express.json());

app.post("/generate-query", async (req, res) => {
  const startTime = Date.now();

  try {
    const { instruction } = req.body;

    if (!instruction) {
      return res.status(400).json({
        success: false,
        error: "Please provide an instruction",
      });
    }

    console.log("\n" + "=".repeat(70));
    console.log("🚀 NEW REQUEST");
    console.log("=".repeat(70));
    console.log("📝 Instruction:", instruction);
    console.log("⏰ Time:", new Date().toISOString());

    const result = await generateQuery(instruction);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log("\n" + "=".repeat(70));
    console.log("✅ REQUEST COMPLETED");
    console.log("=".repeat(70));
    console.log("⏱️  Duration:", duration, "seconds");
    console.log("🔄 Executed:", result.executed);
    console.log("📏 SQL length:", result.sql.length, "characters");

    res.json({
      success: true,
      instruction: instruction,
      query: result.sql,
      executed: result.executed,
      executionResult: result.executionResult,
      duration: `${duration}s`,
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.error("\n" + "=".repeat(70));
    console.error("❌ REQUEST FAILED");
    console.error("=".repeat(70));
    console.error("⏱️  Duration:", duration, "seconds");
    console.error("💥 Error:", error.message);

    res.status(500).json({
      success: false,
      error: error.message,
      duration: `${duration}s`,
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    mode: "auto-execute",
    env: {
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
      hasEdgeFunctionUrl: !!process.env.EDGE_FUNCTION_URL,
      hasServiceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      hasPersonalToken: !!process.env.PERSONAL_ACCESS_TOKEN,
      hasProjectRef: !!process.env.PROJECT_REF,
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(70));
  console.log("🚀 MIGRATION AGENT SERVER - AUTO-EXECUTE MODE");
  console.log("=".repeat(70));
  console.log("📍 URL:", `http://localhost:${PORT}`);
  console.log("📊 Health:", `http://localhost:${PORT}/health`);
  console.log("🔧 Endpoint:", `POST /generate-query`);
  console.log("⚡ Mode: All triggers are automatically deployed");
  console.log("=".repeat(70) + "\n");
});
