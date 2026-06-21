# Gator Game Room Assistant 🐊

A responsive, intelligent chatbot and web portal designed specifically for the University of Florida Reitz Union Game Room staff. 

This application uses a **Semantic Vector Database (RAG)** powered by the UF Navigator LLM API to instantly answer staff questions about operations, policies, scheduling, and emergency procedures based on the official Game Room Operation Manual.

---

## ✨ Features

- **Agentic RAG Engine:** Converts the 14-page operation manual into mathematical vectors for instant, hyper-accurate semantic search.
- **UF Navigator API Integration:** Uses `nomic-embed-text-v1.5` for text embeddings and `llama-3.1-8b-instruct` for generating perfectly formatted, conversational answers.
- **Zero-Dependency Vector DB:** Uses a highly optimized, embedded local JSON vector store (`vector_store.json`), meaning there's no need to install Docker or heavy databases like Chroma DB.
- **Official UF Aesthetics:** Features a pristine light theme matching the official Reitz Union website, complete with UF Blue (`#00529b`) and UF Orange (`#FA4616`) branding.
- **Mobile Responsive:** Works seamlessly on desktop monitors at the front desk or on staff mobile phones.

---

## 🛠️ Tech Stack

- **Frontend:** Vanilla HTML5, CSS3, JavaScript (Glassmorphism & scroll animations)
- **Backend:** Node.js, Express.js
- **LLM/AI:** UF Navigator API (LLaMA 3.1 8B, Nomic Embeddings)
- **Database:** Local JSON Vector Store with Cosine Similarity math

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) installed on your machine.
- A valid **UF Navigator API Key**.

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/gameroom-chatbot.git
   cd gameroom-chatbot
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory and add your UF API key:
   ```env
   NAVIGATOR_API_KEY=sk-your-api-key-here
   PORT=3000
   ```
   *(Note: The `.env` file is git-ignored to protect your credentials).*

4. **Start the Server & Build the Database:**
   ```bash
   node server.js
   ```
   On the first run, the server will automatically chunk the `manual_clean.txt` file, call the UF Embeddings API, and generate the `vector_store.json` database.

5. **Open the App:**
   Navigate to `http://localhost:3000` in your browser. 

---

## 📚 Updating the Manual

If the Game Room policies change and you need to update the chatbot's knowledge:
1. Update the text inside `manual_clean.txt`.
2. Delete the `vector_store.json` file.
3. Restart the server (`node server.js`).
4. The system will automatically generate a new semantic vector database from the updated text!

---

*Built for the Reitz Union Division of Student Life.*
