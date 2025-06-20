import { tool } from "npm:ai";
import { z } from "npm:zod";
import {
  executeRestrictedSQL,
  executePrivilegedSQL,
  convertBigIntsToStrings,
} from "./db-utils.ts";

// Local validation helpers (copied to keep file self-contained)
const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function isValidIdentifier(name: string): boolean {
  return IDENTIFIER_REGEX.test(name);
}

const JOB_NAME_REGEX = /^[a-zA-Z0-9_]+$/;
function isValidJobName(name: string): boolean {
  return JOB_NAME_REGEX.test(name);
}

interface ToolOptions {
  id: string | number;
  userId: string;
  metadata: Record<string, unknown>;
  timezone: string | null | undefined;
  cronCallbackUrl: string;
  callbackUrl: string;
  updateSystemPrompt: (
    chatId: string | number,
    newPrompt: string,
    description: string,
  ) => Promise<{ success: boolean; error?: string }>;
}

export function createTools(opts: ToolOptions) {
  const {
    id,
    userId,
    metadata,
    timezone,
    cronCallbackUrl,
    callbackUrl,
    updateSystemPrompt,
  } = opts;

  return {
    execute_sql: tool({
      description:
        `Executes SQL within your private schema. Create tables directly (e.g., CREATE TABLE my_notes). Escape single quotes ('') in string literals. You have full control over this isolated database space.`,
      parameters: z.object({
        query: z.string().describe("SQL query (DML/DDL)."),
      }),
      execute: async ({ query }) => {
        const result = await executeRestrictedSQL(query);
        if (result.error) return { error: result.error };

        const trimmed = query.trim();
        const rows = result.result ? convertBigIntsToStrings(result.result) : [];
        if (trimmed.toUpperCase().startsWith("SELECT") || rows.length > 0) {
          return JSON.stringify(rows);
        }
        return JSON.stringify({
          message: "Command executed successfully.",
          rowCount: Number(result.rowCount || 0),
        });
      },
    }),

    get_distinct_column_values: tool({
      description:
        `Retrieves distinct values for a column within your private schema. Use for columns with discrete values (e.g., status, category) rather than freeform text.`,
      parameters: z.object({
        table_name: z.string().describe("Table name."),
        column_name: z.string().describe("Column name."),
      }),
      execute: async ({ table_name, column_name }) => {
        if (!isValidIdentifier(table_name) || !isValidIdentifier(column_name)) {
          return { error: "Invalid table or column name format." };
        }
        const query = `SELECT DISTINCT "${column_name}" FROM ${table_name};`;
        const result = await executeRestrictedSQL(query);
        if (result.error) return { error: result.error };
        const values = result.result.map((row: Record<string, unknown>) => row[column_name]);
        return { distinct_values: convertBigIntsToStrings(values) };
      },
    }),

    schedule_prompt: tool({
      description: "Schedules a job to run at a future time using cron or ISO 8601 timestamp.",
      parameters: z.object({
        schedule_expression: z
          .string()
          .describe("Cron (e.g., '0 9 * * MON') or ISO timestamp."),
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
          metadata: { ...metadata, originalUserMessage: prompt_to_schedule },
          timezone,
          incomingMessageRole: "system_routine_task",
          callbackUrl,
        });

        const escapedPayload = payloadForCron.replace(/'/g, "''");
        let isOneOff = false;
        try {
          const date = new Date(schedule_expression);
          if (
            !isNaN(date.getTime()) &&
            schedule_expression.includes("T") &&
            (schedule_expression.includes("Z") || schedule_expression.match(/[+-]\d{2}:\d{2}$/))
          ) {
            isOneOff = true;
          }
        } catch (_) {}

        const descriptiveSuffix = job_name
          ? job_name.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 18)
          : Date.now().toString();

        // Sanitize id to prevent SQL injection
        const sanitizedId = String(id).replace(/[^a-zA-Z0-9_]/g, "_");
        
        const finalJobName = isOneOff
          ? `one_off_${sanitizedId}_${descriptiveSuffix}`
          : `cron_${sanitizedId}_${descriptiveSuffix}`;

        let sqlCommand: string;
        if (isOneOff) {
          const date = new Date(schedule_expression);
          const cronForTimestamp = `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${
            date.getUTCMonth() + 1
          } *`;
          const taskLogic =
            `PERFORM net.http_post(url := '${cronCallbackUrl}', body := '${escapedPayload}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb); ` +
            `PERFORM cron.unschedule('${finalJobName}');`;
          sqlCommand =
            `SELECT cron.schedule('${finalJobName}', '${cronForTimestamp}', $$ DO $job$ BEGIN ${taskLogic} EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Error job ${finalJobName}: %', SQLERRM; BEGIN PERFORM cron.unschedule('${finalJobName}'); RAISE NOTICE 'Unscheduled ${finalJobName} after error.'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'CRITICAL: Failed to unschedule ${finalJobName} after error: %', SQLERRM; END; RAISE; END; $job$; $$);`;
        } else {
          sqlCommand =
            `SELECT cron.schedule('${finalJobName}', '${schedule_expression}', $$ SELECT net.http_post(url := '${cronCallbackUrl}', body := '${escapedPayload}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb) $$);`;
        }

        const scheduleResult = await executePrivilegedSQL(sqlCommand);
        if (scheduleResult.error) return { error: scheduleResult.error };

        if (scheduleResult.result && scheduleResult.result.length > 0) {
          const jobIdResult = scheduleResult.result[0][Object.keys(scheduleResult.result[0])[0]];
          return `Job scheduled. Name: ${finalJobName || jobIdResult}. Type: ${isOneOff ? "One-off" : "Recurring"}`;
        }
        return { error: "Failed to schedule job: No confirmation from cron.schedule." };
      },
    }),

    unschedule_prompt: tool({
      description:
        "Unschedules a previously scheduled job by its job name. Use this to cancel or remove scheduled tasks.",
      parameters: z.object({
        job_name: z.string().describe(
          "The name of the job to unschedule (from schedule_prompt or visible in scheduled routines).",
        ),
      }),
      execute: async ({ job_name }) => {
        if (!job_name) return { error: "Job name is required for unscheduling." };
        if (!isValidJobName(job_name)) {
          return {
            error:
              "Invalid job name format. Job names should contain only letters, numbers, and underscores.",
          };
        }
        const sqlCommand = `SELECT cron.unschedule('${job_name}');`;
        const unscheduleResult = await executePrivilegedSQL(sqlCommand);
        if (unscheduleResult.error) return { error: unscheduleResult.error };
        return `Job '${job_name}' has been successfully unscheduled and removed.`;
      },
    }),

    update_system_prompt: tool({
      description:
        "Updates ONLY the personalized behavior section of the system prompt. The base system behavior (database operations, scheduling, etc.) never changes. Use this when the user wants to customize personality, communication style, or add specific behavioral preferences.",
      parameters: z.object({
        new_system_prompt: z
          .string()
          .describe(
            "ONLY the personalized behavior additions/changes - NOT the entire system prompt. Focus on personality, communication style, or specific user preferences. The base database and scheduling behavior remains unchanged.",
          ),
        description: z.string().describe(
          "Brief description of what this prompt change accomplishes or why it was made.",
        ),
      }),
      execute: async ({ new_system_prompt, description }) => {
        if (!id) return { error: "Chat ID is required to update system prompt." };
        const result = await updateSystemPrompt(id, new_system_prompt, description);
        return result.success
          ? `System prompt updated successfully. Description: ${description}. The new prompt will take effect in the next conversation.`
          : { error: result.error || "Failed to update system prompt." };
      },
    }),

    get_system_prompt_history: tool({
      description:
        "Retrieves the history of system prompt changes for this user, including versions and descriptions.",
      parameters: z.object({}),
      execute: async () => {
        if (!id) return { error: "Chat ID is required to retrieve system prompt history." };
        const query = `SELECT version, description, created_by_role, is_active, created_at, LENGTH(prompt_content) as prompt_length FROM system_prompts WHERE chat_id = $1 ORDER BY version DESC LIMIT 10;`;
        const result = await executePrivilegedSQL(query, [id.toString()]);
        if (result.error) return { error: result.error };
        return JSON.stringify(result.result);
      },
    }),
  };
} 