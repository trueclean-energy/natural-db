// Environment Variables
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN");

if (!telegramBotToken) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable");
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

    const chatId = metadata?.chatId;
    if (!chatId) {
      return new Response("Missing chatId in metadata", { status: 400 });
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