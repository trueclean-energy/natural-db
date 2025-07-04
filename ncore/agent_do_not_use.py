"""
Conversational RAG agent using LangChain v0.3, pgvector (langchain-postgres) and Together AI
with ConversationSummaryBufferMemory.
"""

import os, uuid, requests
from typing import Any, Dict, Optional, List
from pathlib import Path
from dotenv import load_dotenv
from langchain_core.messages import SystemMessage
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_postgres import PGVector
from langchain.chains import (
    create_history_aware_retriever,
    create_retrieval_chain,
)
from langchain.chains.combine_documents import create_stuff_documents_chain
from langchain.memory import ConversationSummaryBufferMemory
from langchain_core.prompts import PromptTemplate
from langchain_core.runnables import RunnableWithMessageHistory
from langchain.llms.base import LLM
from langchain_core.documents import Document
from pydantic import Field
from langchain.retrievers import EnsembleRetriever
from langchain_text_splitters import RecursiveCharacterTextSplitter

load_dotenv()
DB_URL = os.getenv("DATABASE_URL")
API_KEY = os.getenv("TOGETHER_API_KEY")
if not (DB_URL and API_KEY):
    raise RuntimeError("Set both DATABASE_URL and TOGETHER_API_KEY")

# ─── Together AI thin wrapper ────────────────────
class LLMClient:
    def __init__(self, provider="together"):
        self.provider = provider
        self.api_key = os.environ.get("TOGETHER_API_KEY")
        
    def generate(self, prompt):
        import requests
        
        url = "https://api.together.xyz/v1/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        data = {
            "model": "mistralai/Mixtral-8x7B-Instruct-v0.1",
            "prompt": prompt,
            "max_tokens": 1024,
            "temperature": 0.7,
        }
        
        response = requests.post(url, headers=headers, json=data)
        return response.json()

# This is a custom LLM class that uses the Together API
class CustomLLM(LLM):
    client: Any = Field(..., exclude=True)

    def __init__(self, client: Any, **kwargs: Any):
        super().__init__(client=client, **kwargs)
        self.client = client

    def _call(self, prompt: str, stop: Any = None) -> str:
        response = self.client.generate(prompt)
        print("🔍 Raw response:", response)  # Debug output

        # Handle Together API response format
        if 'choices' in response:
            # Together API returns text directly in the 'text' field of choices
            if 'text' in response['choices'][0]:
                return response['choices'][0]['text']
            # Alternative format might have a 'message' field
            elif 'message' in response['choices'][0]:
                return response['choices'][0]['message']['content']
            else:
                # If neither format is found, return the whole choice object as string
                return str(response['choices'][0])
        else:
            raise ValueError(f"Unexpected response format from LLM: {response}")

    @property
    def _identifying_params(self) -> dict:
        return {"client": str(self.client)}

    @property
    def _llm_type(self) -> str:
        return "custom_llm"

    class Config:
        arbitrary_types_allowed = True


