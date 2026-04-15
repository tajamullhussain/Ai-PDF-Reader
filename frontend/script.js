// Backend API URL (Change this if deployed)
const API_URL = 'http://localhost:8000';

// State Management
let currentFile = null;
let isProcessing = false;
let messages = [];

// DOM Elements
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const statusBadge = document.getElementById('statusBadge');
const statsContainer = document.getElementById('statsContainer');
const pageCount = document.getElementById('pageCount');
const chunkCount = document.getElementById('chunkCount');
const clearChatBtn = document.getElementById('clearChatBtn');
const chatMessages = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const welcomeMessage = document.querySelector('.welcome-message');

// Event Listeners
uploadArea.addEventListener('click', () => fileInput.click());
uploadBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
});

fileInput.addEventListener('change', handleFileSelect);
uploadArea.addEventListener('dragover', handleDragOver);
uploadArea.addEventListener('dragleave', handleDragLeave);
uploadArea.addEventListener('drop', handleDrop);
clearChatBtn.addEventListener('click', clearChat);
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', handleKeyPress);
messageInput.addEventListener('input', autoResize);

// File Handling Functions
function handleDragOver(e) {
    e.preventDefault();
    uploadArea.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        handleFile(files[0]);
    }
}

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) {
        handleFile(file);
    }
}

async function handleFile(file) {
    if (file.type !== 'application/pdf') {
        alert('Please upload a PDF file');
        return;
    }
    
    currentFile = file;
    
    // Update UI
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);
    fileInfo.style.display = 'flex';
    uploadArea.style.display = 'none';
    statusBadge.textContent = 'Processing...';
    statusBadge.classList.add('processing');
    
    // Enable input
    messageInput.disabled = false;
    sendBtn.disabled = false;
    
    // Upload to backend
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const response = await fetch(`${API_URL}/upload`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            statusBadge.textContent = 'Ready';
            statusBadge.classList.remove('processing');
            pageCount.textContent = data.pages;
            chunkCount.textContent = data.chunks;
            statsContainer.style.display = 'flex';
            
            // Hide welcome message
            if (welcomeMessage) {
                welcomeMessage.style.display = 'none';
            }
        } else {
            throw new Error(data.error);
        }
    } catch (error) {
        console.error('Upload error:', error);
        statusBadge.textContent = 'Error';
        statusBadge.style.color = 'var(--error)';
        alert('Failed to process PDF. Make sure backend is running.');
    }
}

// Chat Functions
async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentFile) return;
    
    // Add user message
    addMessage(text, 'user');
    messageInput.value = '';
    messageInput.style.height = 'auto';
    
    // Show typing indicator
    showTypingIndicator();
    
    try {
        const response = await fetch(`${API_URL}/ask`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                question: text,
                filename: currentFile.name
            })
        });
        
        const data = await response.json();
        
        // Remove typing indicator
        removeTypingIndicator();
        
        if (data.success) {
            addMessage(data.answer, 'assistant', data.pages);
        } else {
            addMessage('Sorry, I couldn\'t process that question. Please try again.', 'assistant');
        }
    } catch (error) {
        console.error('Question error:', error);
        removeTypingIndicator();
        addMessage('Error connecting to backend. Make sure the server is running.', 'assistant');
    }
}

function addMessage(content, role, pages = null) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;
    
    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.innerHTML = role === 'user' ? '<i class="fas fa-user"></i>' : '<i class="fas fa-robot"></i>';
    
    // Content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = formatMessage(content);
    
    // Citation
    if (pages && pages.length > 0) {
        const citation = document.createElement('div');
        citation.className = 'message-citation';
        citation.innerHTML = `<i class="fas fa-bookmark"></i> Reference: Page${pages.length > 1 ? 's' : ''} ${pages.join(', ')}`;
        contentDiv.appendChild(citation);
    }
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
    
    messages.push({ content, role, pages });
}

function showTypingIndicator() {
    const indicator = document.createElement('div');
    indicator.className = 'message assistant';
    indicator.id = 'typingIndicator';
    
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.innerHTML = '<i class="fas fa-robot"></i>';
    
    const dots = document.createElement('div');
    dots.className = 'message-content typing-indicator';
    dots.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    
    indicator.appendChild(avatar);
    indicator.appendChild(dots);
    
    chatMessages.appendChild(indicator);
    scrollToBottom();
}

function removeTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
        indicator.remove();
    }
}

function clearChat() {
    chatMessages.innerHTML = '';
    messages = [];
    
    // Show welcome message if it exists
    if (welcomeMessage) {
        welcomeMessage.style.display = 'block';
    }
}

// Utility Functions
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatMessage(text) {
    // Convert URLs to links
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    text = text.replace(urlRegex, '<a href="$1" target="_blank">$1</a>');
    
    // Convert line breaks to <br>
    text = text.replace(/\n/g, '<br>');
    
    return text;
}

function handleKeyPress(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

function autoResize() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
}

function scrollToBottom() {
    const container = document.querySelector('.chat-container');
    container.scrollTop = container.scrollHeight;
}

// Check backend health on load
async function checkBackend() {
    try {
        const response = await fetch(`${API_URL}/health`);
        const data = await response.json();
        console.log('Backend status:', data);
    } catch (error) {
        console.warn('Backend not running. Start the FastAPI server.');
    }
}

checkBackend();