// --- Environment Variables ---
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN");

// --- Basic Validation ---
if (!telegramBotToken) {
  console.error(
    "Missing required environment variable for Telegram Outgoing handler. Check TELEGRAM_BOT_TOKEN."
  );
}

// --- Telegram Send Function ---
async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  parseMode: string = "HTML"
) {
  if (!telegramBotToken) {
    console.error(
      "Telegram Outgoing Handler: Telegram Bot Token not configured. Cannot send message."
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
    `Telegram Outgoing Handler: Attempting to send Telegram message to chat ${chatId}`
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
        `Telegram Outgoing Handler: Failed to send Telegram message. Status: ${
          response.status
        } ${response.statusText}, Response: ${JSON.stringify(responseData)}`
      );
    } else {
      console.log(
        "Telegram Outgoing Handler: Telegram message sent successfully:",
        responseData
      );
    }
  } catch (error) {
    console.error("Telegram Outgoing Handler: Error sending Telegram message:", error);
  }
}

Deno.serve(async (req) => {
  console.log(`Telegram Outgoing Handler: Request received: ${req.method} ${req.url}`);

  if (req.method !== "POST") {
    console.log(
      "Telegram Outgoing Handler: Method not allowed (should be POST):",
      req.method
    );
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    console.log(
      "Telegram Outgoing Handler: Raw JSON Payload:",
      JSON.stringify(body, null, 2)
    );

    const { finalResponse, id, userId, metadata } = body;

    if (!finalResponse || !id || !userId) {
      console.error(
        "Telegram Outgoing Handler: Missing finalResponse, id, or userId in request body."
      );
      return new Response("Invalid request body", { status: 400 });
    }

    // --- Get Chat ID from metadata ---
    const chatId = metadata?.chatId;

    if (!chatId) {
      console.error(
        `Telegram Outgoing Handler: Missing chatId in metadata for userId ${userId}`
      );
      return new Response("Missing chatId in metadata", {
        status: 400,
      });
    }

    console.log(
      `Telegram Outgoing Handler: Using Chat ID ${chatId} from metadata for userId ${userId}`
    );

    await sendTelegramMessage(chatId, finalResponse);

    return new Response(
      JSON.stringify({
        status: "message_sent",
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Telegram Outgoing Handler: Error processing request:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
});

console.log(
  "Telegram Outgoing Handler started. Handles sending messages to Telegram users."
); 