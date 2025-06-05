-- Add chat_id column to messages table
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS chat_id TEXT;

-- Add index for faster lookups by chat_id
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON public.messages(chat_id);

-- Add comment to explain the column
COMMENT ON COLUMN public.messages.chat_id IS 'The chat ID from the messaging platform (e.g., Telegram chat ID)'; 