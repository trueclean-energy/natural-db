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
    telegram_id BIGINT UNIQUE,
    telegram_username TEXT,
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
    USING ((select auth.uid()) = auth_user_id) WITH CHECK ((select auth.uid()) = auth_user_id);

-- Helper index
CREATE INDEX IF NOT EXISTS idx_profiles_auth_user_id ON public.profiles(auth_user_id);

-- ---------------------------------------------------------------------------
-- Chat metadata tables (must exist before messages/system_prompts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chats (
    id          TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.chat_users (
    chat_id   TEXT  NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    user_id   UUID  NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role      TEXT  NOT NULL CHECK (role IN ('owner','member')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chat_id, user_id)
);

COMMENT ON TABLE public.chats IS 'Conversation containers. Each chat has its own isolated database schema.';
COMMENT ON TABLE public.chat_users IS 'Associates profiles with chats and describes their role within the chat.';

-- Enable Row Level Security for chat tables
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_users ENABLE ROW LEVEL SECURITY;

-- Chats: members can read their chats
CREATE POLICY "chats_members_can_select" ON public.chats
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.chat_users cu
            WHERE cu.chat_id = id AND cu.user_id = (select auth.uid())
        )
    );

-- Chats: owners can insert (backend can also insert)
CREATE POLICY "chats_owner_insert" ON public.chats
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Chat users: members can read their rows
CREATE POLICY "chat_users_member_select" ON public.chat_users
    FOR SELECT USING (user_id = (select auth.uid()));

-- Chat users: owners manage membership
CREATE POLICY "chat_users_owner_manage" ON public.chat_users
    USING (
        EXISTS (
            SELECT 1 FROM public.chat_users cu
            WHERE cu.chat_id = chat_id AND cu.user_id = (select auth.uid()) AND cu.role = 'owner'
        )
    ) WITH CHECK (role IN ('owner','member'));

-- Service role bypass
CREATE POLICY "chats_service_role" ON public.chats
    FOR ALL USING (current_setting('role') = 'service_role');
CREATE POLICY "chat_users_service_role" ON public.chat_users
    FOR ALL USING (current_setting('role') = 'service_role');

-- Service role bypass for profiles table
CREATE POLICY "profiles_service_role" ON public.profiles
    FOR ALL USING (current_setting('role') = 'service_role');

-- Helpful index
CREATE INDEX IF NOT EXISTS idx_chat_users_user_id ON public.chat_users(user_id);

-- ---------------------------------------------------------------------------
-- Create messages table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'system_routine_task')),
    content TEXT NOT NULL,
    chat_id TEXT REFERENCES public.chats(id) ON DELETE CASCADE,
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
CREATE POLICY "Chat members can view messages" ON public.messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.auth_user_id = (select auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM public.chat_users cu
            JOIN public.profiles p2 ON p2.id = cu.user_id AND p2.auth_user_id = (select auth.uid())
            WHERE cu.chat_id = chat_id
        )
    );

CREATE POLICY "Chat members can insert messages" ON public.messages
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.chat_users cu
            JOIN public.profiles p3 ON p3.id = cu.user_id AND p3.auth_user_id = (select auth.uid())
            WHERE cu.chat_id = chat_id AND cu.user_id = user_id
        )
    );

CREATE POLICY "Users can update their own messages" ON public.messages
    FOR UPDATE USING (
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

-- Grant necessary permissions for cron jobs and http requests
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;
GRANT USAGE ON SCHEMA cron TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA cron TO service_role;

-- Grant permissions for pg_net (http requests)
GRANT USAGE ON SCHEMA net TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA net TO postgres;
GRANT USAGE ON SCHEMA net TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA net TO service_role;

-- Create system_prompts table for personalized behavior per chat
CREATE TABLE IF NOT EXISTS public.system_prompts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id TEXT NOT NULL,
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

-- Create RLS policies for system_prompts table
-- Note: Since system_prompts use chat_id instead of user_id, we rely on application-level security
-- The service role (edge functions) will handle access control based on chat ownership

-- Service role can access all system prompts (for functions to manage chat-specific prompts)
CREATE POLICY "Service role can access all system prompts" ON public.system_prompts
    FOR ALL USING (current_setting('role') = 'service_role');

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_system_prompts_updated_at
    BEFORE UPDATE ON public.system_prompts
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Ensure service_role has necessary permissions on public schema
GRANT ALL ON public.messages TO service_role;
GRANT ALL ON public.system_prompts TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Grant privileges for service_role on additional tables
GRANT ALL ON public.profiles TO service_role;
GRANT ALL ON public.chats TO service_role;
GRANT ALL ON public.chat_users TO service_role;

-- =============================================================
-- Global Schema Privilege Hardening
-- =============================================================

-- Revoke blanket privileges from PUBLIC
REVOKE ALL ON SCHEMA public     FROM PUBLIC;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
REVOKE ALL ON SCHEMA cron       FROM PUBLIC;

-- Grant minimal privileges back to service_role
GRANT USAGE, CREATE ON SCHEMA public TO service_role;
GRANT USAGE          ON SCHEMA extensions, cron TO service_role;