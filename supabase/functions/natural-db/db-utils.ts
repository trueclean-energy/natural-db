import * as postgres from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import type { Pool, PoolClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { createOpenAI } from "npm:@ai-sdk/openai";
import { embed } from "npm:ai";

// Database connection pool
type OpenAIClient = ReturnType<typeof createOpenAI>;

let pool: Pool | null = null;
let openai: OpenAIClient | null = null;

function ensureDbPool(): Pool {
  if (!pool) {
    const supabaseDbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (!supabaseDbUrl) {
      throw new Error("SUPABASE_DB_URL environment variable not set");
    }
    
    try {
      pool = new postgres.Pool(supabaseDbUrl, 3, true);
    } catch (e) {
      console.error("Failed to initialize PostgreSQL pool:", e);
      throw new Error("Failed to initialize database connection pool");
    }
  }
  return pool as Pool;
}

function ensureOpenAI(): OpenAIClient {
  if (!openai) {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable not set");
    }
    
    try {
      openai = createOpenAI({ apiKey });
    } catch (e) {
      console.error("Failed to initialize OpenAI client:", e);
      throw new Error("Failed to initialize OpenAI client");
    }
  }
  return openai as OpenAIClient;
}

// Convert BigInts to strings for JSON serialization
type ReplaceBigIntWithString<T> = 
  T extends bigint ? string :
  T extends Array<infer U> ? Array<ReplaceBigIntWithString<U>> :
  T extends object ? { [K in keyof T]: ReplaceBigIntWithString<T[K]> } :
  T;

export function convertBigIntsToStrings<T>(obj: T): ReplaceBigIntWithString<T> {
  if (obj === null) return obj as ReplaceBigIntWithString<T>;
  if (typeof obj === "bigint") return obj.toString() as ReplaceBigIntWithString<T>;
  if (Array.isArray(obj)) {
    return obj.map((item) => convertBigIntsToStrings(item)) as ReplaceBigIntWithString<T>;
  }
  if (typeof obj === "object") {
    const newObj: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        newObj[key] = convertBigIntsToStrings((obj as any)[key]);
      }
    }
    return newObj;
  }
  return obj as ReplaceBigIntWithString<T>;
}

// Handle database operations for LLM (in "memories" schema)
async function handleLLMDbOperation<T>(
  operationName: string,
  sqlLogic: (connection: PoolClient, schemaName: string) => Promise<T>
): Promise<SqlOutcome<T>> {
  const dbPool = ensureDbPool();
  let connection;
  const schemaName = "memories";
  const roleName = "memories_role";
  
  try {
    connection = await dbPool.connect();

    // Limit privileges by switching to the dedicated role and schema
    await connection.queryObject(`SET ROLE "${roleName}";`);
    await connection.queryObject(`SET search_path TO "${schemaName}";`);

    // Resource-safety guards (per-query)
    // Limit runtime to 3 s and disable parallel plans so a single tenant cannot monopolise CPU cores.
    await connection.queryObject(`SET LOCAL statement_timeout = 3000;`);
    await connection.queryObject(`SET LOCAL max_parallel_workers_per_gather = 0;`);

    const result = await sqlLogic(connection, schemaName);
    return { result: convertBigIntsToStrings(result) };
  } catch (e: unknown) {
    const err = e as { message?: string; fields?: Record<string, { code?: string }> };
    console.error(`LLM operation error in ${operationName}:`, err);
    return {
      error: `Execution failed for ${operationName}: ${err.message ?? "Unknown error"}${
        (err as any).fields?.code ? ` (Code: ${(err as any).fields.code})` : ""
      }`,
    };
  } finally {
    // Ensure the connection role is reset before releasing it back to the pool
    if (connection) {
      try {
        await connection.queryObject(`RESET ROLE;`);
      } catch (_) {
        // ignore – RESET ROLE requires no special handling; best-effort
      }
    }
    if (connection) {
      try { connection.release(); } catch (_) {}
    }
  }
}

