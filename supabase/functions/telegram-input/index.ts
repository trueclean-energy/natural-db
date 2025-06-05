import { createClient } from "npm:@supabase/supabase-js";
import { createOpenAI } from "npm:@ai-sdk/openai";
import { generateText } from "npm:ai";

// --- Environment Variables ---
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const telegramWebhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET"); // Optional secret token for webhook security
const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
const openaiModel = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
const allowedUsernames = Deno.env.get("TELEGRAM_ALLOWED_USERNAMES"); // Comma-separated list of allowed usernames

// --- Basic Validation ---
if (
  !supabaseUrl ||
  !supabaseServiceRoleKey ||
  !telegramBotToken ||
  !openaiApiKey
) {
  console.error(
    "Missing one or more required environment variables for Telegram handler. Check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, OPENAI_API_KEY."
  );
}

// Initialize OpenAI client
const openai = createOpenAI({
  apiKey: openaiApiKey,
});

// --- Initialize Supabase Client (Admin) - for auth operations only ---
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

// --- Define an interface for Metadata ---
interface Metadata {
  userId: string;
  platform?: string;
  telegramUserId?: number;
  telegramUsername?: string;
  chatId?: string | number;
}

// --- Telegram Answer Callback Query Function ---
async function answerCallbackQuery(
  callbackQueryId: string,
  text: string | null = null
) {
  if (!telegramBotToken) {
    console.error(
      "Telegram Input Handler: Telegram Bot Token not configured. Cannot answer callback query."
    );
    return;
  }

  const apiUrl = `https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`;
  const payload: any = {
    callback_query_id: callbackQueryId,
  };

  if (text) {
    payload.text = text;
  }

  console.log(`Telegram Input Handler: Answering callback query ${callbackQueryId}`);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const responseData = await response.json();
      console.error(
        `Telegram Input Handler: Failed to answer callback query. Status: ${
          response.status
        } ${response.statusText}, Response: ${JSON.stringify(responseData)}`
      );
    } else {
      console.log("Telegram Input Handler: Callback query answered successfully");
    }
  } catch (error) {
    console.error("Telegram Input Handler: Error answering callback query:", error);
  }
}

// --- Telegram Send Function ---
async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  parseMode: string = "HTML"
) {
  if (!telegramBotToken) {
    console.error(
      "Telegram Input Handler: Telegram Bot Token not configured. Cannot send message."
    );
    return;
  }

  const apiUrl = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  const messagePayload = {
    chat_id: chatId,
    text: text,
    parse_mode: parseMode,
  };

  console.log(
    `Telegram Input Handler: Attempting to send Telegram message to chat ${chatId}`
  );

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messagePayload),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error(
        `Telegram Input Handler: Failed to send Telegram message. Status: ${
          response.status
        } ${response.statusText}, Response: ${JSON.stringify(responseData)}`
      );
    } else {
      console.log(
        "Telegram Input Handler: Telegram message sent successfully:",
        responseData
      );
    }
  } catch (error) {
    console.error("Telegram Input Handler: Error sending Telegram message:", error);
  }
}

// --- Username Validation Function ---
function isUsernameAllowed(username: string | undefined): boolean {
  if (!allowedUsernames) {
    console.warn("Telegram Input Handler: TELEGRAM_ALLOWED_USERNAMES not configured. Allowing all users.");
    return true; // If no restriction is set, allow all
  }
  
  if (!username) {
    console.warn("Telegram Input Handler: User has no username. Rejecting message.");
    return false; // Reject users without usernames when restrictions are enabled
  }
  
  const allowedList = allowedUsernames.split(',').map(u => u.trim().toLowerCase());
  const isAllowed = allowedList.includes(username.toLowerCase());
  
  if (!isAllowed) {
    console.warn(`Telegram Input Handler: Username '${username}' not in allowed list. Rejecting message.`);
  }
  
  return isAllowed;
}

