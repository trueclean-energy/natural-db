import * as postgres from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { createOpenAI } from "npm:@ai-sdk/openai";
import { embed } from "npm:ai";

// Database connection pool
let pool: any;

// OpenAI client
let openai: any;

// Internal function to initialize database pool if needed
function ensureDbPool() {
  if (!pool) {
    const supabaseDbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (supabaseDbUrl) {
      try {
        pool = new postgres.Pool(supabaseDbUrl, 3, true);
        console.log("DB Utils: PostgreSQL connection pool initialized.");
      } catch (e) {
        console.error("DB Utils: Failed to init PostgreSQL pool:", e);
        throw new Error("Failed to initialize database connection pool");
      }
    } else {
      throw new Error("SUPABASE_DB_URL environment variable not set");
    }
  }
  return pool;
}

// Internal function to initialize OpenAI client if needed
function ensureOpenAI() {
  if (!openai) {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (apiKey) {
      try {
        openai = createOpenAI({
          apiKey: apiKey,
        });
        console.log("DB Utils: OpenAI client initialized.");
      } catch (e) {
        console.error("DB Utils: Failed to init OpenAI client:", e);
        throw new Error("Failed to initialize OpenAI client");
      }
    } else {
      throw new Error("OPENAI_API_KEY environment variable not set");
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

// Generic database operation handler
async function handleDbOperation(
  operationName: string,
  sqlLogic: (connection: any) => Promise<any>
) {
  const dbPool = ensureDbPool();

  let connection;
  try {
    connection = await dbPool.connect();

    // Always set search_path to public, extensions, cron for all operations
    await connection.queryObject(
      `SET search_path TO public, extensions, cron;`
    );

    const result = await sqlLogic(connection);
    return {
      result: convertBigIntsToStrings(result),
    };
  } catch (e: any) {
    console.error(`DB Utils: Operation Error in ${operationName}:`, e);
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
        console.error(
          `DB Utils: Error releasing DB connection after ${operationName}:`,
          releaseError
        );
      }
    }
  }
}

// Execute raw SQL query
export async function executeSQL(query: string) {
  return handleDbOperation("execute_sql", async (connection) => {
    const result = await connection.queryObject(query);
    return result.rows;
  });
}

// Search for similar messages using vector similarity
export async function searchSimilarMessages(
  userId: string,
  embedding: string,
  maxResults: number = 5,
  similarityThreshold: number = 0.7,
  chatId?: string | number
) {
  if (!chatId) {
    console.warn("DB Utils: searchSimilarMessages called without chatId, returning empty result");
    return { result: [], error: null };
  }

  const query = `
    SELECT role, content, created_at, 
           1 - (embedding <=> '${embedding}'::vector) as similarity_score
    FROM public.messages 
    WHERE chat_id = '${chatId}'
      AND embedding IS NOT NULL
      AND content IS NOT NULL
      AND content != ''
    ORDER BY embedding <=> '${embedding}'::vector
    LIMIT ${maxResults};
  `;

  const result = await handleDbOperation("search_similar_messages", async (connection) => {
    const result = await connection.queryObject(query);
    return result.rows.filter(
      (row: any) => row.similarity_score > similarityThreshold
    );
  });

  return result;
}

// Load recent messages for a user using Supabase client
export async function loadRecentMessages(
  supabaseClient: any,
  userId: string,
  limit: number = 10,
  chatId?: string | number
) {
  try {
    if (!chatId) {
      console.warn("DB Utils: loadRecentMessages called without chatId, returning empty result");
      return { result: [], error: null };
    }

    let query = supabaseClient
      .from("messages")
      .select("role, content, created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(limit);

    const { data: recentMessages, error: recentError } = await query;

    if (recentError) {
      console.error("DB Utils: Error loading recent messages:", recentError);
      return { error: recentError.message, result: null };
    }

    // Reverse the messages to get them in chronological order (oldest to newest)
    const chronologicalMessages = (recentMessages || []).reverse();

    return { result: chronologicalMessages, error: null };
  } catch (error) {
    console.error("DB Utils: Exception loading recent messages:", error);
    return { error: "Exception loading recent messages", result: null };
  }
}

// Insert a new message using Supabase client
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
      console.error("DB Utils: Error inserting message:", error);
      return { error: error.message, result: null };
    }

    return { result: data?.[0] || null, error: null };
  } catch (e) {
    console.error("DB Utils: Exception inserting message:", e);
    return { error: "Exception inserting message", result: null };
  }
}

// Generate embedding using OpenAI
export async function generateEmbedding(text: string) {
  const openaiClient = ensureOpenAI();

  try {
    const { embedding } = await embed({
      model: openaiClient.embedding("text-embedding-3-small"),
      value: text,
    });
    return `[${embedding.join(",")}]`; // Convert to PostgreSQL array format
  } catch (error) {
    console.error("DB Utils: Error generating embedding:", error);
    throw error;
  }
}

// Combined function to load recent and relevant messages (like in the handlers)
export async function loadRecentAndRelevantMessages(
  supabaseClient: any,
  userId: string,
  currentPrompt: string,
  maxChatHistory: number = 10,
  maxRelevantMessages: number = 5,
  chatId?: string | number
) {
  try {
    // Load recent messages first using Supabase client
    const recentResult = await loadRecentMessages(
      supabaseClient,
      userId,
      maxChatHistory,
      chatId
    );

    if (recentResult.error) {
      console.error(
        "DB Utils: Error loading recent messages:",
        recentResult.error
      );
      return { chronologicalMessages: [], relevantContext: [] };
    }

    let chronologicalMessages = recentResult.result || [];
    let relevantContext: any[] = [];

    // If we have content to search against and there are existing messages, find relevant ones
    if (
      currentPrompt &&
      currentPrompt.trim().length > 0 &&
      chronologicalMessages.length > 0
    ) {
      try {
        // Generate embedding for current prompt
        const promptEmbedding = await generateEmbedding(currentPrompt);

        // Search for similar messages
        const similarMessagesResult = await searchSimilarMessages(
          userId,
          promptEmbedding,
          maxRelevantMessages,
          0.7,
          chatId
        );

        if (similarMessagesResult.error) {
          console.error(
            "DB Utils: Error finding similar messages:",
            similarMessagesResult.error
          );
        } else {
          // Get relevant messages that aren't already in chronological messages
          const chronologicalSet = new Set(
            chronologicalMessages.map(msg => `${msg.role}:${msg.content}`)
          );
          
          relevantContext = (similarMessagesResult.result || []).filter(msg => 
            !chronologicalSet.has(`${msg.role}:${msg.content}`)
          );

          console.log("DB Utils: chronologicalMessages", chronologicalMessages);
          console.log("DB Utils: relevantContext", relevantContext);
        }
      } catch (error) {
        console.error(
          "DB Utils: Error finding relevant messages:",
          error
        );
      }
    }

    return { chronologicalMessages, relevantContext };
  } catch (error) {
    console.error(
      "DB Utils: Exception in loadRecentAndRelevantMessages:",
      error
    );
    return { chronologicalMessages: [], relevantContext: [] };
  }
}
