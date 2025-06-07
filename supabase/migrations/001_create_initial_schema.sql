-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_cron";
CREATE EXTENSION IF NOT EXISTS "pg_net";
CREATE EXTENSION IF NOT EXISTS "http";

-- Create messages table
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'system_routine_task')),
    content TEXT NOT NULL,
    chat_id TEXT,
    embedding vector(1536), -- OpenAI text-embedding-3-small uses 1536 dimensions
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add comments to the messages table
COMMENT ON TABLE public.messages IS 'Chat messages between users and AI assistant with embeddings for semantic search';
COMMENT ON COLUMN public.messages.id IS 'Unique identifier for the message';
COMMENT ON COLUMN public.messages.user_id IS 'Reference to the auth.users table';
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

-- Create IVFFlat index for vector similarity search with optimized lists parameter
-- Note: This index should be rebuilt when data distribution changes significantly
CREATE INDEX IF NOT EXISTS idx_messages_embedding ON public.messages 
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Enable Row Level Security
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for messages table
CREATE POLICY "Users can view their own messages" ON public.messages
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own messages" ON public.messages
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own messages" ON public.messages
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own messages" ON public.messages
    FOR DELETE USING (auth.uid() = user_id);

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