// Handle database operations for system functions (public schema access)
async function handleSystemDbOperation<T>(
  operationName: string,
  sqlLogic: (connection: PoolClient) => Promise<T>
): Promise<SqlOutcome<T>> {
  const dbPool = ensureDbPool();
  let connection;
  
  try {
    connection = await dbPool.connect();
    // Allow access to required schemas
    await connection.queryObject(`SET search_path TO public, extensions, cron;`);
    
    const result = await sqlLogic(connection);
    return { result: convertBigIntsToStrings(result) };
  } catch (e: unknown) {
    const err = e as { message?: string; fields?: Record<string, { code?: string }> };
    console.error(`System operation error in ${operationName}:`, err);
    return {
      error: `Execution failed for ${operationName}: ${err.message ?? "Unknown error"}${
        (err as any).fields?.code ? ` (Code: ${(err as any).fields.code})` : ""
      }`,
    };
  } finally {
    if (connection) {
      try {
        connection.release();
      } catch (releaseError) {
        console.error(`Error releasing connection after ${operationName}:`, releaseError);
      }
    }
  }
}

// ----------------------------------------------
// Typed result wrapper (very light)
export interface SqlOutcome<T = unknown> {
  result?: T;
  error?: string;
}

// Restricted execution used by LLM – confined to memories schema / role
export async function executeRestrictedSQL<T = unknown>(
  text: string,
  args: unknown[] = [],
): Promise<SqlOutcome<T[]>> {
  return handleLLMDbOperation("execute_restricted_sql", async (connection) => {
    const result = await connection.queryObject({ text, args });
    return result.rows;
  });
}

// Privileged execution (service_role) for internal features like cron management
export async function executePrivilegedSQL<T = unknown>(
  text: string,
  args: unknown[] = [],
): Promise<SqlOutcome<T[]>> {
  return handleSystemDbOperation("execute_privileged_sql", async (connection) => {
    const result = await connection.queryObject({ text, args });
    return result.rows;
  });
}