# ─── Main agent ──────────────────────────────────
class RAGAgent:
    def __init__(self, enable_initial_overview: bool = True):
        # Initialize session ID first
        self.session_id = str(uuid.uuid4())

        # LLM
        self.llm = CustomLLM(client=LLMClient(API_KEY))

        # Embeddings (must match those used to populate pgvector)
        self.embeddings = HuggingFaceEmbeddings(
            model_name="sentence-transformers/paraphrase-MiniLM-L6-v2"
        )
        
        # ---- 1) load and chunk markdown -------------------------------------------------
        MD_PATH = "./report.md"
        markdown_txt = Path(MD_PATH).read_text(encoding="utf-8")

        # Proper chunking - split into smaller chunks before storing
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=1200,   # ≈600–800 tokens
            chunk_overlap=150
        )

        chunks = splitter.split_text(markdown_txt)

        docs = [
            Document(page_content=c,
                     metadata={"session_id": self.session_id,
                               "source": f"{MD_PATH}#{i}",
                               "type": "user_upload"})
            for i, c in enumerate(chunks)
        ]

        # ---- 2) Set up both vector stores ------------------------------------
        # Global store (persistent)
        self.global_store = PGVector(
            connection =DB_URL,
            collection_name="pos_global",
            embeddings=self.embeddings,
            use_jsonb=True,
        )
        global_retriever = self.global_store.as_retriever(search_kwargs={"k": 3})

        # Temporary store (session-specific)
        COLL = f"tmp_{self.session_id}"
        self.vector_store = PGVector(
            connection =DB_URL,
            collection_name=COLL,
            embeddings=self.embeddings,
            use_jsonb=True,
        )
        # Store small chunks, not big blob
        self.vector_store.add_documents(docs)
        temp_retriever = self.vector_store.as_retriever(search_kwargs={"k": 1})

        # Combine both retrievers
        self.retriever = EnsembleRetriever(
            retrievers=[global_retriever, temp_retriever],
            weights=[0.7, 0.3]  # Give more weight to global knowledge
        )

        # Build chains + memory
        self._setup_chain()

        # ---- initial overview (optional) -----------------------------------
        if enable_initial_overview:
            # Use RAG pattern: create a focused query to retrieve relevant context
            initial_query = (
                "EBR-2 plant operating states analysis critical improvements missing information "
                "methodology enhancements regulatory standards nuclear engineering practices "
                "quantitative metrics safety operational impact schema requirements"
            )

            # Get relevant context using the retriever
            initial_context = self.retriever.get_relevant_documents(initial_query)
            
            # Use only 3 chunks to cap the prompt at ≈3 × 800 = 2 400 tokens
            context_text = "\n".join(d.page_content for d in initial_context[:3])

            # Create a concise overview prompt using only retrieved context
            overview_prompt = (
                "You are a nuclear reactor systems analyst with expertise in plant operating states analysis. "
                "Based on the following context from an EBR-2 reactor operating states analysis document, "
                "identify the top 3 critical improvements to enhance this analysis.\n\n"
                
                "TASK: Analyze the provided context and identify critical improvements based on "
                "established nuclear engineering practices and regulatory standards.\n\n"
                
                "REQUIREMENTS:\n"
                "- First provide any information that is critical but not provided/any other information in schema not defined\n"
                "- Provide specific, actionable recommendations with technical justification\n"
                "- Focus exclusively on plant operating states methodology improvements\n"
                "- Include quantitative metrics or benchmarks where applicable\n"
                "- Prioritize recommendations by potential safety and operational impact\n\n"
                
                "OUTPUT FORMAT:\n"
                "First provide what information is missing and required\n"
                "Then state what information is missing and might be helpful\n"
                "For each recommendation, provide:\n"
                "1. Specific improvement area\n"
                "2. Technical rationale\n"
                "3. Implementation approach\n"
                "4. Expected outcome/benefit\n\n"
                
                "Note: This analysis is limited to plant operating states. Other reactor systems require separate evaluation.\n\n"
                
                "CONTEXT FROM DOCUMENT:\n"
                f"{context_text}\n"
            )
            
            overview = self.llm(overview_prompt)

            # Seed the conversation so it appears as the first assistant message
            self.memory.chat_memory.add_message(SystemMessage(content="Initial document overview."))
            self.memory.chat_memory.add_ai_message(overview)

            print("\n🤖 Initial analysis:\n" + overview + "\n")
            
            # Store the initial analysis for API access
            self.initial_analysis = overview

    # ── helper to build the computation graph ──
    def _setup_chain(self):
        condense_prompt = PromptTemplate.from_template(
            "Conversation so far:\n{chat_history}\n\n"
            "Question:\n{input}\n\nSearch query:"
        )
        hist_aware = create_history_aware_retriever(
            llm=self.llm, retriever=self.retriever, prompt=condense_prompt
        )

        answer_prompt = PromptTemplate.from_template(
            "You are an AI assistant helping with questions about the POS Analysis and help them build better simulations.\n\n"
            "Use the retrieved context to answer. If the answer is not present, say "
            "\"I don't know\".\n\n"
            "Context:\n{context}\n\n"
            "Conversation so far:\n{chat_history}\n\n"
            "User question:\n{input}\n\nHelpful answer:"
        )
        qa_chain = create_stuff_documents_chain(llm=self.llm, prompt=answer_prompt)
        base_chain = create_retrieval_chain(hist_aware, qa_chain)

        # Conversation-summary memory (string summary)
        self.memory = ConversationSummaryBufferMemory(
            llm=self.llm,
            max_token_limit=3000,
            return_messages=False,
        )

        self.chat_chain = RunnableWithMessageHistory(
            runnable             = base_chain,
            get_session_history  = lambda _sid: self.memory.chat_memory,   # ← required
            input_messages_key   = "input",
            history_messages_key = "chat_history",              # matches {chat_history} in prompts
            output_messages_key  = "answer",
        )

    def _tokens(self, txt: str) -> int:
        """Estimate token count using a more accurate method"""
        # More accurate estimation: 1 token ≈ 3.5 characters for English text
        # This is closer to actual tokenization
        return len(txt) // 3.5

    def safe_chat(self, query: str) -> str:
        """Chat with hard token guard to prevent exceeding limits"""
        MAX_CTX = 32000
        
        # More accurate prompt size estimation
        # Include the actual query length plus estimated context and history
        estimated_context = 2000  # Estimated context from retrieved documents
        estimated_history = 1000  # Estimated conversation history
        estimated_prompt_template = 500  # Estimated prompt template overhead
        
        total_estimated_tokens = (
            self._tokens(query) + 
            estimated_context + 
            estimated_history + 
            estimated_prompt_template
        )
        
        if total_estimated_tokens > MAX_CTX:
            raise RuntimeError(f"Prompt would be {total_estimated_tokens} tokens (> {MAX_CTX}); aborting.")
        
        return self.chat_chain.invoke(
            {"input": query},
            config={"configurable": {"session_id": self.session_id}}
        )

    def close(self):
        # Delete the temporary collection
        try:
            self.vector_store.delete_collection()
        except Exception as e:
            print(f"⚠️  couldn't drop temp collection: {e}")

    # ── public API ──
    def chat(self, query: str) -> str:
        # Use the safe chat method with token guard
        result = self.safe_chat(query)
        return result["answer"] if isinstance(result, dict) else result

    def interactive_chat(self):
        print("🔗  RAG chat ready - type 'exit' to quit")
        import sys
        try:
            while True:
                try:
                    q = input("> ")
                except (EOFError, KeyboardInterrupt):
                    print("\nExiting...")
                    break
                
                if q.lower().strip() in {"exit", "quit", "q"}:
                    break
                
                if q.strip():  # Only process non-empty queries
                    try:
                        response = self.chat(q)
                        print(f"\n🤖 {response}\n")
                    except Exception as e:
                        print(f"❌ Error: {e}\n")
        except Exception as e:
            print(f"❌ Interactive chat error: {e}")


if __name__ == "__main__":
    # Set enable_initial_overview=False to skip the initial overview entirely
    agent = RAGAgent(enable_initial_overview=True)
    try:
        agent.interactive_chat()
    finally:
        agent.close()