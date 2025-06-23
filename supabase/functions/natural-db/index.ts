import { createOpenAI } from "npm:@ai-sdk/openai";
import { generateText, experimental_createMCPClient } from "npm:ai";
import { z } from "npm:zod";
import { 
  executeRestrictedSQL,
  executePrivilegedSQL,
  convertBigIntsToStrings,
  loadRecentAndRelevantMessages,
  insertMessage,
  generateEmbedding,
  getMemoriesSchemaDetails
} from "./db-utils.ts";
import { createClient } from "npm:@supabase/supabase-js";
import { createTools } from "./tools.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const openaiApiKey = Deno.env.get("OPENAI_API_KEY")!;
const openaiModel = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
const zapierMcpUrl = Deno.env.get("ZAPIER_MCP_URL");
const allowedUsernames = Deno.env.get("ALLOWED_USERNAMES");

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

const IncomingPayloadSchema = z.object({
  userPrompt: z.string().min(1),
  id: z.union([z.string(), z.number()]),
  userId: z.string().uuid().or(z.string()),
  metadata: z.record(z.unknown()).optional(),
  timezone: z.string().nullable().optional(),
  incomingMessageRole: z.enum(["user", "assistant", "system", "system_routine_task"]),
  callbackUrl: z.string().url(),
});

interface ColumnInfo {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  table_comment?: string | null;
  column_comment?: string | null;
}

interface ChatMessage {
  role: "user" | "assistant" | "system" | "system_routine_task";
  content: string;
  created_at?: string;
}

interface CronJob {
  jobname: string;
  schedule: string;
}

async function getActiveCronJobDetails(chatId: string | number) {
  const result = await executePrivilegedSQL(
    `SELECT jobname, schedule 
       FROM cron.job 
      WHERE active = true 
        AND (jobname LIKE $1 OR jobname LIKE $2) 
      ORDER BY jobname;`,
    [`one_off_${chatId}_%`, `cron_${chatId}_%`]
  );
  return result.error ? result : { result: result.result };
}

