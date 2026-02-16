// tools/getDatabaseSchema.js

const PERSONAL_ACCESS_TOKEN = process.env.PERSONAL_ACCESS_TOKEN;
const PROJECT_REF = process.env.PROJECT_REF;

export async function getDatabaseSchema() {
  const listResponse = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/migrations`,
    {
      headers: {
        Authorization: `Bearer ${PERSONAL_ACCESS_TOKEN}`,
      },
    },
  );

  if (!listResponse.ok) {
    throw new Error("Failed to fetch migrations list");
  }

  const migrations = await listResponse.json();

  let fullSchema = "";

  for (const migration of migrations) {
    const detailResponse = await fetch(
      `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/migrations/${migration.version}`,
      {
        headers: {
          Authorization: `Bearer ${PERSONAL_ACCESS_TOKEN}`,
        },
      },
    );

    if (!detailResponse.ok) continue;

    const detail = await detailResponse.json();

    if (detail.statements && Array.isArray(detail.statements)) {
      fullSchema += `\n-- Migration: ${migration.version}\n`;
      fullSchema += detail.statements.join("\n") + "\n";
    }
  }

  return fullSchema;
}
