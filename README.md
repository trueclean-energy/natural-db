# Building an AI Personal Assistant with Supabase: Persistent Memory & Autonomous Intelligence

Large Language Models excel at understanding natural language but struggle with maintaining accurate, structured data across conversations. This system enhances LLMs by combining their natural language processing capabilities with PostgreSQL storage, creating an AI that maintains precise, queryable records over time.

The assistant converts conversations into structured database entries, enabling reliable data retrieval and analysis. By integrating database operations, scheduled prompts, web searches, and MCP integrations, it creates a flexible system that can automate complex workflows. Unlike traditional AI assistants that rely solely on conversation history, this system maintains organized, structured data that can be precisely queried and analyzed for accurate insights.

**The Flexibility**: The modular architecture lets you start simple (expense tracking) and gradually add complexity (investment monitoring, health tracking, project management) as your needs evolve. Each component works independently but combines powerfully—scheduled analysis can trigger web searches that update your database and send notifications through Zapier integrations.

## Core Pieces

### Scoped Database Control

Each chat operates in a completely isolated PostgreSQL schema (`chat_{chat_id}`), providing bulletproof security:

- **Private Schemas**: LLM can create tables, store data, and perform operations without accessing other users' information
- **System Table Protection**: Critical system tables remain in the `public` schema, completely inaccessible to the LLM
- **Automatic Schema Creation**: New chats get properly configured private schemas with restricted permissions
- **Complete Data Separation**: Chat A's tables are invisible to Chat B, preventing any cross-contamination

```sql
-- Auto-generated from natural language in your private schema
CREATE TABLE expenses (
  id UUID PRIMARY KEY,
  amount DECIMAL,
  category TEXT,
  date TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO expenses (amount, category, store, date, note)
VALUES (47.00, 'groceries', 'Whole Foods', '2024-01-15', 'Monthly budget target: $400');
```

### Messages Context

Two complementary memory types maintain conversation continuity:

- **Semantic Memory (Vector Search)**: Stores conversation embeddings using pgvector for fuzzy concept retrieval ("that productivity thing we talked about last month")
- **Structured Memory (SQL Data)**: Stores concrete facts in LLM-created tables for precise queries ("How much did I spend on coffee last quarter?")

### Scheduled Prompts Creating Intelligence Loops

The system's power emerges through autonomous scheduled operations that combine all other pieces:

**Example**: "Every Sunday at 6 PM, analyze my portfolio performance and research market trends"

1. **Cron trigger** executes with stored prompt
2. **Database lookup** retrieves your current portfolio holdings and historical performance
3. **Web search** finds relevant market news and competitor analysis
4. **Database storage** accumulates weekly performance data and market insights
5. **MCP integration** sends personalized report via Zapier with portfolio highlights and recommendations
6. **Memory building** enables future queries like "How has my portfolio performed compared to market trends?"

This creates self-reinforcing intelligence loops where scheduled analysis builds knowledge that improves future responses.

### Web Search

Real-time information gathering with intelligent storage:

```sql
-- Auto-generated from web search results
CREATE TABLE research_findings (
  topic TEXT,
  source_url TEXT,
  key_insights TEXT[],
  credibility_score INTEGER,
  search_date TIMESTAMPTZ DEFAULT NOW()
);
```

When you ask about current information, findings are structured and stored for future reference. Months later, "What were those Spanish apps I researched?" provides exact details with sources.

### Zapier MCP Integration

Through Zapier's MCP integration, your assistant can:

- Read/send emails (Gmail, Outlook)
- Manage calendar events
- Update spreadsheets
- Send notifications (Slack, Discord, SMS)
- Create tasks (Trello, Asana, Notion)
- Control smart home devices

These aren't one-off actions—they're integrated into the data collection and analysis workflow.

### Input/Output Integration

The system uses Telegram as the default interface, implemented as an edge function with webhook support for real-time messaging. All input/output is processed through the `natural-db` function for consistent behavior.

### Self-Evolving System Prompt

The assistant maintains two behavioral layers:

- **Base Behavior**: Core functionality (database operations, scheduling, web search) remains constant
- **Personalized Behavior**: Communication style and preferences that evolve based on user feedback

When you say "be more formal" or "address me by name," these preferences are stored with version history and persist across all conversations, creating a truly personalized AI companion.

## Code Ownership & Extensibility

As the codebase owner, you have complete control over your assistant's capabilities, allowing you to modify base behavior by customizing system prompts to adjust personality and expertise or create custom edge functions for specific needs.

## Use Cases

### Automated Investment Research

**Setup**: "Every Sunday, research top 3 performing tech stocks and email me"

1. **Cron trigger** executes weekly with stored prompt
2. **Web search** finds current top performing tech stocks and market analysis
3. **Database storage** creates/updates `stock_performance` table with new data
4. **Database lookup** retrieves historical performance for trend analysis
5. **MCP integration** sends formatted email report via Zapier with:
   - Current top performers
   - Week-over-week changes
   - Market context and insights
6. **Memory building** enables future queries about stock performance history

### Smart Expense Tracking

**Setup**: Forward receipts via email, set monthly budgets

