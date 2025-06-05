# Telegram Bot Handler Setup Guide

This guide will help you set up Telegram bot handlers similar to your existing WhatsApp handlers.

## Overview

The Telegram handlers consist of two Supabase Edge Functions:

1. **`telegram-incoming-handler`** - Receives messages from Telegram Bot API webhooks
2. **`telegram-outgoing-handler`** - Sends messages back to users via Telegram Bot API

## Prerequisites

1. A Telegram Bot Token (obtained from @BotFather)
2. Existing Supabase project with the same database structure as your WhatsApp handlers
3. Supabase CLI installed and configured

## Step 1: Create Your Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Start a conversation and send `/newbot`
3. Follow the prompts to name your bot and choose a username
4. Save the Bot Token provided by BotFather

## Step 2: Environment Variables

Add these environment variables to your Supabase project:

### Required Variables:

```bash
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_OUTGOING_HANDLER_URL=https://your-project.supabase.co/functions/v1/telegram-outgoing-handler

# Optional Security (recommended)
TELEGRAM_WEBHOOK_SECRET=your_random_secret_string

# Existing variables (should already be set)
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
AI_DB_HANDLER_URL=your_ai_db_handler_url
SUPABASE_DB_URL=your_db_connection_string
OPENAI_API_KEY=your_openai_key
```

### Setting Variables in Supabase:

```bash
# Set via Supabase CLI
supabase secrets set TELEGRAM_BOT_TOKEN=your_bot_token_here
supabase secrets set TELEGRAM_OUTGOING_HANDLER_URL=https://your-project.supabase.co/functions/v1/telegram-outgoing-handler
supabase secrets set TELEGRAM_WEBHOOK_SECRET=your_random_secret_here

# Or set via Supabase Dashboard:
# Go to Settings > Edge Functions > Environment Variables
```

## Step 3: Deploy the Functions

Deploy both Telegram handler functions to Supabase:

```bash
# Deploy telegram incoming handler
supabase functions deploy telegram-incoming-handler

# Deploy telegram outgoing handler
supabase functions deploy telegram-outgoing-handler
```

## Step 4: Set Up Telegram Webhook

Once your functions are deployed, you need to configure Telegram to send updates to your incoming handler:

### Option A: Using curl

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<YOUR_PROJECT>.supabase.co/functions/v1/telegram-incoming-handler",
    "secret_token": "your_webhook_secret"
  }'
```

### Option B: Using browser

Visit this URL in your browser (replace `<YOUR_BOT_TOKEN>` and `<YOUR_PROJECT>`):

```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_PROJECT>.supabase.co/functions/v1/telegram-incoming-handler&secret_token=your_webhook_secret
```

### Verify Webhook Setup:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

## Step 5: Test Your Bot

1. Find your bot on Telegram using its username
2. Start a conversation by sending `/start` or any message
3. Check Supabase logs to see if messages are being processed:

```bash
supabase functions logs telegram-incoming-handler
supabase functions logs telegram-outgoing-handler
```

## Key Differences from WhatsApp Handler

### User Authentication

- **WhatsApp**: Uses phone numbers for user identification
- **Telegram**: Uses Telegram User IDs stored in `user_metadata`
- Creates unique email addresses like `telegram_123456@telegram.bot` for Supabase Auth

### Message Format

- **WhatsApp**: Uses WhatsApp Business API webhook format
- **Telegram**: Uses Telegram Bot API webhook format
- Supports both regular messages and callback queries (for inline keyboards)

### User Data Storage

Telegram users are stored with additional metadata:

```json
{
  "telegram_id": "123456789",
  "telegram_username": "username",
  "telegram_first_name": "John",
  "telegram_last_name": "Doe",
  "platform": "telegram"
}
```

## Supported Message Types

Currently supported:

- ✅ Text messages
- ✅ Callback queries (inline keyboard responses)

Not yet supported (can be added):

- ❌ Photos, videos, documents
- ❌ Voice messages
- ❌ Location sharing
- ❌ Inline queries

## Troubleshooting

### Common Issues:

1. **Bot not responding**

   - Check if webhook is set correctly: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
   - Verify environment variables are set in Supabase
   - Check function logs for errors

2. **Authentication errors**

   - Ensure `TELEGRAM_BOT_TOKEN` is correct
   - Verify webhook secret matches if using `TELEGRAM_WEBHOOK_SECRET`

3. **Database errors**

   - Confirm `SUPABASE_DB_URL` and other DB-related env vars are set
   - Check if the `messages` table exists and has proper permissions

4. **AI processing not working**
   - Verify `AI_DB_HANDLER_URL` points to your AI handler
   - Check if `TELEGRAM_OUTGOING_HANDLER_URL` is correctly set

### View Logs:

```bash
# Real-time logs
supabase functions logs telegram-incoming-handler --follow
supabase functions logs telegram-outgoing-handler --follow

# Recent logs
supabase functions logs telegram-incoming-handler
supabase functions logs telegram-outgoing-handler
```

## Advanced Configuration

### Adding Inline Keyboards

To add inline keyboards to responses, modify the `sendTelegramMessage` function in the outgoing handler:

```typescript
const messagePayload = {
  chat_id: chatId,
  text: text,
  parse_mode: parseMode,
  reply_markup: {
    inline_keyboard: [
      [
        { text: "Option 1", callback_data: "option_1" },
        { text: "Option 2", callback_data: "option_2" },
      ],
    ],
  },
};
```

### Adding Rich Text Formatting

The handlers support HTML formatting by default. You can use:

- `<b>bold</b>`
- `<i>italic</i>`
- `<code>monospace</code>`
- `<pre>preformatted</pre>`

## Security Considerations

1. **Use Webhook Secrets**: Always set `TELEGRAM_WEBHOOK_SECRET` for production
2. **Validate Input**: The handlers validate message structure but consider additional input validation
3. **Rate Limiting**: Consider implementing rate limiting for high-traffic bots
4. **Data Privacy**: Ensure compliance with data protection regulations when storing user data

## Next Steps

1. Test the bot with various message types
2. Monitor logs for any issues
3. Consider adding support for media messages if needed
4. Implement any custom business logic in the AI handler
5. Set up monitoring and alerting for production use
