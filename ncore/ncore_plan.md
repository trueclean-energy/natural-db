# Simplified Document AI Agent Plan - Leveraging Existing Infrastructure

## Infrastructure Assessment ✅

**What You Already Have:**
- ✅ Document chunking and embedding pipeline
- ✅ Vector similarity search with pgvector
- ✅ Document storage with metadata
- ✅ Automatic deduplication via checksums
- ✅ Multi-format support (md, ts, json)

**What We Need to Add:**
- Document analysis functions
- Real-time suggestions system
- Q&A functionality
- Diagram generation
- Cursor tracking for editing

---

## Simplified Database Schema

### **Use Your Existing Tables** + **Add These:**

```sql
-- Document analysis results (leverage existing document_chunks for context)
CREATE TABLE document_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id INT REFERENCES documents_reference(document_id) ON DELETE CASCADE,
  analysis_type TEXT NOT NULL, -- 'completeness', 'missing_sections', 'structure'
  analysis_result JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Real-time suggestions for editing
CREATE TABLE suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id INT REFERENCES documents_reference(document_id) ON DELETE CASCADE,
  suggestion_text TEXT NOT NULL,
  suggestion_type TEXT NOT NULL, -- 'addition', 'modification', 'structure'
  target_line INTEGER,
  target_column INTEGER,
  context_chunk_ids INTEGER[], -- Reference to relevant document_chunks
  status TEXT DEFAULT 'pending', -- 'pending', 'accepted', 'rejected'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Generated diagrams
CREATE TABLE diagrams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id INT REFERENCES documents_reference(document_id) ON DELETE CASCADE,
  mermaid_code TEXT NOT NULL,
  description TEXT,
  concept TEXT,
  source_chunk_ids INTEGER[], -- Which chunks inspired this diagram
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Q&A cache (leverage vector search for context)
CREATE TABLE qa_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id INT REFERENCES documents_reference(document_id) ON DELETE CASCADE,
  question_hash TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  context_chunk_ids INTEGER[], -- Which chunks were used for context
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Simple cursor tracking for 1-2 users
CREATE TABLE cursor_positions (
  document_id INT REFERENCES documents_reference(document_id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  position JSONB NOT NULL, -- {line, column}
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (document_id, user_id)
);
```

---

## Simplified Implementation Plan

### **Milestone 1: Document Analysis (Week 1)**
**Goal**: Analyze documents using existing embeddings for context

**New Edge Function**: `/functions/analyze-document/index.ts`
```typescript
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

export default async function handler(req: Request) {
  const { document_id } = await req.json();
  
  // Get document content from existing table
  const { data: doc } = await supabase
    .from('documents_reference')
    .select('*')
    .eq('document_id', document_id)
    .single();
  
  if (!doc) {
    return new Response(JSON.stringify({ error: 'Document not found' }), { status: 404 });
  }
  
  // Get relevant chunks using your existing embeddings
  const { data: chunks } = await supabase
    .from('document_chunks')
    .select('content, chunk_index')
    .eq('document_id', document_id)
    .order('chunk_index');
  
  const fullContent = doc.markdown_content || doc.typescript_content || 
                     JSON.stringify(doc.json_file, null, 2);
  
  // Analyze using OpenAI (same as before)
  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{
      role: "system",
      content: `Analyze this document and return JSON with missing sections and improvements.`
    }, {
      role: "user",
      content: fullContent
    }],
    response_format: { type: "json_object" }
  });
  
  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Store analysis
  await supabase.from('document_analysis').insert({
    document_id,
    analysis_type: 'completeness',
    analysis_result: analysis
  });
  
  return new Response(JSON.stringify(analysis));
}
```

### **Milestone 2: Smart Suggestions (Week 1.5)**
**Goal**: Context-aware suggestions using vector similarity

**New Edge Function**: `/functions/generate-suggestions/index.ts`
```typescript
export default async function handler(req: Request) {
  const { document_id, cursor_position, content } = await req.json();
  
  // Get context using your existing vector search
  const currentLine = content.split('\n')[cursor_position.line] || '';
  
  // Find similar chunks in the document using vector similarity
  const { data: similarChunks } = await supabase.rpc('match_document_chunks', {
    document_id,
    query_text: currentLine,
    match_threshold: 0.7,
    match_count: 3
  });
  
  // Generate suggestions with context from similar chunks
  const contextText = similarChunks?.map(chunk => chunk.content).join('\n') || '';
  
  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    stream: true, // Stream for <2s response
    messages: [{
      role: "system",
      content: `Generate contextual suggestions using similar document sections as context.`
    }, {
      role: "user",
      content: `Current line: "${currentLine}"\nSimilar sections: ${contextText}`
    }]
  });
  
  // Return streaming response
  return new Response(completion, {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}
```

### **Milestone 3: Vector-Powered Q&A (Week 2)**
**Goal**: Answer questions using existing embeddings