1. **MCP integration** receives forwarded receipt emails
2. **Web search** identifies store/merchant details if needed
3. **Database storage** creates/updates `expenses` table with:
   - Amount, date, category
   - Store/merchant details
   - Receipt image reference
4. **Database lookup** compares against budget thresholds
5. **Telegram notifications** sent when:
   - Category exceeds 80% of budget
   - Unusual spending patterns detected
   - Monthly summary ready

### Learning Progress Tracker

**Setup**: "Track my coding practice and remind me when I'm slacking"

1. **Database storage** creates `coding_sessions` table to track:
   - Session duration
   - Topics covered
   - Difficulty level
   - Completion status
2. **Database lookup** analyzes:
   - Frequency of practice
   - Topic coverage gaps
   - Progress patterns
3. **Cron trigger** runs weekly analysis
4. **MCP integration** sends:
   - Progress reports
   - Topic recommendations
   - Practice reminders when activity drops

### Health & Fitness Monitoring

**Setup**: Create daily workout plans and track progress with daily check-ins

1. **Database storage** creates:
   - `workout_plans` table for daily exercise routines
   - `workout_results` table tracking:
     - Exercise type
     - Duration/intensity
     - Personal records
     - How you felt
2. **Daily check-ins** via cron:
   - Morning: Review today's planned workout
   - Evening: Log workout results
   - Compare actual vs planned performance
3. **Database lookup** analyzes:
   - Progress trends
   - Recovery patterns
   - Goal alignment
4. **Monthly celebrations** via cron:
   - Review monthly achievements
   - Update personal records
   - Adjust workout plans based on progress

## Implementation Guide

### Prerequisites

- Supabase account (free tier sufficient)
- OpenAI API key
- Telegram bot token
- Zapier account (optional)

### **Step 1: Database Setup**

Run the migration SQL in your Supabase SQL editor: [migration.sql](link-to-migration-file)

- Sets up extensions (pgvector, pg_cron)
- Creates system tables with proper permissions
- Configures cron job scheduling

### **Step 2: Edge Functions**

Create three functions in Supabase dashboard:

**natural-db**: Main AI brain handling all processing, database operations, scheduling, and tool integration

- [natural-db/index.ts](link-to-natural-db-function)

**telegram-input**: Webhook handler for incoming messages with user validation and timezone management

- [telegram-input/index.ts](link-to-telegram-input-function)

**telegram-outgoing**: Response formatter and delivery handler with error management

- [telegram-outgoing/index.ts](link-to-telegram-outgoing-function)

### **Step 3: Telegram Bot**

1. Create bot via [@BotFather](https://t.me/botfather)
2. Set webhook: `https://api.telegram.org/bot[TOKEN]/setWebhook?url=https://[PROJECT].supabase.co/functions/v1/telegram-input`

### **Step 4: Test Integration**

Try these commands with your bot:

- "Store my grocery budget as $400 monthly"
- "What's the weather today?" (web search)
- "Remind me to exercise every Monday at 7 AM"
- "Be more enthusiastic when I discuss hobbies" (personality)

## Input and Output Methods

The natural-db edge function is decoupled from how messages are received or sent out. This means you can interact with your AI companion through any channel you prefer:

- WhatsApp messages
- Email
- Slack
- Web interface
- Any other messaging platform

## Cost Considerations

Based on 10 messages per day (300 messages/month):

- **Supabase**: Free tier (500MB database, 2GB bandwidth) - $0/month
- **OpenAI GPT-4.1-mini**: $0.40 per 1M input tokens, $1.60 per 1M output tokens
  - Average 400 input + 600 output tokens per message
  - Input: 300 messages × 400 tokens × $0.40/1M = $0.048/month
  - Output: 300 messages × 600 tokens × $1.60/1M = $0.288/month
  - Total OpenAI: $0.336/month
- **Telegram**: Free API usage
- **Zapier**: Free tier (300 tasks/month) - $0/month
- **Vector Embeddings**: $0.02 per 1M tokens (text-embedding-3-small)
  - 300 messages × 400 tokens × $0.02/1M = $0.0024/month

**Total monthly cost: ~$0.34**

Note: Costs scale linearly with usage. At 100 messages/day (~3K messages/month), expect ~$3.40/month.

## Summary

This system leverages what LLMs do best—understanding natural language and transforming it into structured data—while solving their biggest weakness: memory persistence. By combining this with PostgreSQL's querying power, cron scheduling, and external tool integration, you get an AI that genuinely gets smarter over time.

**Key advantages**:

- **Persistent Memory**: Each interaction builds structured, queryable knowledge
- **Complete Privacy**: Isolated database schemas ensure bulletproof data security
- **Autonomous Intelligence**: Scheduled operations create self-improving analysis loops
- **Real-world Integration**: Actions across email, calendar, and hundreds of tools
- **Adaptive Personality**: Evolving communication style based on user preferences
- **Modular Growth**: Start simple, add complexity as needs evolve

This isn't just another chatbot—it's a persistent AI companion that accumulates knowledge and takes autonomous action, becoming more valuable the longer you use it.
