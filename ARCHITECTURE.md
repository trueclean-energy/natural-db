# AI Personal Assistant Architecture

## Core Concepts

### 1. **Scoped Database Control**
- **Memories Schema**: LLM operates exclusively within a dedicated `memories` schema
- **Role-Based Security**: Uses `memories_role` with limited permissions to prevent system access
- **Isolated Operations**: LLM can create tables, store data, and query only within its sandbox

### 2. **Multi-Layer Memory System**
- **Short-term**: Recent message history (last 10 messages)
- **Semantic**: Vector embeddings using pgvector for fuzzy concept retrieval
- **Structured**: LLM-created tables for precise data queries

### 3. **Autonomous Scheduling**
- **pg_cron Integration**: Scheduled tasks via PostgreSQL cron jobs
- **Self-Executing**: Prompts can schedule themselves for future execution
- **Full Tool Access**: Scheduled tasks have access to all tools (SQL, web search, MCP)

### 4. **Modular Edge Functions**
- **natural-db**: Main AI brain with all processing capabilities
- **telegram-input**: Webhook handler for incoming messages
- **telegram-outgoing**: Response formatter and delivery

## Data Flow

### Message Processing Flow
```
1. Telegram Message → telegram-input webhook
2. User validation & timezone detection
3. Profile/chat creation if needed
4. Forward to natural-db function
5. Load context (recent + relevant messages)
6. Execute AI processing with tools
7. Save response to database
8. Send formatted response via telegram-outgoing
```

### Memory Retrieval Process
```
1. Generate embedding for current prompt
2. Search similar messages using vector similarity
3. Load recent messages for immediate context
4. Combine both for comprehensive context
5. Include schema details for database awareness
```

### Scheduled Task Execution
```
1. pg_cron triggers at scheduled time
2. HTTP POST to natural-db function
3. Same processing as user messages
4. Can use all tools (SQL, web search, MCP)
5. Results stored in memories schema
```

## Database Schema

### Public Schema (System Tables)
- **profiles**: User metadata and timezone info
- **chats**: Conversation containers
- **chat_users**: Membership relationships
- **messages**: All conversation history with embeddings
- **system_prompts**: Personalized behavior with version history

### Memories Schema (LLM-Controlled)
- **Dynamic Tables**: Created by LLM as needed
- **Isolated Access**: Only accessible via `memories_role`
- **Structured Data**: Facts, preferences, and user-specific information

## Security Model

### Access Control
- **User Validation**: Username-based allowlist
- **Chat Membership**: Users can only access their chats
- **Role Separation**: LLM restricted to memories schema
- **Webhook Authentication**: Secret token validation

### Resource Limits
- **Query Timeout**: 3-second limit for LLM operations
- **Connection Pooling**: Efficient database connection management
- **Transaction Safety**: Automatic rollback on errors

## Tools Available to LLM

### Core Tools
- **execute_sql**: Create and query tables in memories schema
- **get_distinct_column_values**: Explore data distributions
- **schedule_prompt**: Set up recurring or one-time tasks
- **unschedule_prompt**: Cancel scheduled tasks
- **update_system_prompt**: Modify personalized behavior

### External Integrations
- **Web Search**: Real-time information retrieval
- **Zapier MCP**: Email, calendar, notifications, task management
- **Vector Search**: Semantic similarity for memory retrieval

## Key Design Principles

### Long-term Maintainability
- **Minimal Dependencies**: Core functionality with optional extensions
- **Schema Evolution**: LLM can adapt database structure as needed
- **Version Control**: System prompts maintain history and rollback capability
- **Modular Architecture**: Clear separation of concerns between functions

### Scalability Considerations
- **Connection Pooling**: Efficient database resource management
- **Vector Indexing**: HNSW index for fast similarity search
- **Caching Strategy**: Embeddings generated once and reused
- **Error Handling**: Graceful degradation with detailed logging

## Cost Optimization

### Resource Usage
- **Free Tier Compatible**: Designed for Supabase free tier
- **Token Efficiency**: Context window management (10 recent + 5 relevant)
- **Embedding Reuse**: Store once, search many times
- **Scheduled Tasks**: Batch processing for efficiency

### Estimated Monthly Cost (300 messages)
- **Supabase**: $0 (free tier)
- **OpenAI**: ~$0.53 (GPT-4.1-mini)
- **Total**: ~$0.54/month 