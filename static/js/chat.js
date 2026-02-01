/**
 * Real-Time Chatroom Client-Side JavaScript
 * 
 * This script handles:
 * - Socket.IO connection and events
 * - Session persistence using localStorage (survive page reloads)
 * - Message rendering with read receipts
 * - Online users list updates
 * - Automatic reconnection handling
 */

// ============================================================================
// CONFIGURATION AND STATE
// ============================================================================

// Session storage keys
const STORAGE_KEY_USERNAME = 'chatroom_username';
const STORAGE_KEY_ROOM = 'chatroom_room';
const STORAGE_KEY_SESSION = 'chatroom_session_active';

// Current user state
let currentUsername = null;
let currentRoom = null;
let socket = null;

// Track unread messages for read receipts
let unreadMessageIds = [];

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const loginScreen = document.getElementById('login-screen');
const chatScreen = document.getElementById('chat-screen');
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username');
const roomInput = document.getElementById('room');
const roomNameDisplay = document.getElementById('room-name');
const roomUserCount = document.getElementById('room-user-count');
const leaveBtn = document.getElementById('leave-btn');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const messagesContainer = document.getElementById('messages');
const roomUsersList = document.getElementById('room-users-list');
const globalUsersList = document.getElementById('global-users-list');
const errorToast = document.getElementById('error-toast');
const errorMessage = document.getElementById('error-message');

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the application on page load.
 * Check for existing session and reconnect if found.
 */
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Socket.IO connection
    initSocket();
    
    // Check for existing session (page reload scenario)
    const savedUsername = localStorage.getItem(STORAGE_KEY_USERNAME);
    const savedRoom = localStorage.getItem(STORAGE_KEY_ROOM);
    const sessionActive = localStorage.getItem(STORAGE_KEY_SESSION);
    
    if (savedUsername && savedRoom && sessionActive === 'true') {
        // Reconnect to previous session
        usernameInput.value = savedUsername;
        roomInput.value = savedRoom;
        joinRoom(savedUsername, savedRoom);
    }
    
    // Setup event listeners
    setupEventListeners();
});

/**
 * Initialize Socket.IO connection with event handlers.
 */
function initSocket() {
    socket = io({
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    });
    
    // Connection events
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    
    // Room events
    socket.on('room_joined', handleRoomJoined);
    socket.on('left_room', handleLeftRoom);
    socket.on('error', handleError);
    
    // Message events
    socket.on('new_message', handleNewMessage);
    socket.on('read_receipts_updated', handleReadReceiptsUpdated);
    
    // User presence events
    socket.on('user_joined', handleUserJoined);
    socket.on('user_left', handleUserLeft);
    socket.on('online_users_update', handleOnlineUsersUpdate);
}

/**
 * Setup DOM event listeners.
 */
function setupEventListeners() {
    // Login form submission
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = usernameInput.value.trim();
        const room = roomInput.value.trim();
        
        if (username && room) {
            joinRoom(username, room);
        }
    });
    
    // Leave room button
    leaveBtn.addEventListener('click', () => {
        leaveRoom();
    });
    
    // Message form submission
    messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        sendMessage();
    });
    
    // Mark messages as read when scrolling/viewing
    messagesContainer.addEventListener('scroll', markVisibleMessagesAsRead);
    
    // Mark messages as read when window gains focus
    window.addEventListener('focus', markVisibleMessagesAsRead);
}

// ============================================================================
// SOCKET EVENT HANDLERS
// ============================================================================

/**
 * Handle successful socket connection.
 * Rejoin room if we have an active session.
 */
function handleConnect() {
    console.log('Connected to server');
    
    // If we have an active session, rejoin the room
    if (currentUsername && currentRoom) {
        socket.emit('join', {
            username: currentUsername,
            room: currentRoom
        });
    }
}

/**
 * Handle socket disconnection.
 */
function handleDisconnect(reason) {
    console.log('Disconnected:', reason);
    
    // Don't clear session - we want to rejoin on reconnect
    // The session is only cleared on explicit leave
}

/**
 * Handle connection errors.
 */
function handleConnectError(error) {
    console.error('Connection error:', error);
    showError('Connection failed. Retrying...');
}

/**
 * Handle successful room join.
 * Receives room state including message history.
 */
