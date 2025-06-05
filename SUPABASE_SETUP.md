# Supabase Setup Guide

This guide will help you set up Supabase for the Natural DB chat application with realtime broadcast functionality.

## Prerequisites

1. A Supabase project
2. Supabase CLI installed (`npm install -g @supabase/cli`)

## Environment Variables

Create a `.env.local` file in your project root with the following variables:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

You can find these values in your Supabase project dashboard under Settings > API.

## Database Setup

### 1. Run the Migration

Apply the realtime broadcast migration to set up the necessary triggers and functions:

```bash
# If using Supabase CLI
supabase db push

# Or apply the migration manually in your Supabase SQL Editor
```

The migration file `supabase/migrations/001_setup_realtime_broadcast.sql` includes:

- RLS policies for authenticated users
- Trigger function for broadcasting message changes
- Database triggers for real-time updates
- Necessary permissions

### 2. Enable Anonymous Authentication

In your Supabase project dashboard:

1. Go to Authentication > Settings
2. Enable "Anonymous sign-ins"
3. Save the configuration

### 3. Enable Realtime

1. Go to Database > Replication
2. Make sure the `messages` table is enabled for realtime
3. The migration should have already added it to the `supabase_realtime` publication

## Edge Function Deployment

Deploy the existing Edge Function:

```bash
# Deploy the function
supabase functions deploy supabase-js-input-handler

# Set environment variables for the function
supabase secrets set SUPABASE_URL=your_supabase_url
supabase secrets set SUPABASE_ANON_KEY=your_anon_key
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
supabase secrets set AI_DB_HANDLER_URL=your_ai_handler_url
supabase secrets set OUTGOING_HANDLER_URL=your_outgoing_handler_url
supabase secrets set SUPABASE_DB_URL=your_database_connection_string
supabase secrets set OPENAI_API_KEY=your_openai_api_key
```

## Testing the Setup

1. Start your Next.js application:

   ```bash
   npm run dev
   ```

2. Open the application in your browser
3. The app should automatically sign in anonymously
4. Send a message to test the integration
5. Check the browser console and Supabase logs for any errors

## How It Works

1. **Anonymous Authentication**: Users are automatically signed in anonymously when they visit the app
2. **Message Sending**: Messages are sent via the Edge Function using `supabase.functions.invoke()`
3. **Realtime Updates**: New messages trigger database broadcasts that are received by subscribed clients
4. **Message Storage**: All messages are stored in the `messages` table with embeddings for semantic search

## Troubleshooting

### Common Issues

1. **Authentication Errors**: Ensure anonymous sign-ins are enabled in your Supabase project
2. **Function Invocation Errors**: Check that the Edge Function is deployed and environment variables are set
3. **Realtime Connection Issues**: Verify that the `messages` table is added to the realtime publication
4. **Migration Errors**: Make sure you have the necessary permissions to create triggers and functions
5. **CORS Errors**: The Edge Function now includes proper CORS headers for local development. If you still get CORS errors:
   - Ensure you've deployed the latest version of the function with: `supabase functions deploy supabase-js-input-handler`
   - Check that the function is running the latest version in the Supabase dashboard

### Debug Tips

- Check the browser console for client-side errors
- Monitor Supabase logs in the dashboard
- Use the Supabase SQL Editor to test queries manually
- Verify RLS policies are correctly configured
- For CORS issues, check the Network tab in developer tools to see the actual headers being sent/received

## Next Steps

Once the basic setup is working, you can:

- Customize the message handling logic in the Edge Function
- Add more sophisticated AI processing
- Implement user-specific memory schemas
- Add more complex realtime features

For more information, refer to the [Supabase Realtime documentation](https://supabase.com/docs/guides/realtime).
