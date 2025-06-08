import * as postgres from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { createOpenAI } from "npm:@ai-sdk/openai";
import { embed } from "npm:ai";

// Database connection pool
let pool: any;

// OpenAI client
let openai: any;

function ensureDbPool() {
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
  return pool;
}

function ensureOpenAI() {
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
  return openai;
}

// Convert BigInts to strings for JSON serialization
export function convertBigIntsToStrings(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(convertBigIntsToStrings);

  const newObj: any = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (typeof value === "bigint") newObj[key] = value.toString();
      else if (typeof value === "object")
        newObj[key] = convertBigIntsToStrings(value);
      else newObj[key] = value;
    }
  }
  return newObj;
}

// Generate safe schema name from chat_id
function generateSchemaName(chatId: string | number): string {
  // Replace any non-alphanumeric characters with underscores and add prefix
  const sanitized = chatId.toString().replace(/[^a-zA-Z0-9]/g, '_');
  return `chat_${sanitized}`;
}

// Create schema for a chat if it doesn't exist
async function ensureChatSchema(connection: any, chatId: string | number): Promise<string> {
  const schemaName = generateSchemaName(chatId);
  
  try {
    // Check if schema exists
    const schemaCheck = await connection.queryObject({
      text: "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
      args: [schemaName]
    });

    if (schemaCheck.rows.length === 0) {
      // Create schema if it doesn't exist
      await connection.queryObject(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
      
      // Grant necessary permissions for the schema
      // The current database user should have full access to the schema they create
      await connection.queryObject(`GRANT USAGE ON SCHEMA "${schemaName}" TO CURRENT_USER`);
      await connection.queryObject(`GRANT CREATE ON SCHEMA "${schemaName}" TO CURRENT_USER`);
      
      console.log(`Created schema: ${schemaName}`);
    }
    
    return schemaName;
  } catch (error) {
    console.error(`Error creating schema ${schemaName}:`, error);
    throw error;
  }
}

// Handle database operations for LLM (chat-specific schema only)
async function handleLLMDbOperation(
  operationName: string,
  chatId: string | number,
  sqlLogic: (connection: any, schemaName: string) => Promise<any>
) {
  const dbPool = ensureDbPool();
  let connection;
  
  try {
    connection = await dbPool.connect();
    
    // Create and ensure chat schema exists
    const schemaName = await ensureChatSchema(connection, chatId);
    
    // Set search path to ONLY the chat schema and essential system schemas
    // Explicitly exclude public to prevent LLM from accessing system tables
    await connection.queryObject(`SET search_path TO "${schemaName}", extensions, cron;`);
    
    const result = await sqlLogic(connection, schemaName);
    return { result: convertBigIntsToStrings(result) };
  } catch (e: any) {
    console.error(`LLM operation error in ${operationName}:`, e);
    return {
      error: `Execution failed for ${operationName}: ${e.message}${
        e.fields?.code ? ` (Code: ${e.fields.code})` : ""
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

// Handle database operations for system functions (public schema access)
async function handleSystemDbOperation(
  operationName: string,
  sqlLogic: (connection: any) => Promise<any>
) {
  const dbPool = ensureDbPool();
  let connection;
  
  try {
    connection = await dbPool.connect();
    // System operations have access to public schema for messages, system_prompts, etc.
    await connection.queryObject(`SET search_path TO public, extensions, cron;`);
    
    const result = await sqlLogic(connection);
    return { result: convertBigIntsToStrings(result) };
  } catch (e: any) {
    console.error(`System operation error in ${operationName}:`, e);
    return {
      error: `Execution failed for ${operationName}: ${e.message}${
        e.fields?.code ? ` (Code: ${e.fields.code})` : ""
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

// LLM SQL execution - operates only within chat-specific schema
export async function executeSQL(query: string, chatId: string | number) {
  if (!chatId) {
    return { error: "Chat ID is required for SQL execution" };
  }

  return handleLLMDbOperation("execute_sql", chatId, async (connection, schemaName) => {
    const result = await connection.queryObject(query);
    return result.rows;
  });
}

// Get schema details for a specific chat
export async function getChatSchemaDetails(chatId: string | number) {
  if (!chatId) {
    return { error: "Chat ID is required" };
  }

  return handleLLMDbOperation("get_chat_schema_details", chatId, async (connection, schemaName) => {
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
    // Set IVFFlat probes for better recall (balances speed vs accuracy)
    await connection.queryObject("SET ivfflat.probes = 3;");
    
    // Use parameterized query to safely pass the embedding vector
    const result = await connection.queryObject({
      text: `
        SELECT role, content, created_at, 
               1 - (embedding <=> $1) as similarity_score
        FROM public.messages 
        WHERE chat_id = $2
          AND embedding IS NOT NULL
          AND content IS NOT NULL
          AND content != ''
          AND 1 - (embedding <=> $1) > $3
        ORDER BY embedding <=> $1
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
      .select("role, content, created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(limit);

    const { data: recentMessages, error: recentError } = await query;

    if (recentError) {
      console.error("Error loading recent messages:", recentError);
      return { error: recentError.message, result: null };
    }

    const chronologicalMessages = (recentMessages || []).reverse();
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
    return `[${embedding.join(",")}]`;
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
    let relevantContext: any[] = [];

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
