const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// API Details
const NAVIGATOR_CHAT_URL = 'https://api.ai.it.ufl.edu/v1/chat/completions';
const NAVIGATOR_EMBED_URL = 'https://api.ai.it.ufl.edu/v1/embeddings';
const NAVIGATOR_API_KEY = process.env.NAVIGATOR_API_KEY;
const LLM_MODEL = 'llama-3.1-8b-instruct';
const EMBED_MODEL = 'nomic-embed-text-v1.5';

const DB_PATH = path.join(__dirname, 'vector_store.json');
let vectorDB = [];

// Cosine Similarity Math
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Function to fetch embeddings from UF API
async function getEmbedding(text) {
    const response = await fetch(NAVIGATOR_EMBED_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${NAVIGATOR_API_KEY}`
        },
        body: JSON.stringify({
            model: EMBED_MODEL,
            input: text
        })
    });
    if (!response.ok) {
        throw new Error(`Embedding API Error: ${await response.text()}`);
    }
    const data = await response.json();
    return data.data[0].embedding;
}

// Initialize Vector Database
async function initVectorDB() {
    if (fs.existsSync(DB_PATH)) {
        console.log('Loading existing vector database...');
        const rawData = fs.readFileSync(DB_PATH, 'utf8');
        vectorDB = JSON.parse(rawData);
        console.log(`Loaded ${vectorDB.length} chunks into memory.`);
    } else {
        console.log('Vector database not found. Building new embeddings...');
        const manualText = fs.readFileSync(path.join(__dirname, 'manual_clean.txt'), 'utf8');
        // Split by paragraphs, filter out empty ones, handling Windows \r\n and Unix \n
        const chunks = manualText.split(/\r?\n\r?\n/).map(c => c.trim()).filter(c => c.length > 20);
        
        console.log(`Found ${chunks.length} text chunks. Generating embeddings (this may take a moment)...`);
        
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            try {
                const embedding = await getEmbedding(chunk);
                vectorDB.push({
                    text: chunk,
                    embedding: embedding
                });
                if ((i + 1) % 10 === 0) console.log(`Processed ${i + 1}/${chunks.length} chunks...`);
            } catch (err) {
                console.error(`Failed to embed chunk ${i}:`, err.message);
            }
        }
        
        fs.writeFileSync(DB_PATH, JSON.stringify(vectorDB, null, 2));
        console.log(`Vector database built and saved to ${DB_PATH}!`);
    }
}

// Perform Semantic Vector Search
async function semanticSearch(query, topK = 5) {
    console.log(`Embedding user query: "${query}"...`);
    const queryEmbedding = await getEmbedding(query);
    
    // Calculate similarities for all chunks
    const scoredChunks = vectorDB.map(item => ({
        text: item.text,
        score: cosineSimilarity(queryEmbedding, item.embedding)
    }));
    
    // Sort descending by score
    scoredChunks.sort((a, b) => b.score - a.score);
    
    // Filter and return top K
    return scoredChunks.slice(0, topK).map(item => item.text).join('\n\n...\n\n');
}

// Chat Endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;
        
        // 1. Semantic Retrieval using Vectors
        const context = await semanticSearch(userMessage);

        // 2. Prepare payload for the UF Navigator LLM API
        const systemPrompt = `You are the friendly "Gator Game Room Assistant" for the University of Florida Reitz Union Game Room.
You help student employees and staff with rules, policies, and operations.
Always use HTML formatting (like <strong>, <ul>, <li>, <br>) to structure your answers beautifully so they look great on the website.
Answer the user's question concisely based ONLY on the following context retrieved from the official Game Room Operation Manual.
If the answer is not clearly found in the context, politely say you don't know based on the manual. Do not invent rules.

CONTEXT FROM MANUAL:
${context}`;

        console.log("Sending prompt to UF Navigator LLM...");

        const response = await fetch(NAVIGATOR_CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${NAVIGATOR_API_KEY}`
            },
            body: JSON.stringify({
                model: LLM_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage }
                ],
                temperature: 0.1 // strict factual
            })
        });

        if (!response.ok) throw new Error(`API Error: ${await response.text()}`);

        const data = await response.json();
        res.json({ response: data.choices[0].message.content });

    } catch (error) {
        console.error('Chat API Error:', error.message);
        res.status(500).json({ error: 'Failed to process chat request' });
    }
});

// Start Server and Init DB
app.listen(PORT, async () => {
    console.log(`Server running at http://localhost:${PORT}`);
    await initVectorDB();
});