**New Edge Function**: `/functions/document-qa/index.ts`
```typescript
export default async function handler(req: Request) {
  const { document_id, question } = await req.json();
  
  // Use your existing vector search to find relevant chunks
  const { data: relevantChunks } = await supabase.rpc('match_document_chunks', {
    document_id,
    query_text: question,
    match_threshold: 0.6,
    match_count: 5
  });
  
  if (!relevantChunks || relevantChunks.length === 0) {
    return new Response(JSON.stringify({ 
      answer: "I couldn't find relevant information to answer your question.",
      context_chunks: []
    }));
  }
  
  const context = relevantChunks.map(chunk => chunk.content).join('\n\n');
  
  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{
      role: "system",
      content: `Answer the question using only the provided document context.`
    }, {
      role: "user",
      content: `Context: ${context}\n\nQuestion: ${question}`
    }]
  });
  
  return new Response(JSON.stringify({ 
    answer: completion.choices[0].message.content,
    context_chunks: relevantChunks.map(c => c.id)
  }));
}
```

### **Milestone 4: Diagram Generation (Week 2.5)**
**Goal**: Create diagrams based on document chunks

**New Edge Function**: `/functions/create-diagram/index.ts`
```typescript
export default async function handler(req: Request) {
  const { document_id, concept } = await req.json();
  
  // Find relevant chunks about the concept
  const { data: conceptChunks } = await supabase.rpc('match_document_chunks', {
    document_id,
    query_text: concept,
    match_threshold: 0.7,
    match_count: 3
  });
  
  const conceptContext = conceptChunks?.map(c => c.content).join('\n') || '';
  
  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{
      role: "system",
      content: `Create a Mermaid diagram explaining the concept using the document context.`
    }, {
      role: "user",
      content: `Concept: ${concept}\nContext: ${conceptContext}`
    }],
    response_format: { type: "json_object" }
  });
  
  const diagram = JSON.parse(completion.choices[0].message.content);
  
  // Store with chunk references
  await supabase.from('diagrams').insert({
    document_id,
    mermaid_code: diagram.mermaid_code,
    description: diagram.description,
    concept,
    source_chunk_ids: conceptChunks?.map(c => c.id) || []
  });
  
  return new Response(JSON.stringify(diagram));
}
```

### **Milestone 5: Integration & Polish (Week 3)**
**Goal**: Connect all pieces with your existing infrastructure

**Tasks**:
- Integrate with your existing document upload flow
- Add real-time subscriptions for suggestions
- Frontend integration with Monaco Editor
- Testing with your existing document types

---

## Key Advantages of Your Existing Infrastructure

### **1. Vector Search is Already Optimized**
- Your embeddings provide perfect context for suggestions
- No need to re-embed content for each query
- Automatic deduplication prevents redundant processing

### **2. Multi-Format Support**
- Your pipeline already handles md, ts, and json
- Our AI functions work with any of these formats
- No additional parsing needed

### **3. Scalable Architecture**
- Your chunking strategy handles large documents
- Existing triggers ensure data consistency
- Built-in deduplication prevents waste

### **4. Cost Optimization**
- Embeddings are already generated once
- Vector search is much cheaper than re-calling OpenAI
- Caching at the chunk level maximizes efficiency

---

## Updated Timeline

| Week | Original Plan | Simplified Plan |
|------|---------------|-----------------|
| **1** | Database setup + analysis | Analysis function (using existing embeddings) |
| **1.5** | Real-time suggestions | Vector-powered suggestions |
| **2** | Q&A system | Q&A using existing chunks |
| **2.5** | Diagram generation | Diagram from relevant chunks |
| **3** | Performance optimization | Integration & testing |

---

## Cost Impact

**Dramatically Reduced Costs**:
- **Embeddings**: $0 (already generated)
- **Context retrieval**: Vector search vs. new API calls
- **Suggestions**: Only generation, not context building
- **Q&A**: Existing chunks provide context

**Estimated Monthly Cost**: ~$5-7 (vs. $14 in original plan)

---

## Integration Points

### **Your Existing Function**
```typescript
// Your chunking function creates embeddings
// Our functions consume those embeddings for context
```

### **Our New Functions**
```typescript
// analyze-document -> uses your document_chunks for context
// generate-suggestions -> uses your vector search for similar content
// document-qa -> uses your embeddings for relevant answers
// create-diagram -> uses your chunks for concept understanding
```

---

## Next Steps

1. **Add the 5 new tables** to your existing schema
2. **Deploy the 4 new Edge Functions** 
3. **Create vector search function** (if not already existing):
   ```sql
   CREATE OR REPLACE FUNCTION match_document_chunks(
     document_id INT,
     query_text TEXT,
     match_threshold FLOAT,
     match_count INT
   ) RETURNS TABLE (
     id BIGINT,
     content TEXT,
     chunk_index INT,
     similarity FLOAT
   ) AS $$
   BEGIN
     RETURN QUERY
     SELECT 
       dc.id,
       dc.content,
       dc.chunk_index,
       1 - (dc.embedding <=> ai.embed('gte-small', query_text)) AS similarity
     FROM document_chunks dc
     WHERE dc.document_id = match_document_chunks.document_id
       AND 1 - (dc.embedding <=> ai.embed('gte-small', query_text)) > match_threshold
     ORDER BY similarity DESC
     LIMIT match_count;
   END $$ LANGUAGE plpgsql;
   ```

4. **Frontend integration** with Monaco Editor
5. **Testing** with your existing document pipeline

Your existing infrastructure gives us a **massive head start** - we're essentially building the AI layer on top of your solid foundation!