function handleRoomJoined(data) {
    console.log('Joined room:', data);
    
    // Update current state
    currentUsername = data.username;
    currentRoom = data.room;
    
    // Save session to localStorage
    localStorage.setItem(STORAGE_KEY_USERNAME, currentUsername);
    localStorage.setItem(STORAGE_KEY_ROOM, currentRoom);
    localStorage.setItem(STORAGE_KEY_SESSION, 'true');
    
    // Update UI
    showChatScreen();
    roomNameDisplay.textContent = `Room: ${data.room}`;
    
    // Clear and render message history
    messagesContainer.innerHTML = '';
    data.messages.forEach(msg => renderMessage(msg));
    
    // Update online users lists
    updateRoomUsers(data.room_users);
    updateGlobalUsers(data.global_online);
    
    // Scroll to bottom
    scrollToBottom();
    
    // Mark visible messages as read
    setTimeout(markVisibleMessagesAsRead, 100);
}

/**
 * Handle leaving room confirmation.
 */
function handleLeftRoom(data) {
    console.log('Left room:', data.room);
    
    // Clear session
    clearSession();
    
    // Show login screen
    showLoginScreen();
}

/**
 * Handle server errors.
 */
function handleError(data) {
    console.error('Server error:', data.message);
    showError(data.message);
}

/**
 * Handle new incoming message.
 */
function handleNewMessage(message) {
    console.log('New message:', message);
    
    // Render the message
    renderMessage(message);
    
    // Scroll to bottom
    scrollToBottom();
    
    // Add to unread if not from current user
    if (message.username !== currentUsername) {
        unreadMessageIds.push(message.id);
        
        // Mark as read if page is visible
        if (document.hasFocus()) {
            markVisibleMessagesAsRead();
        }
    }
}

/**
 * Handle read receipts update.
 * Updates the read_by list for specific messages.
 */
function handleReadReceiptsUpdated(data) {
    console.log('Read receipts updated:', data);
    
    data.updates.forEach(update => {
        const messageEl = document.querySelector(`[data-message-id="${update.message_id}"]`);
        if (messageEl) {
            updateMessageReadReceipts(messageEl, update.read_by);
        }
    });
}

/**
 * Handle new user joining the room.
 */
function handleUserJoined(data) {
    console.log('User joined:', data.username);
    
    // Add system message
    addSystemMessage(`${data.username} joined the room`);
    
    // Update online users lists
    updateRoomUsers(data.room_users);
    updateGlobalUsers(data.global_online);
}

/**
 * Handle user leaving the room.
 */
function handleUserLeft(data) {
    console.log('User left:', data.username);
    
    // Add system message
    addSystemMessage(`${data.username} left the room`);
    
    // Update online users lists
    updateRoomUsers(data.room_users);
    updateGlobalUsers(data.global_online);
}

/**
 * Handle online users update.
 */
function handleOnlineUsersUpdate(data) {
    updateRoomUsers(data.room_users);
    updateGlobalUsers(data.global_online);
}

// ============================================================================
// ROOM ACTIONS
// ============================================================================

/**
 * Join a chat room.
 */
function joinRoom(username, room) {
    currentUsername = username;
    currentRoom = room;
    
    socket.emit('join', {
        username: username,
        room: room
    });
}

/**
 * Leave the current room (explicit action).
 */
function leaveRoom() {
    if (currentRoom) {
        socket.emit('leave', { room: currentRoom });
    }
}

/**
 * Clear the session data.
 */
