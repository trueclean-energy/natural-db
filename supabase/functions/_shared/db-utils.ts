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

async function handleDbOperation(
  operationName: string,
  sqlLogic: (connection: any) => Promise<any>
) {
  const dbPool = ensureDbPool();
  let connection;
  
  try {
    connection = await dbPool.connect();
    await connection.queryObject(`SET search_path TO public, extensions, cron;`);
    
    const result = await sqlLogic(connection);
    return { result: convertBigIntsToStrings(result) };
  } catch (e: any) {
    console.error(`Operation error in ${operationName}:`, e);
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

export async function executeSQL(query: string) {
  return handleDbOperation("execute_sql", async (connection) => {
    const result = await connection.queryObject(query);
    return result.rows;
  });
}

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

  const result = await handleDbOperation("search_similar_messages", async (connection) => {
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
