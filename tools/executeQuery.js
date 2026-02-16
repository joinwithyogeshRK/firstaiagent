// tools/executeQuery.js
const PERSONAL_ACCESS_TOKEN = process.env.PERSONAL_ACCESS_TOKEN;
const PROJECT_REF = process.env.PROJECT_REF;

export async function executeQuery(sql) {
  console.log("🔧 Executing SQL query in Supabase...");

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PERSONAL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: sql,
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to execute query: ${error}`); // Fixed: was using backtick wrong
  }

  const result = await response.json();
  console.log("✅ Query executed successfully");
  return result;
}