function clearSession() {
    currentUsername = null;
    currentRoom = null;
    unreadMessageIds = [];
    
    localStorage.removeItem(STORAGE_KEY_USERNAME);
    localStorage.removeItem(STORAGE_KEY_ROOM);
    localStorage.removeItem(STORAGE_KEY_SESSION);
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

/**
 * Send a new message.
 */
function sendMessage() {
    const content = messageInput.value.trim();
    
    if (content && socket.connected) {
        socket.emit('send_message', { content: content });
        messageInput.value = '';
        messageInput.focus();
    }
}

/**
 * Render a message in the chat area.
 */
function renderMessage(message) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${message.username === currentUsername ? 'own' : 'other'}`;
    messageEl.dataset.messageId = message.id;
    
    // Format timestamp
    const time = formatTimestamp(message.timestamp);
    
    // Build read receipts display
    const readByOthers = message.read_by.filter(u => u !== message.username);
    const isSeen = readByOthers.length > 0;
    
    messageEl.innerHTML = `
        <div class="message-header">
            <span class="message-sender">${escapeHtml(message.username)}</span>
            <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${escapeHtml(message.content)}</div>
        <div class="message-receipts ${isSeen ? 'seen' : ''}">
            ${buildReadReceiptHtml(message.read_by, message.username)}
        </div>
    `;
    
    messagesContainer.appendChild(messageEl);
}

/**
 * Update read receipts display for a message.
 */
function updateMessageReadReceipts(messageEl, readBy) {
    const receiptsEl = messageEl.querySelector('.message-receipts');
    if (receiptsEl) {
        // Get the message sender from the element
        const sender = messageEl.querySelector('.message-sender').textContent;
        const readByOthers = readBy.filter(u => u !== sender);
        
        receiptsEl.className = `message-receipts ${readByOthers.length > 0 ? 'seen' : ''}`;
        receiptsEl.innerHTML = buildReadReceiptHtml(readBy, sender);
    }
}

/**
 * Build HTML for read receipts.
 * Shows "Seen by X, Y, Z" if others have read the message.
 */
function buildReadReceiptHtml(readBy, sender) {
    // Filter out the sender
    const readers = readBy.filter(u => u !== sender);
    
    if (readers.length === 0) {
        return '<span class="receipt-icon">○</span> <span class="receipt-users">Sent</span>';
    }
    
    // Show checkmark and who has seen it
    const readersList = readers.length <= 3 
        ? readers.join(', ')
        : `${readers.slice(0, 2).join(', ')} +${readers.length - 2} more`;
    
    return `<span class="receipt-icon">✓</span> <span class="receipt-users">Seen by ${readersList}</span>`;
}

/**
 * Add a system message (join/leave notifications).
 */
function addSystemMessage(text) {
    const systemEl = document.createElement('div');
    systemEl.className = 'system-message';
    systemEl.textContent = text;
    messagesContainer.appendChild(systemEl);
    scrollToBottom();
}

/**
 * Mark visible messages as read.
 * Called when scrolling or when window gains focus.
 */
function markVisibleMessagesAsRead() {
    if (unreadMessageIds.length === 0) return;
    
    // Get all unread message elements
    const messageIds = [...unreadMessageIds];
    
    if (messageIds.length > 0) {
        socket.emit('mark_read', { message_ids: messageIds });
        unreadMessageIds = [];
    }
}

// ============================================================================
// ONLINE USERS MANAGEMENT
// ============================================================================

/**
 * Update the room users list.
 */
function updateRoomUsers(users) {
    roomUsersList.innerHTML = '';
    roomUserCount.textContent = `${users.length} user${users.length !== 1 ? 's' : ''} online`;
    
    users.forEach(username => {
        const li = document.createElement('li');
        li.textContent = username;
        if (username === currentUsername) {
            li.className = 'current-user';
            li.textContent += ' (you)';
        }
        roomUsersList.appendChild(li);
    });
}

/**
 * Update the global online users list.
 */
function updateGlobalUsers(users) {
    globalUsersList.innerHTML = '';
    
    users.forEach(username => {
        const li = document.createElement('li');
        li.textContent = username;
        if (username === currentUsername) {
            li.className = 'current-user';
        }
        globalUsersList.appendChild(li);
    });
}

// ============================================================================
// UI HELPERS
// ============================================================================

/**
 * Show the chat screen, hide login.
 */
function showChatScreen() {
    loginScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    messageInput.focus();
}

/**
 * Show the login screen, hide chat.
 */
function showLoginScreen() {
    chatScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    messagesContainer.innerHTML = '';
    usernameInput.focus();
}

/**
 * Scroll messages to bottom.
 */
function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

/**
 * Show an error toast.
 */
function showError(message) {
    errorMessage.textContent = message;
    errorToast.classList.remove('hidden');
    
    // Auto-hide after 5 seconds
    setTimeout(hideError, 5000);
}

/**
 * Hide the error toast.
 */
function hideError() {
    errorToast.classList.add('hidden');
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format a timestamp for display.
 */
function formatTimestamp(timestamp) {
    const date = new Date(timestamp + ' UTC');
    const now = new Date();
    
    // If today, show time only
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    // Otherwise show date and time
    return date.toLocaleDateString([], { 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Expose hideError globally for inline onclick
window.hideError = hideError;
