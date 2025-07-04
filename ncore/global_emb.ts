import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { RecursiveCharacterTextSplitter } from "https://esm.sh/langchain@0.3.29/text_splitter";

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 100;
const BATCH_SIZE = 128;          // number of chunks to embed per request
const MAX_CHUNKS  = 1024;        // refuse truly huge docs

serve(async (req) => {
  const started = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);

  try {
    const { document_id } = await req.json();
    if (!document_id) {
      return json({ error: "document_id is required" }, 400);
    }
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!url || !key) {
      console.error("❌ Missing environment variables");
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    
    /* ── 1.  Lookup markdown_file_path ────────────────────────────── */
    const { data: ref, error: refErr } = await supabase
      .from("documents_reference")
      .select("markdown_file_path")
      .eq("document_id", document_id)
      .single();

    if (refErr || !ref?.markdown_file_path) {
      return json({ error: "Document reference not found", details: refErr?.message }, 404);
    }
    const filePath = ref.markdown_file_path;

    /* ── 2.  Signed URL for Storage object ───────────────────────── */
    const { data: signed, error: signErr } = await supabase.storage
      .from("ncore-test")                // bucket name
      .createSignedUrl(filePath, 60);

    if (signErr || !signed?.signedUrl) {
      return json({ error: "Failed to create signed URL", details: signErr?.message }, 500);
    }

    /* ── 3.  Fetch markdown in memory ─────────────────────────────── */
    const fileRes = await fetch(signed.signedUrl);
    if (!fileRes.ok) return json({ error: "Failed to fetch markdown file" }, 502);

    const markdown = await fileRes.text();

    /* ── 4.  Chunk markdown ───────────────────────────────────────── */
    console.time(`${requestId}-chunking`);
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });
    const chunks = await splitter.splitText(markdown);
    console.timeEnd(`${requestId}-chunking`);

    if (chunks.length > MAX_CHUNKS) {
      return json({ error: "Document too large", chunks: chunks.length }, 413);
    }

    /* ── 5.  Batch‑embed & insert ─────────────────────────────────── */
    const session = new Supabase.ai.Session("gte-small");
    let inserted = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const slice = chunks.slice(i, i + BATCH_SIZE);         // string[]
      console.time(`${requestId}-embed-${i}`);
      const vectors = await session.run(slice, { mean_pool: true, normalize: true });
      console.timeEnd(`${requestId}-embed-${i}`);

      // build rows for this batch
      const rows = vectors.map((embedding: number[], j: number) => ({
        document_id,
        chunk_index: i + j,
        content: slice[j],
        embedding,
      }));

      const { error: insertErr } = await supabase
        .from("document_chunks")
        .insert(rows);

      if (insertErr) {
        return json({ error: "Failed to insert embeddings", details: insertErr.message }, 500);
      }
      inserted += rows.length;
    }

    /* ── 6.  Success response ─────────────────────────────────────── */
    return json({
      success: true,
      document_id,
      chunks_created: inserted,
      message: `Embedded ${inserted} chunks in ${Date.now() - started} ms`
    });
  } catch (e) {
    return json({ error: "Unexpected error", details: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/* ---------- helper ------------------------------------------------ */
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}