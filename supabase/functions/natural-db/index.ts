import { createOpenAI } from "npm:@ai-sdk/openai";
import { generateText, tool, experimental_createMCPClient } from "npm:ai";
import { z } from "npm:zod";
import { 
  executeSQL, 
  convertBigIntsToStrings,
  loadRecentAndRelevantMessages,
  insertMessage,
  generateEmbedding,
  getChatSchemaDetails
} from "../_shared/db-utils.ts";
import { createClient } from "npm:@supabase/supabase-js";

/**
 * AI DB Handler with Chat-Specific Schema Isolation
 *
 * This handler creates isolated schemas for each chat_id, providing secure
 * database operations while protecting system tables in the public schema.
 *
 * Architecture:
 * - Creates chat-specific schemas (chat_{chat_id}) for LLM operations
 * - System tables (messages, system_prompts) remain in public schema
 * - LLM has no access to public schema or other chats' schemas
 * - Provides SQL execution, scheduling capabilities, and message handling
 * - Vector search and embedding functionality handled internally
 * - Each chat operates in complete isolation from others
 */

// Environment Variables
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
const openaiModel = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
const zapierMcpUrl = Deno.env.get("ZAPIER_MCP_URL");

if (!supabaseUrl || !supabaseServiceRoleKey || !openaiApiKey) {
  throw new Error("Missing required environment variables");
}

const openai = createOpenAI({
  apiKey: openaiApiKey,
  compatibility: "strict"
});

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const MAX_CHAT_HISTORY = 10;
const MAX_RELEVANT_MESSAGES = 5;

async function getActiveCronJobDetails(chatId: string | number) {
  const result = await executeSQL(
    `SELECT jobname, schedule FROM cron.job WHERE active = true AND (jobname LIKE 'one_off_${chatId}_%' OR jobname LIKE 'cron_${chatId}_%') ORDER BY jobname;`,
    chatId
  );
  return result.error ? result : { result: result.result };
}

async function getChatSchemaDetailsFormatted(chatId: string | number) {
  const operationResult = await getChatSchemaDetails(chatId);

  if (operationResult.error) {
    return {
      error: `Failed to fetch chat schema details: ${operationResult.error}`,
    };
  }

  const schemaContents = operationResult.result.length > 0 ? operationResult.result[0] : null;
  if (!schemaContents?.columns || schemaContents.columns.length === 0) {
    return {
      schemaDetails: `Your private database schema is ready but contains no tables yet. You can create tables as needed.`,
    };
  }

  const schemaData = schemaContents.columns;
  let formattedString = `\nDetails of your private database schema:\n`;
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

  return { schemaDetails: formattedString };
}

async function saveMessage(userId: string, content: string, role: string, chatId: string, embedding?: string) {
  try {
    const insertResult = await insertMessage(supabase, userId, content, role, chatId, embedding);
    if (insertResult.error) {
      console.error(`Error saving ${role} message:`, insertResult.error);
    }
  } catch (error) {
    console.error(`Failed to save ${role} message:`, error);
  }
}

async function generateMessageEmbedding(content: string): Promise<string | undefined> {
  try {
    return await generateEmbedding(content);
  } catch (error) {
    return undefined;
  }
}

async function getCurrentSystemPrompt(chatId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('system_prompts')
      .select('prompt_content')
      .eq('chat_id', chatId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('Error fetching system prompt:', error);
      return null;
    }

    return data && data.length > 0 ? data[0].prompt_content : null;
  } catch (error) {
    console.error('Error in getCurrentSystemPrompt:', error);
    return null;
  }
}

