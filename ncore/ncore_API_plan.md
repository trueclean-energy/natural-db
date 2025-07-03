# Flexible AI Provider Architecture - Together AI + OpenAI

## Why Together AI + OpenAI Strategy is Excellent

### **Together AI Advantages:**
- **Cost**: 5-10x cheaper than OpenAI for many models
- **Speed**: Often faster inference times
- **Model Variety**: Access to Llama, Mistral, CodeLlama, etc.
- **No Rate Limits**: More predictable for production

### **OpenAI Advantages:**
- **Quality**: GPT-4 still best for complex reasoning
- **Reliability**: Most stable for production workloads
- **JSON Mode**: Structured output guarantee
- **Embeddings**: text-embedding-3-small is excellent

---

## Provider Abstraction Layer

### **Core AI Service Class**
```typescript
// /functions/shared/ai-service.ts
interface AIProvider {
  generateCompletion(prompt: string, options?: CompletionOptions): Promise<string>;
  generateStream(prompt: string, options?: CompletionOptions): Promise<ReadableStream>;
  generateEmbedding(text: string): Promise<number[]>;
}

interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  stream?: boolean;
}

class TogetherAIProvider implements AIProvider {
  private apiKey: string;
  private baseURL = 'https://api.together.xyz/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateCompletion(prompt: string, options: CompletionOptions = {}): Promise<string> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 1000,
        stream: false
      })
    });

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async generateStream(prompt: string, options: CompletionOptions = {}): Promise<ReadableStream> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 1000,
        stream: true
      })
    });

    return response.body!;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Together AI doesn't have embeddings - use OpenAI for this
    throw new Error('Together AI embeddings not supported - use OpenAI provider');
  }
}

class OpenAIProvider implements AIProvider {
  private apiKey: string;
  private baseURL = 'https://api.openai.com/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateCompletion(prompt: string, options: CompletionOptions = {}): Promise<string> {
    const messages = options.jsonMode 
      ? [
          { role: 'system', content: 'You are a helpful assistant. Always respond with valid JSON.' },
          { role: 'user', content: prompt }
        ]
      : [{ role: 'user', content: prompt }];

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || 'gpt-4',
        messages,
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 1000,
        ...(options.jsonMode && { response_format: { type: 'json_object' } })
      })
    });

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async generateStream(prompt: string, options: CompletionOptions = {}): Promise<ReadableStream> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 1000,
        stream: true
      })
    });

    return response.body!;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text
      })
    });

    const data = await response.json();
    return data.data[0].embedding;
  }
}

// Factory function to create the appropriate provider
export function createAIProvider(provider: 'openai' | 'together' = 'together'): AIProvider {
  switch (provider) {
    case 'openai':
      return new OpenAIProvider(Deno.env.get('OPENAI_API_KEY')!);
    case 'together':
      return new TogetherAIProvider(Deno.env.get('TOGETHER_API_KEY')!);
    default:
      throw new Error(`Unsupported AI provider: ${provider}`);
  }
}
```

---

## Smart Provider Selection Strategy

### **Environment Configuration**
```typescript
// Environment variables for provider selection
const AI_CONFIG = {
  // Primary provider for different tasks
  DOCUMENT_ANALYSIS: Deno.env.get('AI_ANALYSIS_PROVIDER') || 'together',
  SUGGESTIONS: Deno.env.get('AI_SUGGESTIONS_PROVIDER') || 'together', 
  QA: Deno.env.get('AI_QA_PROVIDER') || 'together',
  DIAGRAMS: Deno.env.get('AI_DIAGRAMS_PROVIDER') || 'together',
  
  // Fallback provider
  FALLBACK: Deno.env.get('AI_FALLBACK_PROVIDER') || 'openai',
  
  // Models for each provider
  TOGETHER_MODELS: {
    FAST: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
    QUALITY: 'meta-llama/Llama-3.1-70B-Instruct-Turbo',
    CODE: 'codellama/CodeLlama-34b-Instruct-hf'
  },
  
  OPENAI_MODELS: {
    FAST: 'gpt-4o-mini',
    QUALITY: 'gpt-4',
    CODE: 'gpt-4'
  }
};
```

