-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS "pg_net";

-- Profiles table (user metadata separate from auth.users)
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

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policy for profiles: user can access their own profile
CREATE POLICY "profiles_access" ON public.profiles
    FOR ALL
    USING ((select auth.uid()) = auth_user_id)
    WITH CHECK ((select auth.uid()) = auth_user_id);

CREATE INDEX IF NOT EXISTS idx_profiles_auth_user_id ON public.profiles(auth_user_id);

-- Chats and chat_users tables
CREATE TABLE IF NOT EXISTS public.chats (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.chats IS 'Chat conversations (e.g., Telegram chats or app conversations)';

ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;

-- chat_users membership table (must exist before policies that reference it)
CREATE TABLE IF NOT EXISTS public.chat_users (
    chat_id TEXT NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chat_id, user_id)
);

COMMENT ON TABLE public.chat_users IS 'Membership linking profiles to chats with optional role';

CREATE INDEX IF NOT EXISTS idx_chat_users_user_id ON public.chat_users(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_users_chat_id ON public.chat_users(chat_id);

ALTER TABLE public.chat_users ENABLE ROW LEVEL SECURITY;

-- Policy for chat_users: users can manage their own membership
CREATE POLICY "chat_users_access" ON public.chat_users
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.auth_user_id = (select auth.uid())
        )
    ) WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.auth_user_id = (select auth.uid())
        )
    );

-- Policy for chats: member access and creator access
CREATE POLICY "chats_access" ON public.chats
    FOR ALL USING (
        -- Chat members can view and update
        EXISTS (
            SELECT 1 FROM public.chat_users cu
            JOIN public.profiles p ON p.id = cu.user_id
            WHERE cu.chat_id = public.chats.id AND p.auth_user_id = (select auth.uid())
        )
    ) WITH CHECK (
        -- Users can create chats when they own the profile
        EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = created_by AND p.auth_user_id = (select auth.uid())
        )
    );

-- Messages table
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

COMMENT ON TABLE public.messages IS 'Chat messages between users and AI assistant with embeddings for semantic search';
COMMENT ON COLUMN public.messages.id IS 'Unique identifier for the message';
COMMENT ON COLUMN public.messages.user_id IS 'Reference to the profiles table';
COMMENT ON COLUMN public.messages.role IS 'Role of the message sender (user, assistant, system, system_routine_task)';
COMMENT ON COLUMN public.messages.content IS 'The actual message content';
COMMENT ON COLUMN public.messages.chat_id IS 'Chat/conversation identifier for grouping messages';
COMMENT ON COLUMN public.messages.embedding IS 'Vector embedding for semantic search using text-embedding-3-small (1536 dimensions)';
COMMENT ON COLUMN public.messages.created_at IS 'Timestamp when the message was created';
COMMENT ON COLUMN public.messages.updated_at IS 'Timestamp when the message was last updated';

CREATE INDEX IF NOT EXISTS idx_messages_user_id ON public.messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON public.messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON public.messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_role ON public.messages(role);

-- HNSW index for vector similarity search - should be rebuilt when data distribution changes significantly
CREATE INDEX IF NOT EXISTS idx_messages_embedding ON public.messages 
USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Policy for messages: users can access their own messages
CREATE POLICY "messages_access" ON public.messages
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.auth_user_id = (select auth.uid())
        )
    ) WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.auth_user_id = (select auth.uid())
        )
    );

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_messages_updated_at
    BEFORE UPDATE ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- System_prompts table for personalized behavior per chat
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

CREATE INDEX IF NOT EXISTS idx_system_prompts_chat_id ON public.system_prompts(chat_id);
CREATE INDEX IF NOT EXISTS idx_system_prompts_is_active ON public.system_prompts(is_active);
CREATE INDEX IF NOT EXISTS idx_system_prompts_version ON public.system_prompts(version);
CREATE INDEX IF NOT EXISTS idx_system_prompts_created_at ON public.system_prompts(created_at);

-- Ensure only one active prompt per chat
CREATE UNIQUE INDEX IF NOT EXISTS idx_system_prompts_chat_active 
ON public.system_prompts(chat_id) WHERE is_active = true;

ALTER TABLE public.system_prompts ENABLE ROW LEVEL SECURITY;

-- No RLS policy for system_prompts - service_role bypasses RLS by default

CREATE TRIGGER update_system_prompts_updated_at
    BEFORE UPDATE ON public.system_prompts
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- LLM Memories Schema and Role
CREATE SCHEMA IF NOT EXISTS "memories";
REVOKE ALL ON SCHEMA "memories" FROM PUBLIC;

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

GRANT USAGE ON SCHEMA cron TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cron TO service_role;