async function updateSystemPrompt(chatId: string, newPrompt: string, description: string): Promise<{ success: boolean; error?: string }> {
  try {
    // First, deactivate all existing prompts for this chat
    const { error: deactivateError } = await supabase
      .from('system_prompts')
      .update({ is_active: false })
      .eq('chat_id', chatId)
      .eq('is_active', true);

    if (deactivateError) {
      return { success: false, error: `Failed to deactivate old prompts: ${deactivateError.message}` };
    }

    // Get the next version number
    const { data: versionData, error: versionError } = await supabase
      .from('system_prompts')
      .select('version')
      .eq('chat_id', chatId)
      .order('version', { ascending: false })
      .limit(1);

    const nextVersion = (versionData && versionData.length > 0) ? versionData[0].version + 1 : 1;

    // Insert the new active prompt
    const { error: insertError } = await supabase
      .from('system_prompts')
      .insert({
        chat_id: chatId,
        prompt_content: newPrompt,
        version: nextVersion,
        created_by_role: 'assistant',
        description: description,
        is_active: true
      });

    if (insertError) {
      return { success: false, error: `Failed to insert new prompt: ${insertError.message}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: `Unexpected error: ${error}` };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let mcpClient: any = null;

  try {
    const body = await req.json();
    const {
      userPrompt,
      id,
      userId,
      metadata = {},
      timezone,
      incomingMessageRole,
      callbackUrl
    } = body;

    if (!userPrompt || !id || !userId || !incomingMessageRole || !callbackUrl) {
      return new Response("Invalid request body", { status: 400 });
    }

    const cronCallbackUrl = `${supabaseUrl}/functions/v1/natural-db`;

    let chatHistory: any[] = [];
    let relevantContext: any[] = [];

    // Load message history and save incoming message
    if (incomingMessageRole !== "system_routine_task") {
      try {
        const messageHistory = await loadRecentAndRelevantMessages(
          supabase, userId, userPrompt, MAX_CHAT_HISTORY, MAX_RELEVANT_MESSAGES, id
        );
        chatHistory = messageHistory.chronologicalMessages || [];
        relevantContext = messageHistory.relevantContext || [];

        const embedding = await generateMessageEmbedding(userPrompt);
        await saveMessage(userId, userPrompt, incomingMessageRole, id, embedding);
      } catch (error) {
        chatHistory = [];
        relevantContext = [];
      }
    } else {
      try {
        const messageHistory = await loadRecentAndRelevantMessages(
          supabase, userId, userPrompt, MAX_CHAT_HISTORY, MAX_RELEVANT_MESSAGES, id
        );
        chatHistory = messageHistory.chronologicalMessages || [];
        relevantContext = messageHistory.relevantContext || [];

        const embedding = await generateMessageEmbedding(userPrompt);
        await saveMessage(userId, userPrompt, incomingMessageRole, id, embedding);
      } catch (error) {
        chatHistory = [];
        relevantContext = [];
      }
    }

    // Initialize MCP client if available
    let mcpTools: any = {};
    if (zapierMcpUrl) {
      try {
        mcpClient = await experimental_createMCPClient({
          transport: { type: "sse", url: zapierMcpUrl },
        });
        mcpTools = await mcpClient.tools();
      } catch (error) {
        mcpTools = {};
      }
    }

    const tools = {
      execute_sql: tool({
        description: `Executes SQL within your private schema. Create tables directly (e.g., CREATE TABLE my_notes). Escape single quotes ('') in string literals. You have full control over this isolated database space.`,
        parameters: z.object({
          query: z.string().describe("SQL query (DML/DDL)."),
        }),
        execute: async ({ query }) => {
          const result = await executeSQL(query, id);
          if (result.error) {
            return { error: result.error };
          }

          const trimmedQuery = query.trim();
          const rowsWithStrings = result.result ? convertBigIntsToStrings(result.result) : [];

          if (trimmedQuery.toUpperCase().startsWith("SELECT") || (rowsWithStrings && rowsWithStrings.length > 0)) {
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
        description: `Retrieves distinct values for a column within your private schema. Use for columns with discrete values (e.g., status, category) rather than freeform text.`,
        parameters: z.object({
          table_name: z.string().describe("Table name."),
          column_name: z.string().describe("Column name."),
        }),
        execute: async ({ table_name, column_name }) => {
          const columnNameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
          const tableNameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
          if (!columnNameRegex.test(column_name) || !tableNameRegex.test(table_name)) {
            return { error: "Invalid table or column name format." };
          }

          const query = `SELECT DISTINCT "${column_name}" FROM ${table_name};`;
          const result = await executeSQL(query, id);

          if (result.error) {
            return { error: result.error };
          }

          const distinctValues = result.result.map((row: any) => row[column_name]);
          return { distinct_values: convertBigIntsToStrings(distinctValues) };
        },
      }),

      schedule_prompt: tool({
        description: "Schedules a job to run at a future time using cron or ISO 8601 timestamp.",
        parameters: z.object({
          schedule_expression: z.string().describe("Cron (e.g., '0 9 * * MON') or ISO timestamp."),
          prompt_to_schedule: z.string().describe("Directive for the assistant when job runs."),
          job_name: z.string().describe("Descriptive suffix for job name."),
        }),
        execute: async ({ schedule_expression, prompt_to_schedule, job_name }) => {
          if (!id || !userId || !cronCallbackUrl) {
            return { error: "Missing required data for scheduling." };
          }

          const payloadForCron = JSON.stringify({
            userPrompt: prompt_to_schedule,
            id,
            userId,
            metadata: { ...metadata, originalUserMessage: userPrompt },
            timezone,
            incomingMessageRole: "system_routine_task",
            callbackUrl,
          });

          const escapedPayload = payloadForCron.replace(/'/g, "''");
          let isOneOff = false;

          try {
            const date = new Date(schedule_expression);
            if (!isNaN(date.getTime()) && 
                schedule_expression.includes("T") && 
                (schedule_expression.includes("Z") || schedule_expression.match(/[+-]\d{2}:\d{2}$/))) {
              isOneOff = true;
            }
          } catch (e) {
            // Not ISO timestamp, treat as cron
          }

          const descriptiveSuffix = job_name ? 
            job_name.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 18) : 
            Date.now().toString();

          const finalJobName = isOneOff ? 
            `one_off_${id}_${descriptiveSuffix}` : 
            `cron_${id}_${descriptiveSuffix}`;

          let sqlCommand: string;

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
            sqlCommand = `SELECT cron.schedule('${finalJobName}', '${schedule_expression}', $$ SELECT net.http_post(url := '${cronCallbackUrl}', body := '${escapedPayload}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb) $$);`;
          }

          const scheduleResult = await executeSQL(sqlCommand, id);
          if (scheduleResult.error) {
            return { error: scheduleResult.error };
          }

          if (scheduleResult.result && scheduleResult.result.length > 0) {
            const jobIdResult = scheduleResult.result[0][Object.keys(scheduleResult.result[0])[0]];
            return `Job scheduled. Name: ${finalJobName || jobIdResult}. Type: ${isOneOff ? "One-off" : "Recurring"}`;
          } else {
            return { error: "Failed to schedule job: No confirmation from cron.schedule." };
          }
        },
      }),

      unschedule_prompt: tool({
        description: "Unschedules a previously scheduled job by its job name. Use this to cancel or remove scheduled tasks.",
        parameters: z.object({
          job_name: z.string().describe("The name of the job to unschedule (from schedule_prompt or visible in scheduled routines)."),
        }),
        execute: async ({ job_name }) => {
          if (!job_name) {
            return { error: "Job name is required for unscheduling." };
          }

          // Validate job name format to prevent SQL injection
          const jobNameRegex = /^[a-zA-Z0-9_]+$/;
          if (!jobNameRegex.test(job_name)) {
            return { error: "Invalid job name format. Job names should contain only letters, numbers, and underscores." };
          }

          const sqlCommand = `SELECT cron.unschedule('${job_name}');`;
          
          const unscheduleResult = await executeSQL(sqlCommand, id);
          if (unscheduleResult.error) {
            return { error: unscheduleResult.error };
          }

          return `Job '${job_name}' has been successfully unscheduled and removed.`;
        },
      }),

      update_system_prompt: tool({
        description: "Updates ONLY the personalized behavior section of the system prompt. The base system behavior (database operations, scheduling, etc.) never changes. Use this when the user wants to customize personality, communication style, or add specific behavioral preferences.",
        parameters: z.object({
          new_system_prompt: z.string().describe("ONLY the personalized behavior additions/changes - NOT the entire system prompt. Focus on personality, communication style, or specific user preferences. The base database and scheduling behavior remains unchanged."),
          description: z.string().describe("Brief description of what this prompt change accomplishes or why it was made."),
        }),
        execute: async ({ new_system_prompt, description }) => {
          if (!id) {
            return { error: "Chat ID is required to update system prompt." };
          }

          const result = await updateSystemPrompt(id, new_system_prompt, description);
          
          if (result.success) {
            return `System prompt updated successfully. Description: ${description}. The new prompt will take effect in the next conversation.`;
          } else {
            return { error: result.error || "Failed to update system prompt." };
          }
        },
      }),

      get_system_prompt_history: tool({
        description: "Retrieves the history of system prompt changes for this user, including versions and descriptions.",
        parameters: z.object({}),
                execute: async () => {
          if (!id) {
            return { error: "Chat ID is required to retrieve system prompt history." };
          }

          const query = `
            SELECT version, description, created_by_role, is_active, created_at, 
                   LENGTH(prompt_content) as prompt_length
            FROM system_prompts 
            WHERE chat_id = '${id}' 
            ORDER BY version DESC 
            LIMIT 10
          `;
          
          const result = await executeSQL(query, id);
          
          if (result.error) {
            return { error: result.error };
          }

          return JSON.stringify(result.result);
        },
      }),

      ...mcpTools,
    };

    // Get schema and cron job details
    let formattedSchemaDetails = `You are operating within your own private database schema.`;
    const schemaResult = await getChatSchemaDetailsFormatted(id);
    if (schemaResult.error) {
      formattedSchemaDetails += `\n(Could not fetch schema details: ${schemaResult.error})`;
    } else if (typeof schemaResult.schemaDetails === "string") {
      formattedSchemaDetails = schemaResult.schemaDetails;
    }

    let activeCronJobsString = "No routines currently scheduled.\n";
    try {
      const cronJobsResult = await getActiveCronJobDetails(id);
      if (cronJobsResult.error) {
        activeCronJobsString = `Note: Error fetching scheduled routines: ${cronJobsResult.error}`;
      } else if (cronJobsResult.result && cronJobsResult.result.length > 0) {
        activeCronJobsString = "Currently Scheduled Routines:\n";
        cronJobsResult.result.forEach((job: any) => {
          activeCronJobsString += `  - Job Name: ${job.jobname}, Schedule: ${job.schedule}\n`;
        });
      }
    } catch (e: any) {
      activeCronJobsString = `Exception occurred while fetching scheduled routines: ${e.message}`;
    }

    const now = new Date();
    
    // Get custom system prompt from database
    const customSystemPrompt = await getCurrentSystemPrompt(id);
    
    const baseSystemPrompt = `BASE BEHAVIOR: You are a highly organized personal assistant with your own private database workspace.

Private Database Schema:
${formattedSchemaDetails}

Scheduled Routines:
${activeCronJobsString}

Core Responsibilities:
- SQL Execution: Use 'execute_sql' for all DB operations within your private schema. Escape quotes ('').
- Table Management: Before creating new tables, check if existing ones could serve the purpose
- Data Workflow: CREATE TABLE → Add comments → Insert data (RLS not needed in private schema)
- Column Discovery: Use 'get_distinct_column_values' before filtering discrete value columns (status, category) not freeform text.
- Avoid Duplicates: Only insert each piece of data once.

Table Creation Workflow:
1. CREATE TABLE with descriptive names: CREATE TABLE my_tasks (id UUID PRIMARY KEY, task TEXT, due_date TIMESTAMPTZ)
2. Add documentation: COMMENT ON TABLE my_tasks IS 'User task tracking'; COMMENT ON COLUMN my_tasks.task IS 'Task description'
3. Insert data: INSERT INTO my_tasks VALUES (gen_random_uuid(), 'Task name', '2024-01-01T10:00:00Z')

Column Value Strategy:
- Before filtering (WHERE status = 'completed'), use get_distinct_column_values to see available values
- Use closest semantic match if exact value not found and explain the substitution
- For freeform text columns, use LIKE/ILIKE instead

Scheduling (schedule_prompt & unschedule_prompt tools):
- Use ONLY for future actions/reminders, not current queries
- prompt_to_schedule: Directive FOR YOU (e.g., "Remind about meeting", "Check task completion")
- NOT user messages (e.g., "Your meeting is now!" ❌)
- ISO timestamps for one-off (2024-07-15T10:00:00Z), cron for recurring (0 9 * * MON)
- job_name: Descriptive suffix for tracking
- Use unschedule_prompt to cancel/remove scheduled jobs when no longer needed

System Routine Tasks:
When receiving system_routine_task:
1. Interpret directive in userPrompt
2. Use execute_sql for context if needed
3. Formulate user-facing message for interaction
Example: "Remind about doctor appointment" → Check DB → "Reminder: Doctor appointment tomorrow at 2pm"

Message Context:
- Chronological messages: Recent conversation flow (prioritize)
- Relevant context: Semantically similar past messages (enrich responses)

Communication:
- Be supportive and organized. Keep responses concise.
- Use plain language: "saved information" not "database tables"
- Don't reveal technical implementation unless asked

${Object.keys(mcpTools).length > 0 ? `
Zapier Tools: ${Object.keys(mcpTools).join(", ")}
Use for external service actions (emails, calendar, workflows)
` : ""}

Time Handling:
- Current UTC: ${now.toISOString()}
${timezone ? `- User Timezone: ${timezone}` : ''}
- Store times in UTC (TIMESTAMPTZ), consider user timezone for display
- Convert user local time to UTC when scheduling`;

    // Construct the final system prompt - always start with base behavior
    const selfModificationNote = `

PERSONALIZATION CAPABILITY:
You can personalize your behavior based on user needs by using the 'update_system_prompt' tool when users request changes to your personality, communication style, or specific capabilities. This allows you to evolve and adapt to user preferences while maintaining a history of all changes.

Use 'get_system_prompt_history' to view previous personalization versions and their descriptions.
`;

    const finalSystemPrompt = customSystemPrompt 
      ? `${baseSystemPrompt}\n\nPERSONALIZED BEHAVIOR:\n${customSystemPrompt}\n\n${selfModificationNote}`
      : `${baseSystemPrompt}${selfModificationNote}`;

    // Prepare messages for AI
    let messagesForAI = [...chatHistory];
    let enhancedSystemPrompt = finalSystemPrompt;
    
    if (incomingMessageRole === "system_routine_task") {
      messagesForAI.push({
        role: "user",
        content: `INTERNAL SYSTEM TASK: ${userPrompt}`
      });
    } else {
      messagesForAI.push({
        role: incomingMessageRole,
        content: userPrompt
      });
    }

    const allowedRoles = ["user", "assistant", "system"];

    const mappedMessages = messagesForAI.map(msg =>
      allowedRoles.includes(msg.role)
        ? msg
        : { ...msg, role: "system", content: `[ROUTINE_TASK] ${msg.content}` }
    );

    const allRelevantContext = [...relevantContext];
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
      enhancedSystemPrompt = `${finalSystemPrompt}\n\nRelevant Context from previous messages:\n${relevantContextText}`;
    }

    const result = await generateText({
      model: openai.responses(openaiModel),
      system: enhancedSystemPrompt,
      messages: mappedMessages,
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

    // Save assistant response
    const responseEmbedding = await generateMessageEmbedding(finalResponse);
    await saveMessage(userId, finalResponse, "assistant", id, responseEmbedding);

    // Send response to callback
    if (callbackUrl) {
      const outgoingPayload = {
        finalResponse,
        id,
        userId,
        metadata: { ...metadata, userId },
        timezone,
      };
      
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outgoingPayload),
      });
    }

    return new Response(
      JSON.stringify({ status: "ai_processing_complete_for_id" }),
      {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }
    );

  } catch (error) {
    console.error("AI processing error:", error);

    if (callbackUrl && body?.id && body?.metadata) {
      try {
        const errorResponse = "Sorry, an internal error occurred.";
        await saveMessage(body.userId, errorResponse, "assistant", body.id);
        
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            finalResponse: errorResponse,
            id: body.id,
            userId: body.userId,
            metadata: { ...body.metadata, userId: body.userId },
            timezone: body.timezone,
          }),
        });
      } catch (cbError) {
        console.error("Failed to send error to callback:", cbError);
      }
    }
    return new Response("Internal Server Error", { status: 500 });
  } finally {
    if (mcpClient) {
      try {
        await mcpClient.close();
      } catch (error) {
        // Silent cleanup
      }
    }
  }
});