### **Smart Provider Service**
```typescript
// /functions/shared/smart-ai-service.ts
class SmartAIService {
  private providers: Map<string, AIProvider> = new Map();

  constructor() {
    this.providers.set('openai', createAIProvider('openai'));
    this.providers.set('together', createAIProvider('together'));
  }

  async generateWithFallback(
    prompt: string, 
    primaryProvider: string, 
    options: CompletionOptions = {}
  ): Promise<string> {
    try {
      const provider = this.providers.get(primaryProvider);
      if (!provider) throw new Error(`Provider ${primaryProvider} not found`);
      
      return await provider.generateCompletion(prompt, options);
    } catch (error) {
      console.warn(`${primaryProvider} failed, falling back to ${AI_CONFIG.FALLBACK}:`, error);
      
      const fallbackProvider = this.providers.get(AI_CONFIG.FALLBACK);
      if (!fallbackProvider) throw error;
      
      return await fallbackProvider.generateCompletion(prompt, {
        ...options,
        model: AI_CONFIG.OPENAI_MODELS.QUALITY // Use best model for fallback
      });
    }
  }

  async generateStreamWithFallback(
    prompt: string, 
    primaryProvider: string, 
    options: CompletionOptions = {}
  ): Promise<ReadableStream> {
    try {
      const provider = this.providers.get(primaryProvider);
      if (!provider) throw new Error(`Provider ${primaryProvider} not found`);
      
      return await provider.generateStream(prompt, options);
    } catch (error) {
      console.warn(`${primaryProvider} streaming failed, falling back to ${AI_CONFIG.FALLBACK}:`, error);
      
      const fallbackProvider = this.providers.get(AI_CONFIG.FALLBACK);
      if (!fallbackProvider) throw error;
      
      return await fallbackProvider.generateStream(prompt, options);
    }
  }

  // Task-specific methods with optimal provider selection
  async analyzeDocument(content: string): Promise<string> {
    const prompt = `Analyze this document and return JSON with missing sections and improvements:\n\n${content}`;
    
    return await this.generateWithFallback(prompt, AI_CONFIG.DOCUMENT_ANALYSIS, {
      model: AI_CONFIG.DOCUMENT_ANALYSIS === 'together' 
        ? AI_CONFIG.TOGETHER_MODELS.QUALITY 
        : AI_CONFIG.OPENAI_MODELS.QUALITY,
      jsonMode: true
    });
  }

  async generateSuggestions(context: string): Promise<ReadableStream> {
    const prompt = `Generate 2-3 contextual suggestions for this content:\n\n${context}`;
    
    return await this.generateStreamWithFallback(prompt, AI_CONFIG.SUGGESTIONS, {
      model: AI_CONFIG.SUGGESTIONS === 'together' 
        ? AI_CONFIG.TOGETHER_MODELS.FAST 
        : AI_CONFIG.OPENAI_MODELS.FAST,
      temperature: 0.8
    });
  }

  async answerQuestion(question: string, context: string): Promise<string> {
    const prompt = `Context: ${context}\n\nQuestion: ${question}\n\nAnswer:`;
    
    return await this.generateWithFallback(prompt, AI_CONFIG.QA, {
      model: AI_CONFIG.QA === 'together' 
        ? AI_CONFIG.TOGETHER_MODELS.QUALITY 
        : AI_CONFIG.OPENAI_MODELS.QUALITY,
      temperature: 0.3
    });
  }

  async createDiagram(concept: string, context: string): Promise<string> {
    const prompt = `Create a Mermaid diagram for concept "${concept}" using this context:\n\n${context}`;
    
    return await this.generateWithFallback(prompt, AI_CONFIG.DIAGRAMS, {
      model: AI_CONFIG.DIAGRAMS === 'together' 
        ? AI_CONFIG.TOGETHER_MODELS.QUALITY 
        : AI_CONFIG.OPENAI_MODELS.QUALITY,
      jsonMode: true
    });
  }
}

export const smartAI = new SmartAIService();
```

---

## Updated Edge Functions

### **Document Analysis with Provider Flexibility**
```typescript
// /functions/analyze-document/index.ts
import { smartAI } from '../shared/smart-ai-service.ts';

export default async function handler(req: Request) {
  const { document_id } = await req.json();
  
  // Get document content (same as before)
  const { data: doc } = await supabase
    .from('documents_reference')
    .select('*')
    .eq('document_id', document_id)
    .single();

  const content = doc.markdown_content || doc.typescript_content || 
                 JSON.stringify(doc.json_file, null, 2);
  
  // Use smart AI service with automatic fallback
  const analysisResult = await smartAI.analyzeDocument(content);
  const analysis = JSON.parse(analysisResult);
  
  // Store analysis
  await supabase.from('document_analysis').insert({
    document_id,
    analysis_type: 'completeness',
    analysis_result: analysis
  });
  
  return new Response(JSON.stringify(analysis));
}
```

