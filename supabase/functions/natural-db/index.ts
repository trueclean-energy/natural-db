import { createOpenAI } from "npm:@ai-sdk/openai";
import { generateText, tool, experimental_createMCPClient } from "npm:ai";
import { z } from "npm:zod";
import { 
  executeSQL, 
  convertBigIntsToStrings,
  loadRecentAndRelevantMessages,
  insertMessage,
  generateEmbedding
} from "../_shared/db-utils.ts";
import { createClient } from "npm:@supabase/supabase-js";

/**
 * Simple AI DB Handler - Public Schema Only
 *
 * This handler operates only within the public PostgreSQL schema.
 * It provides SQL execution, scheduling capabilities, and now handles
 * message insertion and retrieval for all platforms.
 *
 * Architecture:
 * - Always operates within the public schema
 * - Handles message persistence and retrieval
 * - Provides SQL execution and scheduling capabilities
 * - No vector search or embedding functionality in tools (handled internally)
 * - Passes through metadata without requiring specific fields
 */

// --- Environment Variables ---
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
const openaiModel = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
const zapierMcpUrl = Deno.env.get("ZAPIER_MCP_URL");

if (!supabaseUrl || !supabaseServiceRoleKey || !openaiApiKey) {
  console.error("Missing required env vars for Simple AI DB Handler.");
}

// Note: zapierMcpUrl is optional - MCP features will be disabled if not provided
if (!zapierMcpUrl) {
  console.warn(
    "Simple AI DB Handler: ZAPIER_MCP_URL not defined. Zapier MCP tools won't be available."
  );
}

const openai = createOpenAI({
  apiKey: openaiApiKey,
  compatibility: "strict"
});

// Initialize Supabase client for message operations
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const MAX_CHAT_HISTORY = 10; // Max number of previous messages to load
const MAX_RELEVANT_MESSAGES = 5; // Max number of semantically relevant messages to include

async function getActiveCronJobDetails() {
  const result = await executeSQL(
    "SELECT jobname, schedule FROM cron.job WHERE active = true ORDER BY jobname;"
  );

  if (result.error) {
    return result;
  }

  console.log(
    `Simple AI DB Handler: Found ${result.result.length} active scheduled routines`
  );
  return { result: result.result };
}

async function getPublicSchemaDetails() {
  const query = `
    SELECT jsonb_agg(row_to_json(info)) as columns
    FROM (
        SELECT
            isc.table_name,
            isc.column_name,
            isc.data_type,
            isc.udt_name,
            obj_description(pgc.oid) as table_comment,
            col_description(pgc.oid, isc.ordinal_position) as column_comment
        FROM
            information_schema.columns isc
        LEFT JOIN pg_class pgc ON pgc.relname = isc.table_name
        LEFT JOIN pg_namespace pgn ON pgn.oid = pgc.relnamespace AND pgn.nspname = isc.table_schema
        WHERE
            isc.table_schema = 'public'
        ORDER BY
            isc.table_name,
            isc.ordinal_position
    ) AS info;
  `;

  const operationResult = await executeSQL(query);

  if (operationResult.error) {
    return {
      error: `Failed to fetch public schema details: ${operationResult.error}`,
    };
  }

  const schemaContents =
    operationResult.result.length > 0 ? operationResult.result[0] : null;
  if (
    schemaContents === null ||
    !schemaContents.columns ||
    schemaContents.columns.length === 0
  ) {
    return {
      schemaDetails: `Public schema exists but contains no tables/columns yet.`,
    };
  }

  const schemaData = schemaContents.columns;
  let formattedString = `\nDetails of the current database schema ('public'):\n`;
  const tables: any = {};

  schemaData.forEach((col: any) => {
    const tableName = col.table_name;
    if (!tables[tableName]) {
      tables[tableName] = {
        columns: [],
        comment: col.table_comment,
      };
    }
    tables[tableName].columns.push({
      name: col.column_name,
      type: col.data_type,
      udt_name: col.udt_name,
      comment: col.column_comment,
    });
  });

  for (const tableName in tables) {
    const table = tables[tableName];
    formattedString += `  Table: ${tableName}`;
    if (table.comment) {
      formattedString += ` - ${table.comment}`;
    }
    formattedString += `\n`;
    table.columns.forEach((col: any) => {
      let columnDesc = `    - ${col.name}: ${col.type}`;
      if (col.udt_name && col.type !== col.udt_name) {
        if (col.type === "USER-DEFINED")
          columnDesc += ` (actual type: ${col.udt_name})`;
        else if (col.type === "ARRAY" && col.udt_name.startsWith("_"))
          columnDesc += ` (elements are ${col.udt_name.substring(1)})`;
        else columnDesc += ` (internal UDT: ${col.udt_name})`;
      }
      if (col.comment) {
        columnDesc += ` - ${col.comment}`;
      }
      formattedString += `${columnDesc}\n`;
    });
  }

  return {
    schemaDetails: formattedString,
  };
}

