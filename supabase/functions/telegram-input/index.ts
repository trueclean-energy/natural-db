import { createClient } from "npm:@supabase/supabase-js";
import { createOpenAI } from "npm:@ai-sdk/openai";
import { generateText, tool } from "npm:ai";
import { z } from "npm:zod";

// Environment Variables
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const telegramWebhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
const openaiModel = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
const allowedUsernames = Deno.env.get("TELEGRAM_ALLOWED_USERNAMES");

if (!supabaseUrl || !supabaseServiceRoleKey || !telegramBotToken || !openaiApiKey) {
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

async function answerCallbackQuery(callbackQueryId: string, text: string | null = null) {
  if (!telegramBotToken) return;

  const apiUrl = `https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`;
  const payload: any = { callback_query_id: callbackQueryId };
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

async function findOrCreateUser(
  telegramUserId: number,
  username: string | undefined,
  firstName: string | undefined,
  lastName: string | undefined
): Promise<string | null> {
  const { data: existingUsers, error: queryError } = await supabaseAdmin.auth.admin.listUsers();
  if (queryError) {
    console.error("Error querying auth.users:", queryError);
    return null;
  }

  if (existingUsers?.users) {
    const existingUser = existingUsers.users.find(
      (user) => user.user_metadata?.telegram_id === telegramUserId.toString()
    );
    if (existingUser) return existingUser.id;
  }

  const { data: newAuthUserObj, error: createAuthUserError } = await supabaseAdmin.auth.signInAnonymously({
    options: {
      data: {
        telegram_id: telegramUserId.toString(),
        telegram_username: username,
        telegram_first_name: firstName,
        telegram_last_name: lastName,
        platform: "telegram",
      }
    }
  });

  if (createAuthUserError || !newAuthUserObj?.user?.id) {
    console.error("Error creating Auth user:", createAuthUserError);
    return null;
  }

  return newAuthUserObj.user.id;
}

async function getUserTimezone(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) return null;
    return data?.user?.user_metadata?.timezone || null;
  } catch (error) {
    return null;
  }
}

async function updateUserTimezone(userId: string, timezone: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      user_metadata: { timezone }
    });
    return !error;
  } catch (error) {
    return false;
  }
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
  const aiDbHandlerUrl = `${supabaseUrl}/functions/v1/natural-db`;

  try {
    const body = await req.json();
    return await handleIncomingWebhook(body, callbackUrl, req.headers, aiDbHandlerUrl);
  } catch (error) {
    console.error("Error processing request:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
});

async function handleIncomingWebhook(body: any, callbackUrl: string, headers: Headers, aiDbHandlerUrl: string) {
  let userPrompt: string | null = null;
  let telegramUserId: number | null = null;
  let chatId: string | number | null = null;
  let username: string | undefined = undefined;
  let firstName: string | undefined = undefined;
  let lastName: string | undefined = undefined;
  const incomingMessageRole = "user";

  // Check webhook secret
  if (telegramWebhookSecret) {
    const secretHeader = headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== telegramWebhookSecret) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  // Parse webhook update
  if (body.message?.text && body.message?.from) {
    userPrompt = body.message.text;
    telegramUserId = body.message.from.id;
    chatId = body.message.chat.id;
    username = body.message.from.username;
    firstName = body.message.from.first_name;
    lastName = body.message.from.last_name;
  } else if (body.callback_query) {
    userPrompt = body.callback_query.data;
    telegramUserId = body.callback_query.from.id;
    chatId = body.callback_query.message.chat.id;
    username = body.callback_query.from.username;
    firstName = body.callback_query.from.first_name;
    lastName = body.callback_query.from.last_name;

    await answerCallbackQuery(body.callback_query.id);
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

  const userId = await findOrCreateUser(telegramUserId, username, firstName, lastName);
  if (!userId) {
    return new Response(JSON.stringify({ status: "error_user_setup" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }

  // Check timezone and handle setup if needed
  const userTimezone = await getUserTimezone(userId);
  
  if (!userTimezone) {
    // Handle timezone setup using AI with tools
    try {
      const tools = {
        setTimezone: tool({
          description: "Set the user's timezone after determining it from their input",
          parameters: z.object({
            timezone: z.string().describe("Timezone in UTC format (e.g., 'UTC-5', 'UTC+1', 'UTC+5:30')"),
          }),
          execute: async ({ timezone }) => {
            const success = await updateUserTimezone(userId, timezone);
            if (success) {
              return { success: true, message: `Timezone set to ${timezone}` };
            } else {
              return { success: false, message: "Failed to update timezone" };
            }
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

      // Send AI response via telegram-outgoing
      const outgoingPayload = {
        finalResponse: result.text,
        id: chatId,
        userId,
        metadata: {
          platform: "telegram",
          telegramUserId,
          telegramUsername: username,
          chatId
        },
        timezone: null, // No timezone set yet
      };

      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outgoingPayload),
      });

      return new Response(JSON.stringify({ status: "timezone_setup_handled" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    } catch (error) {
      console.error("Error in timezone setup:", error);
      
      // Fallback to direct message
      await sendTelegramMessage(chatId, "I need to set up your timezone first. Could you please provide it in UTC format (e.g., 'UTC-5' for New York, 'UTC+1' for London)?");
      
      return new Response(JSON.stringify({ status: "timezone_setup_error" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }
  }

  // Process AI request asynchronously
  const processAiRequest = async () => {
    try {
      const payloadToAiDbHandler = {
        userPrompt,
        id: chatId.toString(),
        userId,
        metadata: {
          platform: "telegram",
          telegramUserId,
          telegramUsername: username,
          chatId
        },
        timezone: userTimezone,
        incomingMessageRole,
        callbackUrl: callbackUrl,
      };

      const aiResponse = await fetch(aiDbHandlerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadToAiDbHandler),
      });

      if (!aiResponse.ok) {
        console.error(`Error calling AI DB Handler: ${aiResponse.status}`);
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
