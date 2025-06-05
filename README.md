# Simplified Edge Functions - Public Schema Only

This repository contains simplified versions of the AI DB handler and Telegram handlers that have been stripped of entity-specific schema functionality while maintaining vector/embedding features. These functions operate exclusively within the public PostgreSQL schema.

## What's Different from the Original

### Removed Features:

1. **Database ID and Schema Management**: No more `databaseId` parameter or entity-specific schema creation (`entity_data_{uuid}`)
2. **Multi-tenant Architecture**: Simplified to work only with the public schema
3. **Schema Creation Logic**: No automatic schema creation for users

### Kept Features:

1. **SQL Execution**: Full SQL execution capabilities within the public schema
2. **Scheduling**: Cron job scheduling functionality
3. **Telegram Integration**: Complete Telegram bot integration
4. **User Management**: Supabase Auth user creation and management using `signInAnonymously`
5. **Message History**: Chat history storage and retrieval
6. **Vector/Embedding Functionality**: Message embeddings and semantic search capabilities
7. **Zapier MCP Integration**: If configured, Zapier tools remain available

### Improvements Over Original:

1. **Anonymous User Creation**: Uses `signInAnonymously` instead of fake email addresses for cleaner user management
2. **Simplified User Lookup**: No complex database queries for user/schema creation
3. **Cleaner Architecture**: Focused on public schema operations only
4. **Retained Semantic Search**: Vector similarity search still available within public schema

## Files Included

### `simplified-ai-db-handler/index.ts`

- **Purpose**: Main AI processing handler that executes SQL and manages scheduling
- **Key Changes**:
  - Accepts `userId` instead of `databaseId`
  - Always operates in public schema
  - No embedding generation (focuses on SQL and scheduling)
  - Simplified system prompts without schema-specific language

### `simplified-telegram-incoming-handler/index.ts`

- **Purpose**: Handles incoming Telegram messages and webhooks
- **Key Changes**:
  - No schema creation for users
  - **Embeddings retained**: Generates embeddings for incoming messages
  - **Semantic search**: Loads relevant messages using vector similarity
  - Uses `signInAnonymously` for user creation (no fake emails)
  - Simplified user lookup using Supabase Auth admin API
  - Passes `userId` to AI handler instead of `databaseId`

### `simplified-telegram-outgoing-handler/index.ts`

- **Purpose**: Sends responses back to Telegram and saves assistant messages
- **Key Changes**:
  - **Embeddings retained**: Generates embeddings for assistant responses
  - Accepts `userId` instead of `databaseId`
  - Saves messages to public.messages table

## Environment Variables

These functions require the same environment variables as the original:

```bash
# Required for all functions
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
OPENAI_API_KEY=your_openai_key

# Required for AI DB Handler
SUPABASE_DB_URL=your_postgres_connection_string
AI_DB_HANDLER_URL=your_ai_handler_url
OPENAI_MODEL=gpt-4.1-mini  # Optional, defaults to gpt-4.1-mini

# Required for Telegram handlers (with embeddings)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_OUTGOING_HANDLER_URL=your_outgoing_handler_url
OPENAI_API_KEY=your_openai_key  # Required for embeddings

# Optional
TELEGRAM_WEBHOOK_SECRET=your_webhook_secret
ZAPIER_MCP_URL=your_zapier_mcp_url
```

## Database Schema Requirements

Since these functions work with the public schema and include embedding functionality, you'll need these tables:

```sql
-- Users are managed through Supabase Auth using signInAnonymously
-- No additional user table needed, Telegram metadata stored in auth.users.user_metadata

-- Messages table for chat history with embeddings
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system_routine_task')),
  content TEXT NOT NULL,
  embedding vector(1536), -- For OpenAI text-embedding-3-small embeddings
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Add indexes for performance
CREATE INDEX messages_user_id_created_at_idx ON public.messages(user_id, created_at DESC);

-- Add vector index for semantic search (requires pgvector extension)
CREATE INDEX messages_embedding_idx ON public.messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Required: Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Required: Add RPC function for admin SQL execution (used for vector search)
CREATE OR REPLACE FUNCTION execute_sql_as_admin(query_string text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    result jsonb;
BEGIN
    EXECUTE 'SELECT array_to_json(array_agg(row_to_json(t))) FROM (' || query_string || ') t' INTO result;
    RETURN result;
END;
$$;
```