async function findOrCreateUser(
  telegramUserId: number,
  username: string | undefined,
  firstName: string | undefined,
  lastName: string | undefined
): Promise<string | null> {
  console.log(
    `Telegram Input Handler: Finding or creating user for Telegram ID: ${telegramUserId}`
  );

  // Check if user exists in auth.users via Telegram ID stored in user_metadata
  const { data: existingUsers, error: queryError } =
    await supabaseAdmin.auth.admin.listUsers();

  if (queryError) {
    console.error("Telegram Input Handler: Error querying auth.users:", queryError);
    return null;
  }

  let userId: string | null = null;

  // Look for existing user with this Telegram ID
  if (existingUsers && existingUsers.users) {
    const existingUser = existingUsers.users.find(
      (user) => user.user_metadata?.telegram_id === telegramUserId.toString()
    );

    if (existingUser) {
      userId = existingUser.id;
      console.log(
        `Telegram Input Handler: Found existing Auth user ID via Telegram ID: ${userId}`
      );
      return userId;
    }
  }

  // User does not exist in auth.users, create them via signInAnonymously
  console.log(
    `Telegram Input Handler: Creating new anonymous user for Telegram ID ${telegramUserId}.`
  );

  const { data: newAuthUserObj, error: createAuthUserError } =
    await supabaseAdmin.auth.signInAnonymously({
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

  if (createAuthUserError) {
    console.error(
      "Telegram Input Handler: Error creating Auth user:",
      createAuthUserError
    );
    return null;
  }

  if (!newAuthUserObj || !newAuthUserObj.user || !newAuthUserObj.user.id) {
    console.error(
      "Telegram Input Handler: Unexpected result from signInAnonymously"
    );
    return null;
  }

  userId = newAuthUserObj.user.id;
  console.log(
    `Telegram Input Handler: Successfully created Auth user ID: ${userId}`
  );

  return userId;
}

async function getUserTimezone(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    
    if (error) {
      console.error("Telegram Input Handler: Error fetching user timezone:", error);
      return null;
    }
    
    return data?.user?.user_metadata?.timezone || null;
  } catch (error) {
    console.error("Telegram Input Handler: Exception getting user timezone:", error);
    return null;
  }
}

async function updateUserTimezone(userId: string, timezone: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      user_metadata: { timezone }
    });
    
    if (error) {
      console.error("Telegram Input Handler: Error updating user timezone:", error);
      return false;
    }
    
    console.log(`Telegram Input Handler: Successfully updated timezone for user ${userId} to ${timezone}`);
    return true;
  } catch (error) {
    console.error("Telegram Input Handler: Exception updating user timezone:", error);
    return false;
  }
}

// --- Timezone System Prompt ---
const timezoneSystemPrompt = `You are a helpful assistant that helps users set their timezone. Your goal is to get the user's timezone in UTC format (e.g., "UTC-5" for New York, "UTC+1" for London).

Guidelines:
1. If the user provides their timezone in UTC format (e.g., "UTC-5"), accept it and respond with a confirmation.
2. If the user provides their location or city, convert it to UTC format and confirm with them.
3. If the user provides their timezone in another format (e.g., "EST", "GMT+1"), convert it to UTC format and confirm with them.
4. If the user's message is unclear, ask for clarification about their timezone.
5. Keep responses friendly and concise.

Common timezone conversions:
- New York: UTC-5
- London: UTC+1
- Tokyo: UTC+9
- Sydney: UTC+10
- Los Angeles: UTC-8
- Chicago: UTC-6
- Paris: UTC+1
- Berlin: UTC+1
- Moscow: UTC+3
- Dubai: UTC+4
- Singapore: UTC+8
- Beijing: UTC+8
- Mumbai: UTC+5:30
- Cape Town: UTC+2

Your response should be in this format:
{
  "timezone": "UTC+X" or null,
  "message": "Your response message"
}

If you've successfully identified a timezone, set the "timezone" field. Otherwise, set it to null and provide a helpful message in the "message" field.`;

