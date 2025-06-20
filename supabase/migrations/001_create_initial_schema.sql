-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
DROP EXTENSION IF EXISTS pg_cron CASCADE;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS "pg_net";
CREATE EXTENSION IF NOT EXISTS "http";

-- ---------------------------------------------------------------------------
-- Profiles table (user metadata separate from auth.users)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID UNIQUE,
    service_id BIGINT UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    timezone TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.profiles IS 'Extended user profile keyed internally; auth_user_id points to latest auth.users.id';

-- Enable RLS for profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Owners manage their profile via auth_user_id mapping
CREATE POLICY "profile_owner" ON public.profiles
    FOR ALL
    USING ((select auth.uid()) = auth_user_id)
    WITH CHECK ((select auth.uid()) = auth_user_id);

-- Service role bypass for profiles table
CREATE POLICY "profiles_service_role" ON public.profiles
    FOR ALL USING (current_setting('role') = 'service_role');

-- Helper index
CREATE INDEX IF NOT EXISTS idx_profiles_auth_user_id ON public.profiles(auth_user_id);

-- ---------------------------------------------------------------------------
-- Create chats and chat_users tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chats (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.chats IS 'Chat conversations (e.g., Telegram chats or app conversations)';

-- Enable RLS for chats
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;

-- RLS policies for chats will be defined after chat_users table is created.

-- chat_users membership table (must exist before policies that reference it)
CREATE TABLE IF NOT EXISTS public.chat_users (
    chat_id TEXT NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chat_id, user_id)
);

COMMENT ON TABLE public.chat_users IS 'Membership linking profiles to chats with optional role';

-- Helper indexes for chat_users
CREATE INDEX IF NOT EXISTS idx_chat_users_user_id ON public.chat_users(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_users_chat_id ON public.chat_users(chat_id);

-- Enable RLS for chat_users
ALTER TABLE public.chat_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat_users_member_access" ON public.chat_users
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.auth_user_id = (select auth.uid())
        )
    ) WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.auth_user_id = (select auth.uid())
        )
    );

-- Service role bypass for chat_users table
CREATE POLICY "chat_users_service_role" ON public.chat_users
    FOR ALL USING (current_setting('role') = 'service_role');

-- ---------------------------------------------------------------------------
-- RLS policy on chats referencing chat_users (defined after chat_users exists)
-- ---------------------------------------------------------------------------

CREATE POLICY "chat_member_access" ON public.chats
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.chat_users cu
            JOIN public.profiles p ON p.id = cu.user_id
            WHERE cu.chat_id = public.chats.id AND p.auth_user_id = (select auth.uid())
        )
    );

-- Service role bypass for chats table
CREATE POLICY "chats_service_role" ON public.chats
    FOR ALL USING (current_setting('role') = 'service_role');

-- Allow any authenticated user to create a chat row when the created_by profile belongs to them
CREATE POLICY "chat_creator_insert" ON public.chats
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = created_by AND p.auth_user_id = (select auth.uid())
        )
    );

-- Allow chat members to update chat metadata
CREATE POLICY "chat_member_update" ON public.chats
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.chat_users cu
            JOIN public.profiles p ON p.id = cu.user_id
            WHERE cu.chat_id = public.chats.id AND p.auth_user_id = (select auth.uid())
        )
    ) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Create messages table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'system_routine_task')),
    content TEXT NOT NULL,
    chat_id TEXT NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    embedding vector(1536), -- OpenAI text-embedding-3-small uses 1536 dimensions
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add comments to the messages table
COMMENT ON TABLE public.messages IS 'Chat messages between users and AI assistant with embeddings for semantic search';
COMMENT ON COLUMN public.messages.id IS 'Unique identifier for the message';
COMMENT ON COLUMN public.messages.user_id IS 'Reference to the profiles table';
COMMENT ON COLUMN public.messages.role IS 'Role of the message sender (user, assistant, system, system_routine_task)';
COMMENT ON COLUMN public.messages.content IS 'The actual message content';
COMMENT ON COLUMN public.messages.chat_id IS 'Chat/conversation identifier for grouping messages';
COMMENT ON COLUMN public.messages.embedding IS 'Vector embedding for semantic search using text-embedding-3-small (1536 dimensions)';
COMMENT ON COLUMN public.messages.created_at IS 'Timestamp when the message was created';
COMMENT ON COLUMN public.messages.updated_at IS 'Timestamp when the message was last updated';

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON public.messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON public.messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON public.messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_role ON public.messages(role);

-- Create HNSW index for vector similarity search (recommended default)
-- Note: This index should be rebuilt when data distribution changes significantly
CREATE INDEX IF NOT EXISTS idx_messages_embedding ON public.messages 
USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Enable Row Level Security
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for messages table
CREATE POLICY "Users can view their own messages" ON public.messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.auth_user_id = (select auth.uid())
        )
    );