## Key API Changes

### AI DB Handler

**Before:**

```json
{
  "userPrompt": "Hello",
  "databaseId": "uuid-here",
  "metadata": {...},
  "chatHistory": [...],
  "incomingMessageRole": "user",
  "callbackUrl": "..."
}
```

**After:**

```json
{
  "userPrompt": "Hello",
  "userId": "uuid-here",
  "metadata": {...},
  "chatHistory": [...],
  "incomingMessageRole": "user",
  "callbackUrl": "..."
}
```

### Outgoing Handler

**Before:**

```json
{
  "finalResponse": "Hello!",
  "databaseId": "uuid-here",
  "metadata": {...}
}
```

**After:**

```json
{
  "finalResponse": "Hello!",
  "userId": "uuid-here",
  "metadata": {...}
}
```

## User Creation Process

The simplified handlers use a cleaner approach for user management:

1. **Check for Existing User**: Search `auth.users` for a user with matching `telegram_id` in `user_metadata`
2. **Create Anonymous User**: If not found, use `signInAnonymously` with Telegram data:
   ```javascript
   await supabaseAdmin.auth.signInAnonymously({
     options: {
       data: {
         telegram_id: telegramUserId.toString(),
         telegram_username: username,
         telegram_first_name: firstName,
         telegram_last_name: lastName,
         platform: "telegram",
       },
     },
   });
   ```
3. **Store Metadata**: All Telegram information is stored in `user_metadata`, no fake emails required

## Embedding and Semantic Search

The simplified functions retain full embedding capabilities:

1. **Message Embeddings**: Both user and assistant messages are embedded using OpenAI's `text-embedding-3-small`
2. **Semantic Search**: Incoming messages trigger vector similarity search to find relevant conversation history
3. **Public Schema**: All embeddings stored in `public.messages.embedding` column
4. **Performance**: Vector index ensures fast similarity searches

## Deployment

These are Deno-based Supabase Edge Functions. Deploy them to your Supabase project:

```bash
# Deploy AI DB Handler
supabase functions deploy simplified-ai-db-handler

# Deploy Telegram Incoming Handler
supabase functions deploy simplified-telegram-incoming-handler

# Deploy Telegram Outgoing Handler
supabase functions deploy simplified-telegram-outgoing-handler
```

## Use Cases

These simplified functions are ideal for:

- Single-tenant applications
- Projects that need vector search but not multi-tenancy
- Simpler database architectures with semantic capabilities
- Prototyping and development with AI features
- Applications where all users share the same database schema
- Clean user management without email requirements
- Conversational AI with context and memory

## Migration from Original

If migrating from the original functions:

1. Update all API calls to use `userId` instead of `databaseId`
2. Migrate data from entity-specific schemas to public schema
3. Migrate embeddings from entity schemas to `public.messages.embedding`
4. Update environment variable configurations
5. Users created with fake emails can be migrated to anonymous users
6. Test thoroughly as the simplified functions have different behavior
7. Ensure pgvector extension is enabled in your database

## Notes

- **No Multi-tenancy**: All users share the public schema
- **Vector Search Available**: Semantic search capabilities retained
- **Simplified Architecture**: Easier to understand and maintain
- **Performance**: May be faster due to reduced complexity, vector search still optimized
- **Security**: Still uses Supabase RLS for data isolation
- **Clean User Management**: No fake emails, uses anonymous auth with metadata
- **AI Context**: Retains conversation memory and semantic understanding