// --- Handle Timezone Conversation ---
async function handleTimezoneConversation(userPrompt: string): Promise<{ timezone: string | null; message: string }> {
  try {
    const result = await generateText({
      model: openai.responses(openaiModel),
      system: timezoneSystemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    try {
      const response = JSON.parse(result.text);
      return {
        timezone: response.timezone,
        message: response.message
      };
    } catch (e) {
      console.error("Telegram Input Handler: Error parsing AI response:", e);
      return {
        timezone: null,
        message: "I'm having trouble understanding your timezone. Could you please provide it in UTC format (e.g., 'UTC-5' for New York, 'UTC+1' for London)?"
      };
    }
  } catch (e) {
    console.error("Telegram Input Handler: Error in timezone conversation:", e);
    return {
      timezone: null,
      message: "I'm having trouble processing your timezone. Could you please provide it in UTC format (e.g., 'UTC-5' for New York, 'UTC+1' for London)?"
    };
  }
}

// --- Timezone Request Message ---
const TIMEZONE_REQUEST_MESSAGE = `I notice I don't have your timezone set. This helps me provide accurate time-based information and reminders. Could you please send your timezone in the format "UTC+X" or "UTC-X" (e.g., "UTC-5" for New York, "UTC+1" for London)?`;

Deno.serve(async (req) => {
  console.log(`Telegram Input Handler: Request received: ${req.method} ${req.url}`);

  if (req.method !== "POST") {
    console.log(
      "Telegram Input Handler: Method not allowed (should be POST):",
      req.method
    );
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Get the callback URL for AI processing (telegram-outgoing)
  const callbackUrl = `${supabaseUrl}/functions/v1/telegram-outgoing`;

  // Derive the AI DB handler URL using the supabase URL environment variable
  const aiDbHandlerUrl = `${supabaseUrl}/functions/v1/natural-db`;

  console.log(`Telegram Input Handler: Using AI DB handler URL: ${aiDbHandlerUrl}`);

  try {
    const body = await req.json();
    console.log(
      "Telegram Input Handler: Raw JSON Payload:",
      JSON.stringify(body, null, 2)
    );

    // Handle incoming Telegram webhook
    console.log("Telegram Input Handler: Processing incoming Telegram webhook");
    return await handleIncomingWebhook(
      body,
      callbackUrl,
      req.headers,
      aiDbHandlerUrl
    );
  } catch (error) {
    console.error("Telegram Input Handler: Error processing request:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
});



// Handle incoming Telegram webhooks
async function handleIncomingWebhook(
  body: any,
  callbackUrl: string,
  headers: Headers,
  aiDbHandlerUrl: string
) {
  let userPrompt: string | null = null;
  let telegramUserId: number | null = null;
  let chatId: string | number | null = null;
  let username: string | undefined = undefined;
  let firstName: string | undefined = undefined;
  let lastName: string | undefined = undefined;
  const incomingMessageRole = "user"; // For direct messages from users

  // Check webhook secret token if provided
  if (telegramWebhookSecret) {
    const secretHeader = headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== telegramWebhookSecret) {
      console.warn("Telegram Input Handler: Invalid webhook secret token");
      return new Response("Forbidden", { status: 403 });
    }
  }

  // Parse Telegram webhook update
  if (body.message && body.message.text && body.message.from) {
    userPrompt = body.message.text;
    telegramUserId = body.message.from.id;
    chatId = body.message.chat.id;
    username = body.message.from.username;
    firstName = body.message.from.first_name;
    lastName = body.message.from.last_name;

    console.log(
      "Telegram Input Handler: Parsed Telegram User Message - From:",
      telegramUserId,
      "Chat:",
      chatId,
      "Username:",
      username,
      "Text:",
      userPrompt
    );
  } else if (body.callback_query) {
    // Handle callback queries from inline keyboards
    userPrompt = body.callback_query.data;
    telegramUserId = body.callback_query.from.id;
    chatId = body.callback_query.message.chat.id;
    username = body.callback_query.from.username;
    firstName = body.callback_query.from.first_name;
    lastName = body.callback_query.from.last_name;

    console.log(
      "Telegram Input Handler: Parsed Telegram Callback Query - From:",
      telegramUserId,
      "Chat:",
      chatId,
      "Data:",
      userPrompt
    );

    // Immediately acknowledge the callback query to prevent loading state and retries
    await answerCallbackQuery(body.callback_query.id);
  } else {
    console.log(
      "Telegram Input Handler: Received non-text message or unsupported update type. Ignoring."
    );
  }

  if (!userPrompt || !telegramUserId || !chatId) {
    console.warn(
      "Telegram Input Handler: Missing user prompt, Telegram user ID, or chat ID after parsing. Likely a non-message event or parse error. Acknowledging webhook."
    );
    return new Response(JSON.stringify({ status: "received_not_processed" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }

  // Validate username against allowed list
  if (!isUsernameAllowed(username)) {
    console.warn(
      `Telegram Input Handler: Message from unauthorized user rejected. Username: ${username}, Telegram ID: ${telegramUserId}`
    );
    return new Response(JSON.stringify({ status: "unauthorized_user" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }

  const userId = await findOrCreateUser(
    telegramUserId,
    username,
    firstName,
    lastName
  );
  if (!userId) {
    console.error(
      "Telegram Input Handler: Could not get or create userId for Telegram ID",
      telegramUserId
    );
    return new Response(JSON.stringify({ status: "error_user_setup" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }

  // Check for timezone
  const userTimezone = await getUserTimezone(userId);
  
  // If no timezone, handle timezone conversation
  if (!userTimezone) {
    const { timezone, message } = await handleTimezoneConversation(userPrompt);
    
    if (timezone) {
      const success = await updateUserTimezone(userId, timezone);
      if (success) {
        await sendTelegramMessage(chatId, `Thank you! I've set your timezone to ${timezone}.`);
        return new Response(JSON.stringify({ status: "timezone_updated" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }
    }
    
    await sendTelegramMessage(chatId, message);
    return new Response(JSON.stringify({ status: "timezone_requested" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }

  // Acknowledge Telegram's webhook IMMEDIATELY to prevent retries
  const immediateResponse = new Response(
    JSON.stringify({ status: "received" }),
    {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }
  );

  // Process AI DB Handler call asynchronously (don't await)
  const processAiRequest = async () => {
    try {
      // --- Prepare payload for AI DB Handler ---
      const payloadToAiDbHandler = {
        userPrompt,
        id: chatId.toString(), // Use chatId as the generic id
        userId, // Pass userId directly
        metadata: {
          platform: "telegram",
          telegramUserId,
          telegramUsername: username,
          chatId
        },
        timezone: userTimezone,
        incomingMessageRole,
        callbackUrl: callbackUrl, // Use self as callback
      };
      console.log(
        "Telegram Input Handler: Sending payload to AI DB Handler:",
        JSON.stringify(payloadToAiDbHandler)
      );

      // --- Call AI DB Handler Function ---
      const aiResponse = await fetch(aiDbHandlerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadToAiDbHandler),
      });

      if (!aiResponse.ok) {
        const errorBody = await aiResponse.text();
        console.error(
          `Telegram Input Handler: Error calling AI DB Handler. Status: ${aiResponse.status}. Body: ${errorBody}`
        );
      } else {
        console.log(
          "Telegram Input Handler: Successfully called AI DB Handler. AI processing is asynchronous."
        );
      }
    } catch (error) {
      console.error("Telegram Input Handler: Error in async AI processing:", error);
    }
  };

  // Start async processing but don't wait for it
  processAiRequest();

  // Return immediate acknowledgment to Telegram
  return immediateResponse;
}

console.log(
  "Telegram Input Handler started. Handles user management, timezone setup, and incoming webhook processing."
);
