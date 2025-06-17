import { createClient } from "npm:@supabase/supabase-js";
import { createOpenAI } from "npm:@ai-sdk/openai";
import { generateText, tool } from "npm:ai";
import { z } from "npm:zod";
import { createClient as createSupabaseClient } from "npm:@supabase/supabase-js@2";

// Environment Variables
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const telegramWebhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
const openaiModel = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
const allowedUsernames = Deno.env.get("TELEGRAM_ALLOWED_USERNAMES");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

if (!supabaseUrl || !supabaseServiceRoleKey || !telegramBotToken || !openaiApiKey || !supabaseAnonKey) {
  throw new Error("Missing required environment variables");
}

const openai = createOpenAI({ apiKey: openaiApiKey });
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

interface Metadata {
  userId: string;
  platform?: string;
  telegramUserId?: number;
  telegramUsername?: string;
  chatId?: string | number;
}

interface CallbackAnswerPayload {
  callback_query_id: string;
  text?: string;
}

// Zod schemas for Telegram webhook validation
const TelegramUserSchema = z.object({
  id: z.number(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
}).passthrough();

const ChatSchema = z.object({
  id: z.union([z.string(), z.number()]),
}).passthrough();

const MessageSchema = z.object({
  text: z.string(),
  chat: ChatSchema,
  from: TelegramUserSchema,
}).passthrough();

const CallbackQuerySchema = z.object({
  id: z.string(),
  data: z.string(),
  from: TelegramUserSchema,
  message: z.object({
    chat: ChatSchema,
  }).passthrough(),
}).passthrough();

const UpdateSchema = z.object({
  message: MessageSchema.optional(),
  callback_query: CallbackQuerySchema.optional(),
}).passthrough();

async function answerCallbackQuery(callbackQueryId: string, text: string | null = null) {
  if (!telegramBotToken) return;

  const apiUrl = `https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`;
  const payload: CallbackAnswerPayload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const responseData = await response.json();
      console.error(`Failed to answer callback query: ${response.status}`, responseData);
    }
  } catch (error) {
    console.error("Error answering callback query:", error);
  }
}

async function sendTelegramMessage(chatId: string | number, text: string, parseMode: string = "HTML") {
  if (!telegramBotToken) return;

  const apiUrl = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  const messagePayload = {
    chat_id: chatId,
    text: text,
    parse_mode: parseMode,
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messagePayload),
    });

    if (!response.ok) {
      const responseData = await response.json();
      console.error(`Failed to send message: ${response.status}`, responseData);
    }
  } catch (error) {
    console.error("Error sending Telegram message:", error);
  }
}

function isUsernameAllowed(username: string | undefined): boolean {
  if (!allowedUsernames) return true;
  if (!username) return false;
  
  const allowedList = allowedUsernames.split(',').map(u => u.trim().toLowerCase());
  return allowedList.includes(username.toLowerCase());
}

const timezoneSystemPrompt = `You are a helpful assistant that helps users set their timezone for accurate time-based features.

Your task: Help the user set their timezone using the setTimezone tool, then ask what you can help with.

Timezone Processing:
1. UTC Format: Accept directly (UTC-5, UTC+1, UTC+5:30)
2. Location/City: Convert to UTC offset 
3. Named Zones: Convert abbreviations (EST→UTC-5, PST→UTC-8, CET→UTC+1, JST→UTC+9, etc.)
4. Unclear Input: Ask for clarification with examples

Common Conversions:
- US: EST/EDT(UTC-5/-4), PST/PDT(UTC-8/-7), MST/MDT(UTC-7/-6), CST/CDT(UTC-6/-5)
- Europe: CET/CEST(UTC+1/+2), GMT/BST(UTC+0/+1), EET(UTC+2)
- Asia: JST(UTC+9), CST China(UTC+8), IST(UTC+5:30)
- Australia: AEST(UTC+10), ACST(UTC+9:30), AWST(UTC+8)

Workflow:
1. If you can determine timezone from user input, call setTimezone tool
2. If successful, welcome them and ask what you can help with
3. If unclear, ask for clarification with examples

Be friendly and concise.`;

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const callbackUrl = `${supabaseUrl}/functions/v1/telegram-outgoing`;
  const aiFunctionName = "natural-db"; // Supabase Edge Function to invoke

  try {
    const body = await req.json();
    return await handleIncomingWebhook(body, callbackUrl, req.headers, aiFunctionName);
  } catch (error) {
    console.error("Error processing request:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
});

type TelegramUpdate = z.infer<typeof UpdateSchema>;

