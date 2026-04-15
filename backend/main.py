from fastapi import FastAPI, UploadFile, File, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import List, Optional
import asyncio
import json
from datetime import datetime
import redis
from celery import Celery
import hashlib

app = FastAPI(title="PDF Law AI Pro API", version="2.0.0")

# Security
security = HTTPBearer()

# Redis for caching and rate limiting
redis_client = redis.Redis(host='localhost', port=6379, decode_responses=True)

# Celery for background tasks
celery_app = Celery('tasks', broker='redis://localhost:6379/0')

# WebSocket connections manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.user_connections: dict = {}
    
    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        self.active_connections.append(websocket)
        self.user_connections[user_id] = websocket
    
    def disconnect(self, websocket: WebSocket, user_id: str):
        self.active_connections.remove(websocket)
        if user_id in self.user_connections:
            del self.user_connections[user_id]
    
    async def send_personal_message(self, message: str, user_id: str):
        if user_id in self.user_connections:
            await self.user_connections[user_id].send_text(message)
    
    async def broadcast(self, message: str):
        for connection in self.active_connections:
            await connection.send_text(message)

manager = ConnectionManager()

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message['type'] == 'question':
                # Process question with streaming
                async for chunk in process_question_stream(message['question'], message['documents']):
                    await websocket.send_text(json.dumps({
                        'type': 'stream',
                        'chunk': chunk,
                        'done': False
                    }))
                
                await websocket.send_text(json.dumps({
                    'type': 'stream',
                    'done': True
                }))
                
    except WebSocketDisconnect:
        manager.disconnect(websocket, client_id)

@celery_app.task
def process_document_async(file_path: str, file_name: str):
    """Process document in background"""
    # Document processing logic here
    return {"status": "completed", "filename": file_name}

@app.post("/upload-multiple")
async def upload_multiple_documents(
    files: List[UploadFile] = File(...),
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    """Upload and process multiple documents"""
    
    # Rate limiting
    user_id = verify_token(credentials.credentials)
    rate_key = f"rate_limit:{user_id}"
    current = redis_client.incr(rate_key)
    if current == 1:
        redis_client.expire(rate_key, 60)
    if current > 10:  # 10 requests per minute
        raise HTTPException(429, "Rate limit exceeded")
    
    async def progress_generator():
        for i, file in enumerate(files):
            # Validate file
            if not file.filename.endswith('.pdf'):
                yield json.dumps({"error": f"{file.filename} is not a PDF"})
                continue
            
            # Process file
            task = process_document_async.delay(file.filename, file.filename)
            
            yield json.dumps({
                "progress": {
                    "current": i + 1,
                    "total": len(files)
                },
                "document": {
                    "id": task.id,
                    "filename": file.filename
                }
            })
            
            await asyncio.sleep(0.1)
        
        yield json.dumps({"completed": True})
    
    return StreamingResponse(
        progress_generator(),
        media_type="application/x-ndjson"
    )

@app.post("/compare")
async def compare_documents(
    doc1: str,
    doc2: str,
    query: str,
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    """Compare two documents"""
    
    # Load both documents from vector stores
    vectorstore1 = load_vectorstore(doc1)
    vectorstore2 = load_vectorstore(doc2)
    
    # Get relevant chunks
    chunks1 = vectorstore1.similarity_search(query, k=5)
    chunks2 = vectorstore2.similarity_search(query, k=5)
    
    # Generate comparison using LLM
    comparison_prompt = f"""
    Compare these two documents regarding: {query}
    
    Document A:
    {chunks1}
    
    Document B:
    {chunks2}
    
    Provide analysis in JSON format with:
    - similarities: List of similar points
    - differences: List of differences
    - recommendation: Which document is better for this query
    """
    
    comparison = await llm.ainvoke(comparison_prompt)
    
    return {
        "comparison": json.loads(comparison),
        "sources": {
            "doc1": [doc.metadata for doc in chunks1],
            "doc2": [doc.metadata for doc in chunks2]
        }
    }

@app.post("/export/{format}")
async def export_chat(
    format: str,
    chat_data: dict,
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    """Export chat in various formats"""
    
    if format == "pdf":
        # Generate PDF using reportlab
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas
        
        pdf_path = f"/tmp/chat_{datetime.now().timestamp()}.pdf"
        c = canvas.Canvas(pdf_path, pagesize=letter)
        
        y = 750
        for msg in chat_data['messages']:
            c.drawString(50, y, f"{msg['role']}: {msg['content'][:100]}")
            y -= 20
            if y < 50:
                c.showPage()
                y = 750
        
        c.save()
        
        return FileResponse(
            pdf_path,
            media_type='application/pdf',
            filename=f"chat_export_{datetime.now()}.pdf"
        )
    
    elif format == "txt":
        content = "\n\n".join([
            f"{msg['role'].upper()}: {msg['content']}\n{'-'*50}"
            for msg in chat_data['messages']
        ])
        
        return {"content": content}
    
    raise HTTPException(400, "Unsupported format")

# Rate limiting middleware
@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    client_ip = request.client.host
    rate_key = f"api_rate:{client_ip}"
    
    current = redis_client.incr(rate_key)
    if current == 1:
        redis_client.expire(rate_key, 60)
    
    if current > 100:  # 100 requests per minute
        return Response("Rate limit exceeded", status_code=429)
    
    return await call_next(request)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)