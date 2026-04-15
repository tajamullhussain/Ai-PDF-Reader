// Advanced Application Logic
class PDFLawAI {
    constructor() {
        this.socket = null;
        this.activeDocuments = new Map();
        this.chatHistory = [];
        this.currentTheme = localStorage.getItem('theme') || 'dark';
        this.user = null;
        this.typingTimeout = null;
        this.isStreaming = false;
        
        this.init();
    }
    
    async init() {
        this.setupWebSocket();
        this.setupEventListeners();
        this.loadChatHistory();
        this.applyTheme();
        this.checkBackendHealth();
        this.setupAutoSave();
    }
    
    setupWebSocket() {
        this.socket = io('http://localhost:8000', {
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: 5
        });
        
        this.socket.on('connect', () => {
            this.updateStatus('Connected', 'success');
            this.socket.emit('authenticate', { token: localStorage.getItem('authToken') });
        });
        
        this.socket.on('disconnect', () => {
            this.updateStatus('Disconnected', 'error');
        });
        
        this.socket.on('stream_response', (data) => {
            this.handleStreamResponse(data);
        });
        
        this.socket.on('processing_update', (data) => {
            this.updateProcessingStatus(data);
        });
    }
    
    setupEventListeners() {
        // Theme toggle
        document.getElementById('themeToggle')?.addEventListener('click', () => {
            this.toggleTheme();
        });
        
        // Voice input
        document.getElementById('voiceInputBtn')?.addEventListener('click', () => {
            this.startVoiceInput();
        });
        
        // Export chat
        document.getElementById('exportChatBtn')?.addEventListener('click', () => {
            this.exportChat();
        });
        
        // Compare documents
        document.getElementById('compareDocsBtn')?.addEventListener('click', () => {
            this.toggleComparePanel();
        });
        
        // Auto-save messages
        window.addEventListener('beforeunload', () => {
            this.saveChatHistory();
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'k') {
                e.preventDefault();
                document.getElementById('messageInput')?.focus();
            }
            if (e.ctrlKey && e.key === 'l') {
                e.preventDefault();
                this.clearChat();
            }
        });
    }
    
    async handleStreamResponse(data) {
        const lastMessage = document.querySelector('.message.assistant:last-child .message-content');
        
        if (!lastMessage) {
            this.addMessage('', 'assistant');
        }
        
        const currentContent = lastMessage?.innerHTML || '';
        const newContent = currentContent + data.chunk;
        
        if (lastMessage) {
            lastMessage.innerHTML = marked.parse(newContent);
            lastMessage.classList.add('streaming');
            
            // Scroll to bottom smoothly
            this.scrollToBottom(true);
        }
        
        if (data.done) {
            lastMessage?.classList.remove('streaming');
            
            // Save to history
            this.chatHistory.push({
                role: 'assistant',
                content: newContent,
                timestamp: new Date().toISOString()
            });
            
            this.saveChatHistory();
        }
    }
    
    async uploadMultipleDocuments(files) {
        const formData = new FormData();
        
        for (const file of files) {
            formData.append('files', file);
        }
        
        const progressBar = document.querySelector('.progress-bar');
        const progressText = document.querySelector('.progress-text');
        
        try {
            const response = await fetch('http://localhost:8000/upload-multiple', {
                method: 'POST',
                body: formData,
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('authToken')}`
                }
            });
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value);
                const data = JSON.parse(chunk);
                
                if (data.progress) {
                    const percent = (data.progress.current / data.progress.total) * 100;
                    progressBar.style.width = `${percent}%`;
                    progressText.textContent = `${Math.round(percent)}%`;
                }
                
                if (data.completed) {
                    this.addDocumentTag(data.document);
                    this.showNotification(`${data.document.filename} uploaded successfully!`, 'success');
                }
            }
        } catch (error) {
            console.error('Upload error:', error);
            this.showNotification('Upload failed!', 'error');
        }
    }
    
    addDocumentTag(doc) {
        const tagsContainer = document.getElementById('activeDocsTags');
        const tag = document.createElement('div');
        tag.className = 'document-tag';
        tag.dataset.docId = doc.id;
        tag.innerHTML = `
            <i class="fas fa-file-pdf"></i>
            <span>${doc.filename}</span>
            <i class="fas fa-times remove-doc"></i>
        `;
        
        tag.querySelector('.remove-doc').addEventListener('click', () => {
            this.removeDocument(doc.id);
            tag.remove();
        });
        
        tagsContainer.appendChild(tag);
        this.activeDocuments.set(doc.id, doc);
        
        // Enable input if this is first document
        if (this.activeDocuments.size === 1) {
            document.getElementById('messageInput').disabled = false;
            document.getElementById('sendBtn').disabled = false;
        }
        
        this.updateContextInfo();
    }
    
    async compareDocuments(docId1, docId2, query) {
        const response = await fetch('http://localhost:8000/compare', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify({
                doc1: docId1,
                doc2: docId2,
                query: query
            })
        });
        
        const data = await response.json();
        
        // Display comparison results
        this.displayComparison(data);
    }
    
    async exportChat(format = 'pdf') {
        const chatData = {
            messages: this.chatHistory,
            metadata: {
                exportedAt: new Date().toISOString(),
                user: this.user,
                totalMessages: this.chatHistory.length
            }
        };
        
        const response = await fetch(`http://localhost:8000/export/${format}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify(chatData)
        });
        
        if (format === 'pdf') {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `chat_export_${Date.now()}.pdf`;
            a.click();
            URL.revokeObjectURL(url);
        } else {
            const data = await response.json();
            this.downloadFile(data.content, `chat_export_${Date.now()}.txt`, 'text/plain');
        }
        
        this.showNotification(`Chat exported as ${format.toUpperCase()}!`, 'success');
    }
    
    setupAutoSave() {
        setInterval(() => {
            if (this.chatHistory.length > 0) {
                this.saveChatHistory();
            }
        }, 30000); // Auto-save every 30 seconds
    }
    
    saveChatHistory() {
        localStorage.setItem('chatHistory', JSON.stringify(this.chatHistory));
        localStorage.setItem('activeDocuments', JSON.stringify(Array.from(this.activeDocuments.values())));
    }
    
    loadChatHistory() {
        const saved = localStorage.getItem('chatHistory');
        if (saved) {
            this.chatHistory = JSON.parse(saved);
            this.renderChatHistory();
        }
        
        const savedDocs = localStorage.getItem('activeDocuments');
        if (savedDocs) {
            const docs = JSON.parse(savedDocs);
            docs.forEach(doc => this.addDocumentTag(doc));
        }
    }
    
    toggleTheme() {
        this.currentTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
        document.body.setAttribute('data-theme', this.currentTheme);
        localStorage.setItem('theme', this.currentTheme);
        
        const icon = document.querySelector('#themeToggle i');
        icon.className = this.currentTheme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    }
    
    updateStatus(message, type) {
        const statusText = document.getElementById('statusText');
        const statusDot = document.getElementById('statusDot');
        
        statusText.textContent = message;
        statusDot.className = `status-dot ${type}`;
    }
    
    scrollToBottom(smooth = false) {
        const container = document.getElementById('chatContainer');
        container.scrollTo({
            top: container.scrollHeight,
            behavior: smooth ? 'smooth' : 'auto'
        });
    }
    
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <i class="fas ${type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle'}"></i>
            <span>${message}</span>
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.classList.add('show');
        }, 100);
        
        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
    
    async checkBackendHealth() {
        try {
            const response = await fetch('http://localhost:8000/health');
            const data = await response.json();
            
            if (data.status === 'healthy') {
                this.updateStatus('Connected', 'success');
            } else {
                this.updateStatus('Degraded', 'warning');
            }
        } catch (error) {
            this.updateStatus('Offline', 'error');
            this.showNotification('Cannot connect to backend server!', 'error');
        }
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new PDFLawAI();
});