async function getChatSchemaDetailsFormatted() {
  const operationResult = await getMemoriesSchemaDetails();

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

  const tables: Record<string, { columns: ColumnInfo[]; comment?: string | null }> = {};

  schemaData.forEach((col: ColumnInfo) => {
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
    table.columns.forEach((col: ColumnInfo) => {
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

async function saveMessage(userId: string, content: string, role: string, chatId: string, embedding?: string): Promise<void> {
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
    const { error: deactivateError } = await supabase
      .from('system_prompts')
      .update({ is_active: false })
      .eq('chat_id', chatId)
      .eq('is_active', true);

    if (deactivateError) {
      return { success: false, error: `Failed to deactivate old prompts: ${deactivateError.message}` };
    }

    const { data: versionData, error: versionError } = await supabase
      .from('system_prompts')
      .select('version')
      .eq('chat_id', chatId)
      .order('version', { ascending: false })
      .limit(1);

    const nextVersion = (versionData && versionData.length > 0) ? versionData[0].version + 1 : 1;

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

function isUsernameAllowed(username?: string): boolean {
  if (!allowedUsernames) return true;
  if (!username) return false;
  const allowedList = allowedUsernames.split(',').map(u => u.trim().toLowerCase());
  return allowedList.includes(username.toLowerCase());
}

async function verifyUserChatAccess(userId: string, chatId: string | number): Promise<boolean> {
  try {
    const { data: membershipRow, error } = await supabase
      .from('chat_users')
      .select('chat_id')
      .eq('chat_id', chatId.toString())
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('Error checking chat membership:', error);
      return false;
    }

    return !!membershipRow;
  } catch (e) {
    console.error('verifyUserChatAccess error:', e);
    return false;
  }
}

// ------------------------------------------------------------------
//  Main Function
// ------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let mcpClient: unknown = null;

  try {
    const raw = await req.json();
    const parsed = IncomingPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("Invalid request body:", parsed.error);
      return new Response("Invalid request body", { status: 400 });
    }

    const {
      userPrompt,
      id,
      userId,
      metadata = {},
      timezone,
      incomingMessageRole,
      callbackUrl,
    } = parsed.data;

    if (!id || !userId || !allowedUsernames) {
      return new Response(
        JSON.stringify({ status: 'missing_required_parameters' }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const hasAccess = await verifyUserChatAccess(userId, id);
    if (!hasAccess) {
      return new Response(
        JSON.stringify({ status: 'unauthorized_chat_access' }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (allowedUsernames) {
      try {
        const { data: profileRow, error: profileErr } = await supabase
          .from('profiles')
          .select('username')
          .eq('id', userId)
          .single();

        if (profileErr) {
          console.error('Error fetching profile for auth check:', profileErr);
          return new Response(
            JSON.stringify({ status: 'unauthorized_user' }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const username: string | undefined = profileRow?.username ?? undefined;
        if (!isUsernameAllowed(username)) {
          return new Response(
            JSON.stringify({ status: 'unauthorized_user' }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      } catch (authErr) {
        console.error('Authorization check failed:', authErr);
        return new Response(
          JSON.stringify({ status: 'unauthorized_user' }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const cronCallbackUrl = `${supabaseUrl}/functions/v1/natural-db`;

    let chatHistory: ChatMessage[] = [];
    let relevantContext: ChatMessage[] = [];

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

    let mcpTools: Record<string, unknown> = {};
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

    const baseTools = createTools({
      id,
      userId,
      metadata,
      timezone,
      cronCallbackUrl,
      callbackUrl,
      updateSystemPrompt,
    });

    const tools = { ...baseTools, ...mcpTools };

    let formattedSchemaDetails = `You are operating within your own private database schema.`;
    const schemaResult = await getChatSchemaDetailsFormatted();
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
        cronJobsResult.result.forEach((job: CronJob) => {
          activeCronJobsString += `  - Job Name: ${job.jobname}, Schedule: ${job.schedule}\n`;
        });
      }
    } catch (e: unknown) {
      activeCronJobsString = `Exception occurred while fetching scheduled routines: ${e}`;
    }

    const now = new Date();
    
    const customSystemPrompt = await getCurrentSystemPrompt(id);
    
    const baseSystemPrompt = `BASE BEHAVIOR: You are a highly organized personal assistant with your own private database workspace.

Private Database Schema:
${formattedSchemaDetails}

Scheduled Routines:
${activeCronJobsString}

Core Responsibilities:
- SQL Execution: Use 'execute_sql' for all DB operations within your private schema. Escape quotes ('').
- Data Modeling: For any recurring concept, create tables with relationships to ensure data can be recalled effectively. For example, if tracking workouts, create a 'workout_type' table and a 'workout' table that are related.
- Table Management: Before creating a new table, check if an existing one could serve the purpose.
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
- To update a scheduled prompt: first unschedule the existing job, then schedule a new one

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

    const selfModificationNote = `

PERSONALIZATION CAPABILITY:
You can personalize your behavior based on user needs by using the 'update_system_prompt' tool when users request changes to your personality, communication style, or specific capabilities. This allows you to evolve and adapt to user preferences while maintaining a history of all changes.

Use 'get_system_prompt_history' to view previous personalization versions and their descriptions.
`;

    const finalSystemPrompt = customSystemPrompt 
      ? `${baseSystemPrompt}\n\nPERSONALIZED BEHAVIOR:\n${customSystemPrompt}\n\n${selfModificationNote}`
      : `${baseSystemPrompt}${selfModificationNote}`;

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
        content: metadata.originalUserMessage as string
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
    const trimmedFinalResponse = finalResponse.trim();

    if (trimmedFinalResponse.length > 0) {
      const responseEmbedding = await generateMessageEmbedding(trimmedFinalResponse);
      await saveMessage(userId, trimmedFinalResponse, "assistant", id, responseEmbedding);

      if (callbackUrl) {
        const outgoingPayload = {
          finalResponse: trimmedFinalResponse,
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

    if (callbackUrl && raw?.id && raw?.metadata) {
      try {
        const errorResponse = "Sorry, an internal error occurred.";
        await saveMessage(raw.userId, errorResponse, "assistant", raw.id);
        
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            finalResponse: errorResponse,
            id: raw.id,
            userId: raw.userId,
            metadata: { ...raw.metadata, userId: raw.userId },
            timezone: raw.timezone,
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
