from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
import tempfile
from langchain_community.document_loaders import PyPDFLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import Chroma
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.llms import Ollama
from langchain.chains import RetrievalQA
from langchain.prompts import PromptTemplate

app = FastAPI()

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Store processed documents in memory (use Redis in production)
documents_store = {}

# Prompt Template
PROMPT = PromptTemplate(
    template="""You are a helpful assistant. Answer based ONLY on context below.
If answer is not in context, say "یہ معلومات اس دستاویز میں موجود نہیں ہے۔"

Context: {context}
Question: {question}

Answer (cite page):""",
    input_variables=["context", "question"]
)

# Models
embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
llm = Ollama(model="mistral", temperature=0.1)

class Question(BaseModel):
    question: str
    filename: str

@app.get("/health")
async def health():
    return {"status": "healthy"}

@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.endswith('.pdf'):
        raise HTTPException(400, "Only PDF files allowed")
    
    try:
        # Save temp file
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name
        
        # Process PDF
        loader = PyPDFLoader(tmp_path)
        documents = loader.load()
        
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200
        )
        docs = text_splitter.split_documents(documents)
        
        # Create vector store
        vectorstore = Chroma.from_documents(
            docs, 
            embeddings,
            persist_directory=f"./chroma_db_{file.filename}"
        )
        
        # Create QA chain
        qa_chain = RetrievalQA.from_chain_type(
            llm=llm,
            chain_type="stuff",
            retriever=vectorstore.as_retriever(search_kwargs={"k": 4}),
            chain_type_kwargs={"prompt": PROMPT},
            return_source_documents=True
        )
        
        # Store in memory
        documents_store[file.filename] = qa_chain
        
        # Cleanup
        os.unlink(tmp_path)
        
        return {
            "success": True,
            "filename": file.filename,
            "pages": len(documents),
            "chunks": len(docs)
        }
        
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/ask")
async def ask_question(question: Question):
    if question.filename not in documents_store:
        raise HTTPException(404, "Document not found. Upload first.")
    
    try:
        chain = documents_store[question.filename]
        response = chain.invoke({"query": question.question})
        
        # Extract page numbers
        pages = set()
        for doc in response["source_documents"]:
            if doc.metadata.get("page") is not None:
                pages.add(doc.metadata["page"] + 1)
        
        return {
            "success": True,
            "answer": response["result"],
            "pages": sorted(list(pages))
        }
        
    except Exception as e:
        raise HTTPException(500, str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)