// Get schema details for the "memories" schema
export async function getMemoriesSchemaDetails() {
  return handleLLMDbOperation("get_memories_schema_details", async (connection, schemaName) => {
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
              isc.table_schema = $1
          ORDER BY
              isc.table_name,
              isc.ordinal_position
      ) AS info;
    `;

    const result = await connection.queryObject({
      text: query,
      args: [schemaName]
    });

    return result.rows;
  });
}

// System function for searching similar messages (uses public schema)
export async function searchSimilarMessages(
  userId: string,
  embedding: string,
  maxResults: number = 5,
  similarityThreshold: number = 0.7,
  chatId?: string | number
) {
  if (!chatId) {
    return { result: [], error: null };
  }

  const result = await handleSystemDbOperation("search_similar_messages", async (connection) => {
    // Use parameterized query to safely pass the embedding vector
    const result = await connection.queryObject({
      text: `
        SELECT m.role,
               CASE WHEN m.role = 'user' THEN CONCAT(COALESCE(p.first_name, 'User'), ': ', m.content) ELSE m.content END as content,
               m.created_at,
               1 - (m.embedding <=> $1) as similarity_score
        FROM public.messages m
        LEFT JOIN public.profiles p ON p.auth_user_id = m.user_id
        WHERE chat_id = $2
          AND embedding IS NOT NULL
          AND content IS NOT NULL
          AND content != ''
          AND 1 - (m.embedding <=> $1) > $3
        ORDER BY m.embedding <=> $1
        LIMIT $4;
      `,
      args: [embedding, chatId.toString(), similarityThreshold, maxResults]
    });
    return result.rows;
  });

  return result;
}

// System function for loading recent messages (uses public schema)
export async function loadRecentMessages(
  supabaseClient: any,
  userId: string,
  limit: number = 10,
  chatId?: string | number
) {
  try {
    if (!chatId) {
      return { result: [], error: null };
    }

    const query = supabaseClient
      .from("messages")
      .select("role, content, created_at, profiles ( first_name )")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(limit);

    const { data: recentMessages, error: recentError } = await query;

    if (recentError) {
      console.error("Error loading recent messages:", recentError);
      return { error: recentError.message, result: null };
    }

    // Typed representation of a row returned from the `messages` view
    interface MessageRow {
      role: string;
      content: string;
      created_at: string;
      profiles?: { first_name?: string } | null;
    }

    const chronologicalMessages = (recentMessages || [])
      .reverse()
      .map((msg: MessageRow) => {
        const firstName = msg.profiles?.first_name;
        return {
          role: msg.role,
          content:
            msg.role === "user" && firstName
              ? `${firstName}: ${msg.content}`
              : msg.content,
          created_at: msg.created_at,
        };
      });

    return { result: chronologicalMessages, error: null };
  } catch (error) {
    console.error("Exception loading recent messages:", error);
    return { error: "Exception loading recent messages", result: null };
  }
}

// System function for inserting messages (uses public schema)
export async function insertMessage(
  supabaseClient: any,
  userId: string,
  content: string,
  role: string,
  chatId?: string | number,
  embedding?: string
) {
  try {
    const messageData = {
      user_id: userId,
      role,
      content,
      chat_id: chatId,
      embedding
    };

    const { data, error } = await supabaseClient
      .from("messages")
      .insert(messageData)
      .select();

    if (error) {
      console.error("Error inserting message:", error);
      return { error: error.message, result: null };
    }

    return { result: data?.[0] || null, error: null };
  } catch (e) {
    console.error("Exception inserting message:", e);
    return { error: "Exception inserting message", result: null };
  }
}

export async function generateEmbedding(text: string) {
  const openaiClient = ensureOpenAI();

  try {
    const { embedding } = await embed({
      model: openaiClient.embedding("text-embedding-3-small"),
      value: text,
    });
    return JSON.stringify(embedding);
  } catch (error) {
    console.error("Error generating embedding:", error);
    throw error;
  }
}

// System function for loading recent and relevant messages (uses public schema)
export async function loadRecentAndRelevantMessages(
  supabaseClient: any,
  userId: string,
  currentPrompt: string,
  maxChatHistory: number = 10,
  maxRelevantMessages: number = 5,
  chatId?: string | number
) {
  try {
    const recentResult = await loadRecentMessages(
      supabaseClient,
      userId,
      maxChatHistory,
      chatId
    );

    if (recentResult.error) {
      console.error("Error loading recent messages:", recentResult.error);
      return { chronologicalMessages: [], relevantContext: [] };
    }

    const chronologicalMessages = recentResult.result || [];
    let relevantContext: Array<{
      role: string;
      content: string;
      created_at: string;
      similarity_score?: number;
    }> = [];

    if (currentPrompt?.trim() && chronologicalMessages.length > 0) {
      try {
        const promptEmbedding = await generateEmbedding(currentPrompt);
        const similarMessagesResult = await searchSimilarMessages(
          userId,
          promptEmbedding,
          maxRelevantMessages,
          0.7,
          chatId
        );

        if (similarMessagesResult.error) {
          console.error("Error finding similar messages:", similarMessagesResult.error);
        } else {
          const chronologicalSet = new Set(
            chronologicalMessages.map(msg => `${msg.role}:${msg.content}`)
          );
          
          relevantContext = (similarMessagesResult.result || []).filter(msg => 
            !chronologicalSet.has(`${msg.role}:${msg.content}`)
          );
        }
      } catch (error) {
        console.error("Error finding relevant messages:", error);
      }
    }

    return { chronologicalMessages, relevantContext };
  } catch (error) {
    console.error("Exception in loadRecentAndRelevantMessages:", error);
    return { chronologicalMessages: [], relevantContext: [] };
  }
}