Deno.serve(async (req) => {
  console.log(
    `Simple AI DB Handler: Request received: ${req.method} ${req.url}`
  );

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
    });
  }

  let userPrompt: string;
  let id: string;
  let userId: string;
  let metadata: any;
  let timezone: string;
  let chatHistory: any[] = [];
  let relevantContext: any[] = [];
  let incomingMessageRole: string;
  let callbackUrl: string;
  let mcpClient: any = null;
  let mcpTools: any = {};

  // Derive the callback URL for cron jobs from the current request
  const cronCallbackUrl = `${supabaseUrl}/functions/v1/natural-db`;

  console.log(
    `Simple AI DB Handler: Using cron callback URL: ${cronCallbackUrl}`
  );

  try {
    const body = await req.json();
    console.log(
      "Simple AI DB Handler: Received Payload:",
      JSON.stringify(body, null, 2)
    );

    userPrompt = body.userPrompt;
    id = body.id;
    userId = body.userId || body.metadata?.userId; // Support direct userId or fallback to metadata
    metadata = body.metadata || {};
    timezone = body.timezone;
    incomingMessageRole = body.incomingMessageRole;
    callbackUrl = body.callbackUrl;

    if (
      !userPrompt ||
      !id ||
      !userId ||
      !incomingMessageRole ||
      !callbackUrl
    ) {
      console.error(
        "Simple AI DB Handler: Missing critical data (userPrompt, id, userId, incomingMessageRole, or callbackUrl).",
        body
      );
      return new Response("Invalid request body", {
        status: 400,
      });
    }

    // Load message history from database and handle message saving based on role
    if (incomingMessageRole !== "system_routine_task") {
      try {
        console.log(`Simple AI DB Handler: Loading message history for chat ID ${id}`);
        const messageHistory = await loadRecentAndRelevantMessages(
          supabase,
          userId,
          userPrompt,
          MAX_CHAT_HISTORY,
          MAX_RELEVANT_MESSAGES,
          id
        );
        
        chatHistory = messageHistory.chronologicalMessages || [];
        relevantContext = messageHistory.relevantContext || [];
        
        console.log(`Simple AI DB Handler: Loaded ${chatHistory.length} chronological messages and ${relevantContext.length} relevant context messages`);
      } catch (error) {
        console.error("Simple AI DB Handler: Error loading message history:", error);
        // Continue with empty history if loading fails
        chatHistory = [];
        relevantContext = [];
      }

      // Save the incoming user message to database
      try {
        console.log(`Simple AI DB Handler: Saving incoming message for chat ID ${id}`);
        
        // Generate embedding for the user message
        let embedding: string | undefined;
        try {
          embedding = await generateEmbedding(userPrompt);
          console.log(`Simple AI DB Handler: Generated embedding for user message`);
        } catch (embeddingError) {
          console.warn(
            `Simple AI DB Handler: Could not generate embedding for user message, saving without embedding:`,
            embeddingError
          );
        }

        const insertResult = await insertMessage(
          supabase,
          userId,
          userPrompt,
          incomingMessageRole,
          id,
          embedding
        );

        if (insertResult.error) {
          console.error(
            `Simple AI DB Handler: Error saving user message:`,
            insertResult.error
          );
        } else {
          console.log(
            `Simple AI DB Handler: Saved user message for chat ID ${id}`
          );
        }
      } catch (error) {
        console.error(`Simple AI DB Handler: Failed to save user message:`, error);
      }
    } else {
      // For system routine tasks, load message history to provide context and save the routine task
      try {
        console.log(`Simple AI DB Handler: Loading message history for system routine task, chat ID ${id}`);
        const messageHistory = await loadRecentAndRelevantMessages(
          supabase,
          userId,
          userPrompt,
          MAX_CHAT_HISTORY,
          MAX_RELEVANT_MESSAGES,
          id
        );
        
        chatHistory = messageHistory.chronologicalMessages || [];
        relevantContext = messageHistory.relevantContext || [];
        
        console.log(`Simple AI DB Handler: Loaded ${chatHistory.length} chronological messages and ${relevantContext.length} relevant context messages for system routine`);
      } catch (error) {
        console.error("Simple AI DB Handler: Error loading message history for system routine:", error);
        // Continue with empty history if loading fails
        chatHistory = [];
        relevantContext = [];
      }

      // Save the system routine task message
      try {
        console.log(`Simple AI DB Handler: Saving system routine task for chat ID ${id}`);
        
        // Generate embedding for the system routine task
        let embedding: string | undefined;
        try {
          embedding = await generateEmbedding(userPrompt);
          console.log(`Simple AI DB Handler: Generated embedding for system routine task`);
        } catch (embeddingError) {
          console.warn(
            `Simple AI DB Handler: Could not generate embedding for system routine task, saving without embedding:`,
            embeddingError
          );
        }

        const insertResult = await insertMessage(
          supabase,
          userId,
          userPrompt,
          incomingMessageRole,
          id,
          embedding
        );

        if (insertResult.error) {
          console.error(
            `Simple AI DB Handler: Error saving system routine task:`,
            insertResult.error
          );
        } else {
          console.log(
            `Simple AI DB Handler: Saved system routine task for chat ID ${id}`
          );
        }
      } catch (error) {
        console.error(`Simple AI DB Handler: Failed to save system routine task:`, error);
      }
    }

    if (zapierMcpUrl) {
      try {
        console.log("Simple AI DB Handler: Initializing Zapier MCP client...");
        mcpClient = await experimental_createMCPClient({
          transport: {
            type: "sse",
            url: zapierMcpUrl,
          },
        });

        mcpTools = await mcpClient.tools();
        console.log(
          `Simple AI DB Handler: Successfully connected to Zapier MCP. Available tools: ${
            Object.keys(mcpTools).length
          }`
        );
      } catch (error) {
        console.error(
          "Simple AI DB Handler: Failed to initialize Zapier MCP client:",
          error
        );
        mcpTools = {};
      }
    }

    const tools = {
      execute_sql: tool({
        description: `Executes SQL within the public schema. Create tables directly (e.g., CREATE TABLE my_notes). Escape single quotes ('') in string literals.`,
        parameters: z.object({
          query: z.string().describe("SQL query (DML/DDL)."),
        }),
        execute: async ({ query }) => {
          const result = await executeSQL(query);
          if (result.error) {
            return { error: result.error };
          }

          const trimmedQuery = query.trim();
          const rowsWithStrings = result.result
            ? convertBigIntsToStrings(result.result)
            : [];

          if (
            trimmedQuery.toUpperCase().startsWith("SELECT") ||
            (rowsWithStrings && rowsWithStrings.length > 0)
          ) {
            return JSON.stringify(rowsWithStrings);
          } else {
            return JSON.stringify({
              message: "Command executed successfully.",
              rowCount: Number(result.rowCount ?? 0),
            });
          }
        },
      }),
      get_distinct_column_values: tool({
        description: `Retrieves distinct values for a column within the public schema. Use this to understand column values before filtering, especially for columns with discrete, non-freeform text values (e.g., status, category, type) rather than long freeform text (e.g., notes, descriptions).`,
        parameters: z.object({
          table_name: z.string().describe("Table name (e.g., my_tasks)."),
          column_name: z.string().describe("Column name."),
        }),
        execute: async ({ table_name, column_name }) => {
          const columnNameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
          const tableNameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
          if (!columnNameRegex.test(column_name))
            return {
              error: "Invalid column_name format.",
            };
          if (!tableNameRegex.test(table_name))
            return {
              error: "Invalid table_name format.",
            };

          const query = `SELECT DISTINCT "${column_name}" FROM ${table_name};`;
          const result = await executeSQL(query);

          if (result.error) {
            return { error: result.error };
          }

          const distinctValues = result.result.map(
            (row: any) => row[column_name]
          );
          return {
            distinct_values: convertBigIntsToStrings(distinctValues),
          };
        },
      }),
      schedule_prompt: tool({
        description:
          "Schedules a job to run at a future time using cron or an ISO 8601 timestamp.",
        parameters: z.object({
          schedule_expression: z
            .string()
            .describe(
              "Cron (e.g., '0 9 * * MON') or ISO timestamp (e.g., 'YYYY-MM-DDTHH:mm:ssZ')."
            ),
          prompt_to_schedule: z
            .string()
            .describe(
              'Directive FOR THE ASSISTANT to follow when this job runs (e.g., "Remind the user about their meeting"), NOT the message to show the user.'
            ),
          job_name: z
            .string()
            .describe(
              'Descriptive suffix for the job name (e.g., "project_deadline_reminder" or "morning_run_check"). The system will automatically prefix it to ensure uniqueness and proper tracking.'
            ),
        }),
        execute: async ({
          schedule_expression,
          prompt_to_schedule,
          job_name,
        }) => {
          if (!id || !userId)
            return {
              error: "ID or userId missing for scheduling.",
            };
          if (!cronCallbackUrl)
            return {
              error: "Callback URL for outgoing handler is missing.",
            };

          const payloadForCron = JSON.stringify({
            userPrompt: prompt_to_schedule,
            id: id,
            userId: userId,
            metadata: {
              ...metadata,
              originalUserMessage: userPrompt
            },
            timezone: timezone,
            incomingMessageRole: "system_routine_task",
            callbackUrl: callbackUrl,
          });

          const escapedPayload = payloadForCron.replace(/'/g, "''");
          let sqlCommand: string;
          let finalJobName: string;
          let isOneOff = false;

          // Check if it's an ISO timestamp for one-off job
          try {
            const date = new Date(schedule_expression);
            if (
              !isNaN(date.getTime()) &&
              schedule_expression.includes("T") &&
              (schedule_expression.includes("Z") ||
                schedule_expression.match(/[+-]\d{2}:\d{2}$/))
            ) {
              isOneOff = true;
            }
          } catch (e) {
            // Not a valid ISO timestamp, treat as cron
          }

          let descriptiveSuffix: string;
          if (job_name) {
            descriptiveSuffix = job_name
              .replace(/[^a-zA-Z0-9_]/g, "_")
              .substring(0, 18);
          } else {
            descriptiveSuffix = Date.now().toString();
          }

          if (isOneOff) {
            finalJobName = `one_off_${id}_${descriptiveSuffix}`;
          } else {
            finalJobName = `cron_${id}_${descriptiveSuffix}`;
          }

          if (isOneOff) {
            const date = new Date(schedule_expression);
            const minute = date.getUTCMinutes();
            const hour = date.getUTCHours();
            const dayOfMonth = date.getUTCDate();
            const month = date.getUTCMonth() + 1;
            const cronForTimestamp = `${minute} ${hour} ${dayOfMonth} ${month} *`;

            const taskLogic = `PERFORM net.http_post(url := '${cronCallbackUrl}', body := '${escapedPayload}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb); PERFORM cron.unschedule('${finalJobName}');`;
            sqlCommand = `SELECT cron.schedule('${finalJobName}', '${cronForTimestamp}', $$ DO $job$ BEGIN ${taskLogic} EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Error job ${finalJobName}: %', SQLERRM; BEGIN PERFORM cron.unschedule('${finalJobName}'); RAISE NOTICE 'Unscheduled ${finalJobName} after error.'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'CRITICAL: Failed to unschedule ${finalJobName} after error: %', SQLERRM; END; RAISE; END; $job$; $$);`;
          } else {
            const scheduleArg = `'${finalJobName}', '${schedule_expression}'`;
            sqlCommand = `SELECT cron.schedule(${scheduleArg}, $$ SELECT net.http_post(url := '${cronCallbackUrl}', body := '${escapedPayload}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb) $$);`;
          }

          const scheduleResult = await executeSQL(sqlCommand);
          if (scheduleResult.error) {
            return { error: scheduleResult.error };
          }

          if (scheduleResult.result && scheduleResult.result.length > 0) {
            const jobIdResult =
              scheduleResult.result[0][
                Object.keys(scheduleResult.result[0])[0]
              ];
            return `Job scheduled. Name: ${
              finalJobName || jobIdResult
            }. Type: ${isOneOff ? "One-off" : "Recurring"}`;
          } else {
            return {
              error:
                "Failed to schedule job: No confirmation from cron.schedule.",
            };
          }
        },
      }),
      // Merge Zapier MCP tools
      ...mcpTools,
    };

    let formattedSchemaDetails = `You are operating within the public PostgreSQL schema.`;
    const schemaResult = await getPublicSchemaDetails();
    if (schemaResult.error) {
      console.error(
        "Simple AI DB Handler: Error fetching schema details:",
        schemaResult.error
      );
      formattedSchemaDetails += `\n(Could not fetch schema details: ${schemaResult.error})`;
    } else if (typeof schemaResult.schemaDetails === "string") {
      formattedSchemaDetails = schemaResult.schemaDetails;
    }

    let activeCronJobsString = "Could not fetch scheduled routine details.";
    try {
      const cronJobsResult = await getActiveCronJobDetails();
      if (cronJobsResult.error) {
        activeCronJobsString = `Note: Error fetching scheduled routines: ${cronJobsResult.error}`;
      } else if (cronJobsResult.result && cronJobsResult.result.length > 0) {
        activeCronJobsString = "Currently Scheduled Routines:\n";
        cronJobsResult.result.forEach((job: any) => {
          activeCronJobsString += `  - Job Name: ${job.jobname}, Schedule: ${job.schedule}\n`;
        });
      } else {
        activeCronJobsString = "No routines currently scheduled.\n";
      }
    } catch (e: any) {
      console.error(`Simple AI DB Handler: Exception fetching cron jobs:`, e);
      activeCronJobsString = `Exception occurred while fetching scheduled routines: ${e.message}`;
    }

    console.log(
      `Simple AI DB Handler: Formatted Schema Details for system prompt:`,
      formattedSchemaDetails
    );
    console.log(
      `Simple AI DB Handler: Active Cron Jobs String for system prompt:`,
      activeCronJobsString
    );

    const now = new Date();
    const systemPrompt = `You are a highly organized personal assistant.

Currently Tracking:
---------------------------
Saved Information (Database Structure):
${formattedSchemaDetails}

Scheduled Routines:
${activeCronJobsString}
---------------------------

Key Responsibilities & Database Context (PostgreSQL):
- Public Schema: You are operating within the public PostgreSQL schema. When you create tables (e.g., CREATE TABLE my_tasks (id UUID PRIMARY KEY, task TEXT, due_date TIMESTAMPTZ)), they will be placed in the public schema. Use descriptive names for tables and columns.
- SQL Execution ('execute_sql' tool): Use for all DB operations (SELECT, INSERT, CREATE TABLE, etc.) within the public schema. Ensure quotes are escaped ('\'). Enable RLS immediately after CREATE TABLE using \`ALTER TABLE <table_name> ENABLE ROW LEVEL SECURITY;\`.
- Table Documentation: ALWAYS add meaningful comments to tables and columns when creating them using \`COMMENT ON TABLE table_name IS 'Description';\` and \`COMMENT ON COLUMN table_name.column_name IS 'Description';\`. This helps with understanding the schema structure and purpose.
- AVOID DUPLICATES: Only insert each piece of data once. If you\\'ve already created a record, don\\'t create it again.
- Column Value Discovery & Querying Strategy ('get_distinct_column_values' tool):
  - Before filtering data with a \`WHERE\` clause based on a column\\\'s value (e.g., \`SELECT * FROM my_tasks WHERE status = 'completed'\`), ALWAYS first use the \`get_distinct_column_values\` tool to fetch all unique values for that specific column (e.g., get distinct values for 'status' in 'my_tasks'). This is most useful for columns that tend to have a limited set of repeating, non-freeform text values (like 'status', 'priority', 'category') rather than columns with unique, long-form text (like 'note_content', 'description'). For freeform text columns, direct querying with appropriate string matching (LIKE, ILIKE) might be more suitable.
  - From the list of distinct values, select the value that is most semantically similar or identical to the request.
  - If the exact value provided is not present in the distinct values, use the closest or most relevant match you found. In your response, you MUST clearly state that you\\\'ve used this alternative value and briefly explain why it was chosen (e.g., "I found tasks with status \\\'in progress\\\' which seems to match your request for \\\'ongoing\\\', so I\\\'ve used that." or "You asked for \\\'urgent\\\' items; I found items marked \\\'high priority\\\' and will use that category.").
  - If no suitable or closely related alternative value can be found in the distinct values, inform that the specified value does not exist in the available options for that column.

Scheduling Future Actions ('schedule_prompt' tool):
- Use EXCLUSIVELY for actions/reminders at a FUTURE time. Not for past/current data queries.
- Automatically handles callback URL configuration for scheduled jobs.
- CRITICAL: \`prompt_to_schedule\` should be a directive FOR YOURSELF (the assistant), not the message to show to the user. These are instructions telling you (the assistant) what to do or ask.
  * CORRECT EXAMPLES: 
    - "Remind about doctor appointment tomorrow"
    - "Ask if project deadline has been completed"
    - "Check if morning routine tasks are complete"
    - "Indicate it's time for daily meditation"
    - "Remind to review weekly goals"
  * INCORRECT EXAMPLES:
    - "It's time for your doctor appointment!"
    - "Have you completed your project?"
    - "Don't forget to meditate today!"
    - "It's 12pm! Time to write in your journal."
    - "Your weekly review is due today."
- The prompt_to_schedule should tell YOU what to do when triggered, NOT be the final message shown to the user.
- You'll receive this directive later as a 'system_routine_task', and THEN you'll formulate an appropriate user-facing message.
- \`schedule_expression\`: ISO 8601 timestamp for one-off tasks (e.g., '2024-07-15T10:00:00Z', self-unschedules) or Cron for recurring (e.g., '0 9 * * MON').
- \`job_name\`: Descriptive suffix for the job name (e.g., "project_deadline_reminder" or "morning_run_check"). The system will automatically prefix it to ensure uniqueness and proper tracking.

Handling System Routine Tasks:
- These are internal directives previously scheduled. Interpret the directive (in 'userPrompt'), use tools if needed, perform the action, and formulate a user-facing message if interaction is required.
- Process:
    1. Interpret the directive in the message content.
    2. Use \`execute_sql\` if needed for database context.
    3. Perform the core action.
    4. If user interaction is implied, formulate a concise, new, user-facing message as your final text output.
      * EXAMPLE 1: You receive directive "Remind about the doctor appointment tomorrow" → You check for appointment details in the database → Your message to user: "Just a reminder about the doctor appointment scheduled for tomorrow at 2pm."
      * EXAMPLE 2: You receive directive "Ask if morning tasks completed" → Your message to user: "Good morning! Have you completed your morning routine tasks today?"
      * EXAMPLE 3: You receive directive "Indicate it's time for daily journal entry" → Your message to user: "It's time for your daily journal! What would you like to reflect on today?"
    5. For purely internal tasks without user notification, a simple confirmation is sufficient.

Message Context Handling:
- You receive two types of message history:
  1. Chronological Messages (chatHistory): These are the most recent messages in the conversation, ordered by time. Use these to understand the immediate context and flow of the conversation.
  2. Relevant Context (relevantContext): These are semantically similar messages from the past that might be relevant to the current query. Use these to understand related topics or previous discussions that might be helpful.
- When responding:
  * Prioritize the chronological messages for understanding the immediate conversation flow
  * Use relevant context messages to provide more informed responses about related topics
  * If there's a conflict between chronological and relevant context, prioritize the chronological messages
  * Use relevant context to enrich your response with related information, but maintain focus on the current conversation

How to Communicate:
- Be kind, supportive, and organized. Focus on the needs and goals. Ask clarifying questions when needed. Keep responses concise and clear.
- IMPORTANT: When communicating, DO NOT mention technical terms like "schema", "SQL", "database tables", "PostgreSQL", "RLS", or other database terminology. Refer to saved information in plain language like "saved information", "tasks", "notes", etc.
- Present information in a natural, conversational way without revealing the underlying data structure. Instead of saying "I\\'ll query the tasks table", say "I\\'ll check the tasks" or "I\\'ll find that information."
- Only explain technical implementation details if explicitly asked for them.

Data Retrieval Strategy:
- Use direct SQL queries ('execute_sql' tool) to find information. You may need to make multiple queries to locate the necessary data.
- Use 'get_distinct_column_values' to understand the range of values in a column before attempting to filter or query based on those values. This is most useful for columns that tend to have a limited set of repeating, non-freeform text values (like 'status', 'priority', 'category') rather than columns with unique, long-form text (like 'note_content', 'description').
- SEARCH STRATEGY:
  1. **Direct SQL queries**: Use known table/column names and WHERE clauses. Make as many queries as you need to find the information. For columns with freeform text, consider using string matching operators like \`LIKE\` or \`ILIKE\`.
  2. **Column value discovery**: Use 'get_distinct_column_values' to explore available values before filtering if you are unsure about the exact values to use in your queries, especially for columns with discrete, non-freeform values.
- WORKFLOW: When working with any data:
  1. Create table normally: \`CREATE TABLE my_notes (id UUID PRIMARY KEY, title TEXT, content TEXT, created_at TIMESTAMPTZ DEFAULT NOW());\`
  2. Add table and column comments: \`COMMENT ON TABLE my_notes IS 'Personal notes and thoughts';\` \`COMMENT ON COLUMN my_notes.content IS 'Main note content';\`
  3. Enable RLS: \`ALTER TABLE my_notes ENABLE ROW LEVEL SECURITY;\`
  4. Insert data: \`INSERT INTO my_notes (id, title, content) VALUES (gen_random_uuid(), 'My Note', 'Note content') RETURNING id;\`

Web Search ('web_search_preview' tool):
- Use for current, real-world information that needs to be up-to-date or verified
- Best for:
  * Fact-checking and verification
  * Current events and news
  * Weather and time-sensitive information
  * Public information that changes frequently
  * General knowledge that might be outdated in your training data
- DO NOT use for:
  * Personal or private information
  * Information that should be stored in the database
  * Information that needs to be acted upon (use Zapier tools instead)
  * Information that needs to be scheduled or automated

${
  Object.keys(mcpTools).length > 0
    ? `
Zapier Integration:
- Use Zapier tools for actions and automations that require external services
- Best for:
  * Sending emails, notifications, or messages to other platforms
  * Creating or updating items in external services (e.g., Google Calendar, Trello)
  * Triggering workflows in other applications
  * Getting data from external services that you need to act upon
  * Scheduling or automating tasks across different platforms
- Available Zapier tools: ${Object.keys(mcpTools).join(", ")}
- When using Zapier tools:
  * Always check if the action is appropriate for the user's request
  * Consider privacy and security implications
  * Verify the tool's capabilities before suggesting its use
  * Explain to the user what external service will be involved
`
    : ""
}

Confirming New Structures:
- Before creating a new table, check if an existing table in the public schema could serve the purpose. Use your knowledge of the schema details provided and the context. If unsure, you can use SQL via 'execute_sql' to list tables (e.g., \`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';\`).

Current Time Information:
UTC Time: ${now.toISOString()}
${timezone ? `Local Timezone: ${timezone}` : ''}

IMPORTANT TIME INSTRUCTIONS:
- Base date/time arithmetic on the 'Current Time Information' provided above.
- When scheduling or referencing times, always consider the user's timezone if available.
- For database operations, store all times in UTC (TIMESTAMPTZ) and let the application layer handle timezone conversions.
- When displaying times to the user, convert from UTC to their local timezone.
- When scheduling future events, convert from the user's local time to UTC before storing.

You can make multiple tool calls when necessary, but be efficient and avoid duplicating operations. Complete the user's request in the minimum number of steps required. Once you've successfully created or saved something, don't create it again.`;

    // Handle system routine tasks by modifying the system prompt and last message
    let messagesForAI = [...chatHistory];
    let enhancedSystemPrompt = systemPrompt;
    
    if (incomingMessageRole === "system_routine_task") {
      // For system routine tasks, add the directive as a new message
      messagesForAI.push({
        role: "user",
        content: `INTERNAL SYSTEM TASK (Directive for you, the assistant): ${userPrompt}`
      });
    } else {
      // For regular user messages, add the current message to the history
      messagesForAI.push({
        role: incomingMessageRole,
        content: userPrompt
      });
    }

    // Add relevant context to system prompt if available
    const allRelevantContext = [...relevantContext];
    
    // For system routine tasks, include the original user message that created the schedule as context
    if (incomingMessageRole === "system_routine_task" && metadata.originalUserMessage) {
      allRelevantContext.push({
        role: "user",
        content: metadata.originalUserMessage
      });
    }
    
    if (allRelevantContext.length > 0) {
      const relevantContextText = allRelevantContext
        .map(msg => `- ${msg.content}`)
        .join('\n');
      enhancedSystemPrompt = `${systemPrompt}\n\nRelevant Context from Previous Conversations:\n${relevantContextText}`;
    }

    const result = await generateText({
      model: openai.responses(openaiModel),
      system: enhancedSystemPrompt,
      messages: messagesForAI,
      providerOptions: {
        openai: {
          store: false,
          strictSchemas: false
        }
      },
      tools: {
        web_search_preview: openai.tools.webSearchPreview(),
        ...tools,
      },
      maxSteps: 10,
    });

    const finalResponse = result.text;
    console.log(
      `Simple AI DB Handler: Final AI Response for ID ${id}: "${finalResponse}"`
    );

    // Save the assistant's response to database for all message types
    try {
      console.log(`Simple AI DB Handler: Saving assistant response for chat ID ${id}`);
      
      // Generate embedding for the assistant response
      let responseEmbedding: string | undefined;
      try {
        responseEmbedding = await generateEmbedding(finalResponse);
        console.log(`Simple AI DB Handler: Generated embedding for assistant response`);
      } catch (embeddingError) {
        console.warn(
          `Simple AI DB Handler: Could not generate embedding for assistant response, saving without embedding:`,
          embeddingError
        );
      }

      const responseInsertResult = await insertMessage(
        supabase,
        userId,
        finalResponse,
        "assistant",
        id,
        responseEmbedding
      );

      if (responseInsertResult.error) {
        console.error(
          `Simple AI DB Handler: Error saving assistant response:`,
          responseInsertResult.error
        );
      } else {
        console.log(
          `Simple AI DB Handler: Saved assistant response for chat ID ${id}`
        );
      }
    } catch (error) {
      console.error(`Simple AI DB Handler: Failed to save assistant response:`, error);
    }

    // Clean up MCP client
    if (mcpClient) {
      try {
        await mcpClient.close();
        console.log(
          "Simple AI DB Handler: Zapier MCP client closed successfully."
        );
      } catch (error) {
        console.error(
          "Simple AI DB Handler: Error closing Zapier MCP client:",
          error
        );
      }
    }

    if (callbackUrl) {
      const outgoingPayload = {
        finalResponse,
        id,
        userId,
        metadata: {
          ...metadata,
          userId // Include userId in metadata for backward compatibility
        },
        timezone,
      };
      console.log(
        `Simple AI DB Handler: Sending to outgoing handler (${callbackUrl}):`,
        outgoingPayload
      );
      await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(outgoingPayload),
      });
    } else {
      console.error("Simple AI DB Handler: CRITICAL - callbackUrl is missing.");
    }

    return new Response(
      JSON.stringify({
        status: "ai_processing_complete_for_id",
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Simple AI DB Handler: Error processing request:", error);

    // Clean up MCP client in error case
    if (mcpClient) {
      try {
        await mcpClient.close();
        console.log(
          "Simple AI DB Handler: Zapier MCP client closed after error."
        );
      } catch (cleanupError) {
        console.error(
          "Simple AI DB Handler: Error closing Zapier MCP client during error cleanup:",
          cleanupError
        );
      }
    }

    if (callbackUrl && id && metadata) {
      try {
        const errorResponse = "Sorry, an internal error occurred.";
        
        // Try to save the error response to database for all message types
        try {
          const errorInsertResult = await insertMessage(
            supabase,
            userId,
            errorResponse,
            "assistant",
            id
          );
          if (errorInsertResult.error) {
            console.error(
              `Simple AI DB Handler: Error saving error response:`,
              errorInsertResult.error
            );
          }
        } catch (error) {
          console.error(`Simple AI DB Handler: Failed to save error response:`, error);
        }
        
        await fetch(callbackUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            finalResponse: errorResponse,
            id,
            userId,
            metadata: {
              ...metadata,
              userId
            },
            timezone,
          }),
        });
      } catch (cbError) {
        console.error(
          "Simple AI DB Handler: Failed to send error to callback URL:",
          cbError
        );
      }
    }
    return new Response("Internal Server Error", {
      status: 500,
    });
  }
});

console.log(
  "Simple AI DB Handler started. Handles message persistence, AI processing, and public schema database operations."
);