### **Streaming Suggestions with Provider Flexibility**
```typescript
// /functions/generate-suggestions/index.ts
import { smartAI } from '../shared/smart-ai-service.ts';

export default async function handler(req: Request) {
  const { document_id, cursor_position, content } = await req.json();
  
  // Get context using vector search (same as before)
  const { data: similarChunks } = await supabase.rpc('match_document_chunks', {
    document_id,
    query_text: content.split('\n')[cursor_position.line] || '',
    match_threshold: 0.7,
    match_count: 3
  });
  
  const context = similarChunks?.map(chunk => chunk.content).join('\n') || '';
  
  // Use smart AI service with streaming
  const stream = await smartAI.generateSuggestions(context);
  
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}
```

---

## Cost & Performance Optimization

### **Together AI Models for Different Tasks**
```typescript
const TASK_MODELS = {
  // Fast tasks - use smaller models
  SUGGESTIONS: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
  SIMPLE_QA: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
  
  // Quality tasks - use larger models  
  DOCUMENT_ANALYSIS: 'meta-llama/Llama-3.1-70B-Instruct-Turbo',
  COMPLEX_QA: 'meta-llama/Llama-3.1-70B-Instruct-Turbo',
  
  // Code tasks - use specialized models
  CODE_ANALYSIS: 'codellama/CodeLlama-34b-Instruct-hf',
  TYPESCRIPT_HELP: 'codellama/CodeLlama-34b-Instruct-hf'
};
```

### **Cost Comparison (Monthly)**
```typescript
// Together AI (Primary)
const TOGETHER_COSTS = {
  'Llama-3.1-8B-Instruct-Turbo': { input: 0.2, output: 0.2 }, // per 1M tokens
  'Llama-3.1-70B-Instruct-Turbo': { input: 0.9, output: 0.9 },
  'CodeLlama-34b-Instruct-hf': { input: 0.8, output: 0.8 }
};

// OpenAI (Fallback)
const OPENAI_COSTS = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4': { input: 30, output: 60 }
};

// Estimated monthly cost with 90% Together AI, 10% OpenAI fallback
// Together AI: ~$2-3/month
// OpenAI fallback: ~$1-2/month
// Total: ~$3-5/month (vs $14 with OpenAI-only)
```

---

## Environment Variables Setup

```bash
# Supabase Edge Functions Environment Variables

# API Keys
OPENAI_API_KEY=your_openai_key
TOGETHER_API_KEY=your_together_key

# Provider Selection (can be changed per deployment)
AI_ANALYSIS_PROVIDER=together
AI_SUGGESTIONS_PROVIDER=together
AI_QA_PROVIDER=together
AI_DIAGRAMS_PROVIDER=together
AI_FALLBACK_PROVIDER=openai

# Optional: Model overrides
TOGETHER_ANALYSIS_MODEL=meta-llama/Llama-3.1-70B-Instruct-Turbo
TOGETHER_SUGGESTIONS_MODEL=meta-llama/Llama-3.1-8B-Instruct-Turbo
```

---

## Deployment Strategy

### **Development**: Together AI Primary
```bash
# Fast iteration, low cost
AI_ANALYSIS_PROVIDER=together
AI_SUGGESTIONS_PROVIDER=together
AI_QA_PROVIDER=together
AI_FALLBACK_PROVIDER=openai
```

### **Production**: Hybrid Strategy
```bash
# Quality tasks: OpenAI, Speed tasks: Together AI
AI_ANALYSIS_PROVIDER=openai      # Best quality for analysis
AI_SUGGESTIONS_PROVIDER=together # Fast suggestions
AI_QA_PROVIDER=together         # Good enough for Q&A
AI_FALLBACK_PROVIDER=openai     # Reliable fallback
```

---

## Key Benefits

1. **Cost Savings**: 70-80% reduction using Together AI
2. **Flexibility**: Switch providers per task or deployment
3. **Reliability**: Automatic fallback to OpenAI
4. **Performance**: Together AI often faster than OpenAI
5. **Model Choice**: Access to Llama, CodeLlama, etc.

---

## Implementation Timeline

**Week 1**: Build abstraction layer + document analysis
**Week 1.5**: Add streaming suggestions with provider flexibility
**Week 2**: Q&A system with smart provider selection
**Week 2.5**: Diagram generation with model optimization
**Week 3**: Testing, monitoring, and cost optimization

The architecture gives you maximum flexibility while maintaining the performance and reliability your users expect!