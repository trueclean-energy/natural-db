import { createClient } from "npm:@supabase/supabase-js";

// Environment Variables
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const allowedUsernames = Deno.env.get("TELEGRAM_ALLOWED_USERNAMES");

if (!telegramBotToken) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable");
}

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

function isUsernameAllowed(username: string | undefined): boolean {
  if (!allowedUsernames) return true;
  if (!username) return false;
  const allowedList = allowedUsernames.split(',').map(u => u.trim().toLowerCase());
  return allowedList.includes(username.toLowerCase());
}

async function sendTelegramMessage(chatId: string | number, text: string, parseMode: string = "HTML") {
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

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const { finalResponse, id, userId, metadata } = body;

    if (!finalResponse || !id || !userId) {
      return new Response("Invalid request body", { status: 400 });
    }

    // ------------------------------------------------------------------
    //  Username Authorization Check (Telegram)
    // ------------------------------------------------------------------
    let telegramUsername: string | undefined = metadata?.telegramUsername;
    if (!telegramUsername) {
      try {
        const { data: prof, error: profErr } = await supabase
          .from('profiles')
          .select('telegram_username')
          .eq('id', userId)
          .single();
        if (!profErr) {
          telegramUsername = prof?.telegram_username ?? undefined;
        }
      } catch (_e) {
        // Silent failure; will be caught by authorization logic
      }
    }

    if (!isUsernameAllowed(telegramUsername)) {
      return new Response(
        JSON.stringify({ status: 'unauthorized_user' }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      );
    }

    const chatId = metadata?.chatId;
    if (!chatId) {
      return new Response("Missing chatId in metadata", { status: 400 });
    }

    // Verify that the user is a member of the chat
    try {
      const { data: membershipRow, error: membershipErr } = await supabase
        .from('chat_users')
        .select('chat_id')
        .eq('chat_id', chatId.toString())
        .eq('user_id', userId)
        .maybeSingle();

      if (membershipErr || !membershipRow) {
        return new Response("User not authorized for this chat", { status: 403 });
      }
    } catch (authCheckErr) {
      console.error('Chat membership check failed:', authCheckErr);
      return new Response("Authorization error", { status: 500 });
    }

    await sendTelegramMessage(chatId, finalResponse);

    return new Response(
      JSON.stringify({ status: "message_sent" }),
      {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Error processing request:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}); 