CREATE POLICY "Users can insert their own messages" ON public.messages
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles p3 WHERE p3.id = user_id AND p3.auth_user_id = (select auth.uid())
        )
    );

CREATE POLICY "Users can update their own messages" ON public.messages
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.profiles p4 WHERE p4.id = user_id AND p4.auth_user_id = (select auth.uid())
        )
    ) WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles p4 WHERE p4.id = user_id AND p4.auth_user_id = (select auth.uid())
        )
    );

CREATE POLICY "Users can delete their own messages" ON public.messages
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.profiles p5 WHERE p5.id = user_id AND p5.auth_user_id = (select auth.uid())
        )
    );

-- Service role can access all messages (for functions)
CREATE POLICY "Service role can access all messages" ON public.messages
    FOR ALL USING (current_setting('role') = 'service_role');

-- Create function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_messages_updated_at
    BEFORE UPDATE ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Cron / pg_net privileges will rely on Supabase's default role configuration; no explicit grants needed.

-- Create system_prompts table for personalized behavior per chat
CREATE TABLE IF NOT EXISTS public.system_prompts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id TEXT NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    prompt_content TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_by_role TEXT NOT NULL CHECK (created_by_role IN ('user', 'assistant', 'system')),
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add comments to the system_prompts table
COMMENT ON TABLE public.system_prompts IS 'Stores personalized behavior prompts with version history per chat conversation';
COMMENT ON COLUMN public.system_prompts.id IS 'Unique identifier for the system prompt';
COMMENT ON COLUMN public.system_prompts.chat_id IS 'Chat/conversation identifier this prompt applies to';
COMMENT ON COLUMN public.system_prompts.prompt_content IS 'Personalized behavior instructions (communication style, preferences)';
COMMENT ON COLUMN public.system_prompts.version IS 'Version number for tracking personalization evolution';
COMMENT ON COLUMN public.system_prompts.created_by_role IS 'Role that created this prompt (user, assistant, system)';
COMMENT ON COLUMN public.system_prompts.description IS 'Description of what this personalization accomplishes';
COMMENT ON COLUMN public.system_prompts.is_active IS 'Whether this prompt version is currently active for this chat';
COMMENT ON COLUMN public.system_prompts.created_at IS 'Timestamp when the prompt was created';
COMMENT ON COLUMN public.system_prompts.updated_at IS 'Timestamp when the prompt was last updated';

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_system_prompts_chat_id ON public.system_prompts(chat_id);
CREATE INDEX IF NOT EXISTS idx_system_prompts_is_active ON public.system_prompts(is_active);
CREATE INDEX IF NOT EXISTS idx_system_prompts_version ON public.system_prompts(version);
CREATE INDEX IF NOT EXISTS idx_system_prompts_created_at ON public.system_prompts(created_at);

-- Ensure only one active prompt per chat
CREATE UNIQUE INDEX IF NOT EXISTS idx_system_prompts_chat_active 
ON public.system_prompts(chat_id) WHERE is_active = true;

-- Enable Row Level Security
ALTER TABLE public.system_prompts ENABLE ROW LEVEL SECURITY;

-- Service role can access all system prompts (for functions to manage chat-specific prompts)
CREATE POLICY "Service role can access all system prompts" ON public.system_prompts
    FOR ALL USING (current_setting('role') = 'service_role');

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_system_prompts_updated_at
    BEFORE UPDATE ON public.system_prompts
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================
-- LLM Memories Schema and Role
-- =============================================================
CREATE SCHEMA IF NOT EXISTS "memories";
REVOKE ALL ON SCHEMA "memories" FROM PUBLIC;
-- Only memories_role has privileges on memories schema; service_role will assume that role when needed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memories_role') THEN
    CREATE ROLE "memories_role" LOGIN NOINHERIT;
  END IF;
END$$;

GRANT USAGE, CREATE ON SCHEMA "memories" TO "memories_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA "memories" GRANT ALL PRIVILEGES ON TABLES TO "memories_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA "memories" GRANT ALL PRIVILEGES ON SEQUENCES TO "memories_role";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "memories" TO "memories_role";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "memories" TO "memories_role";

-- Allow service_role to assume memories_role
GRANT "memories_role" TO service_role;

-- Resource limits for memories_role to prevent runaway queries
ALTER ROLE "memories_role" SET statement_timeout = '5000ms';
ALTER ROLE "memories_role" SET idle_in_transaction_session_timeout = '3000ms';

-- =============================================================
-- Service role can access all tables and cron
-- =============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

GRANT USAGE ON SCHEMA cron TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cron TO service_role;