async function handleIncomingWebhook(body: unknown, callbackUrl: string, headers: Headers, aiFunctionName: string) {
  // Validate and parse webhook body
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    console.error("Invalid Telegram webhook payload:", parsed.error);
    return new Response("Bad Request", { status: 400 });
  }
  const update = parsed.data;

  let userPrompt: string | null = null;
  let telegramUserId: number | null = null;
  let chatId: string | number | null = null;
  let username: string | undefined = undefined;
  let firstName: string | undefined = undefined;
  let lastName: string | undefined = undefined;

  // Check webhook secret
  if (telegramWebhookSecret) {
    const secretHeader = headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== telegramWebhookSecret) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  // Parse webhook update using validated data
  if (update.message) {
    userPrompt = update.message.text;
    telegramUserId = update.message.from.id;
    chatId = update.message.chat.id;
    username = update.message.from.username;
    firstName = update.message.from.first_name;
    lastName = update.message.from.last_name;
  } else if (update.callback_query) {
    userPrompt = update.callback_query.data;
    telegramUserId = update.callback_query.from.id;
    chatId = update.callback_query.message.chat.id;
    username = update.callback_query.from.username;
    firstName = update.callback_query.from.first_name;
    lastName = update.callback_query.from.last_name;

    await answerCallbackQuery(update.callback_query.id);
  }

  if (!userPrompt || !telegramUserId || !chatId) {
    return new Response(JSON.stringify({ status: "received_not_processed" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }

  // Validate username
  if (!isUsernameAllowed(username)) {
    return new Response(JSON.stringify({ status: "unauthorized_user" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }

  // -------------------------------------------------------------------
  // 1. Sign in anonymously to obtain a user session & JWT
  // -------------------------------------------------------------------
  const anonClient = createSupabaseClient(supabaseUrl, supabaseAnonKey);
  const { data: anonData, error: anonErr } = await anonClient.auth.signInAnonymously();
  if (anonErr || !anonData?.session?.access_token || !anonData.user?.id) {
    console.error("Anonymous sign-in failed:", anonErr);
    return new Response("Auth error", { status: 500 });
  }

  const newUserId = anonData.user.id;
  const accessToken = anonData.session.access_token;

  // Create a single RLS-enabled Supabase client scoped to the current anonymous session
  const supabaseRls = createSupabaseClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    },
  );

  // -------------------------------------------------------------------
  // 2. Ensure profiles row exists & belongs to this user
  // -------------------------------------------------------------------
  let profileId: string | undefined;
  let userTimezone: string | null = null;
  try {
    // Check for existing profile by telegram_id
    const { data: existingProfiles, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("id, auth_user_id, timezone")
      .eq("telegram_id", telegramUserId)
      .maybeSingle();

    if (profErr) {
      throw profErr;
    }

    if (!existingProfiles) {
      const { data: insertProf, error: insErr } = await supabaseAdmin.from("profiles").insert({
        auth_user_id: newUserId,
        telegram_id: telegramUserId,
        telegram_username: username,
        first_name: firstName,
        last_name: lastName,
        timezone: null,
      }).select("id").single();
      if (insErr) throw insErr;
      profileId = insertProf.id;
    } else {
      profileId = existingProfiles.id;
      userTimezone = existingProfiles.timezone ?? null;
      if (existingProfiles.auth_user_id !== newUserId) {
        await supabaseAdmin.from("profiles").update({ auth_user_id: newUserId }).eq("id", profileId);
      }
    }
  } catch (e) {
    console.error("Profile upsert error:", e);
    return new Response("Profile error", { status: 500 });
  }

  if (!profileId) {
    return new Response("Profile not found", { status: 500 });
  }

  // -------------------------------------------------------------------
  // 3. Ensure chat and membership records exist
  // -------------------------------------------------------------------
  try {
    const chatIdText = chatId.toString();
    // Insert chat; if it already exists ignore duplicate error
    const { error: chatInsertErr } = await supabaseRls
      .from("chats")
      .insert({ id: chatIdText, title: null, created_by: profileId });
    if (chatInsertErr && chatInsertErr.code !== "23505") { // 23505 = unique_violation
      throw chatInsertErr;
    }

    // RLS-enabled client (scoped to the anonymous user)
    const { error: chatUserErr } = await supabaseRls
      .from("chat_users")
      .upsert({ chat_id: chatIdText, user_id: profileId }, { onConflict: "chat_id,user_id" });
    if (chatUserErr) {
      throw chatUserErr;
    }
  } catch (chatErr) {
    console.error("Error ensuring chat records:", chatErr);
    return new Response("Chat setup error", { status: 500 });
  }

  // -------------------------------------------------------------------
  // 4. Check timezone AFTER profile exists (only if still null)
  // -------------------------------------------------------------------

  if (!userTimezone) {
    try {
      const tools = {
        setTimezone: tool({
          description: "Set the user's timezone after determining it from their input",
          parameters: z.object({
            timezone: z.string().describe("Timezone in UTC format (e.g., 'UTC-5', 'UTC+1', 'UTC+5:30')"),
          }),
          execute: async ({ timezone }) => {
            const { error } = await supabaseAdmin
              .from("profiles")
              .update({ timezone })
              .eq("id", profileId);
            if (error) {
              return { success: false, message: "Failed to update timezone" };
            }
            return { success: true, message: `Timezone set to ${timezone}` };
          },
        }),
      };

      const result = await generateText({
        model: openai.responses(openaiModel),
        system: timezoneSystemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools,
        maxSteps: 3,
      });

      const outgoingPayload = {
        finalResponse: result.text,
        id: chatId,
        userId: profileId,
        metadata: {
          platform: "telegram",
          telegramUserId,
          telegramUsername: username,
          chatId,
        },
        timezone: null,
        incomingMessageRole: "user",
      };

      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outgoingPayload),
      });

      return new Response(
        JSON.stringify({ status: "timezone_setup_handled" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      console.error("Timezone setup error:", err);
      await sendTelegramMessage(
        chatId,
        "I need your timezone first. Please send it in UTC format (e.g., 'UTC-5').",
      );
      return new Response(
        JSON.stringify({ status: "timezone_setup_error" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Process AI request asynchronously with RLS client
  const processAiRequest = async () => {
    try {
      const payloadToAiDbHandler = {
        userPrompt,
        id: chatId.toString(),
        userId: profileId,
        metadata: {
          platform: "telegram",
          telegramUserId,
          telegramUsername: username,
          chatId,
        },
        timezone: null, // No timezone set yet
        incomingMessageRole: "user",
        callbackUrl: callbackUrl,
      };

      const { error } = await supabaseRls.functions.invoke(aiFunctionName, {
        body: payloadToAiDbHandler,
      });
      if (error) {
        console.error("Error invoking natural-db:", error);
      }
    } catch (error) {
      console.error("Error in async AI processing:", error);
    }
  };

  processAiRequest();

  return new Response(JSON.stringify({ status: "received" }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
