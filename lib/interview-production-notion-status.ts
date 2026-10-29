import { campusPipelineId, type Campus } from "./interview-notion-contract";

const requiredTypes: Record<string, string> = {
  Email: "email", Stage: "select", "Next Step": "select", "Workflow Status": "select",
  "Interview Status": "select", "Interview Date": "date", "Interviewed By": "rich_text",
  "Scheduling Reservation ID": "rich_text", "Google Meet URL": "url",
};

/** Schema access only. Never queries or changes applicant records. */
export async function productionNotionStatus(transport: typeof fetch = fetch) {
  const token = process.env["INTERVIEW_NOTION_LIVE_TOKEN"] ?? "";
  return Promise.all((["BU", "BC"] as const).map(async (campus: Campus) => {
    const databaseId = campusPipelineId(campus);
    const base = { campus, databaseId, readable: false, schemaReady: false };
    if (token.length < 20) return { ...base, errorCode: "notion_not_configured" };
    try {
      const response = await transport("https://api.notion.com/v1/databases/" + databaseId, {
        headers: { Authorization: "Bearer " + token, "Notion-Version": "2022-06-28" },
        cache: "no-store", signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return { ...base, errorCode: response.status === 429 ? "notion_rate_limited" : "notion_access_unavailable" };
      const body = await response.json();
      if (body.object !== "database" || typeof body.id !== "string" ||
          body.id.replaceAll("-", "").toLowerCase() !== databaseId ||
          body.archived === true || body.in_trash === true || !body.properties) {
        return { ...base, errorCode: "notion_database_mismatch" };
      }
      const properties = body.properties as Record<string, {type?: string; select?: {options?: {name: string}[]}}>;
      const invalidFields = Object.entries(requiredTypes)
        .filter(([name, type]) => properties[name]?.type !== type).map(([name]) => name);
      const options: Record<string, string[]> = {
        Stage: ["Needs Interview"], "Next Step": ["Schedule interview"],
        "Interview Status": ["Not Scheduled", "Scheduled"],
        "Workflow Status": campus === "BU"
          ? ["Application Received", "Interview Needed", "Interview Scheduled"] : ["Application Received"],
      };
      for (const [name, expected] of Object.entries(options)) {
        const actual = properties[name]?.select?.options?.map(option => option.name) ?? [];
        if (expected.some(option => !actual.includes(option)) && !invalidFields.includes(name)) invalidFields.push(name);
      }
      return { ...base, readable: true, schemaReady: invalidFields.length === 0,
        invalidFields, errorCode: invalidFields.length ? "notion_schema_mismatch" : null };
    } catch { return { ...base, errorCode: "notion_check_unavailable" }; }
  }));
}
