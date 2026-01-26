const socket = io();
let currentUser = null;
let currentRoom = null;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('login-form').addEventListener('submit', (e) => {
        e.preventDefault();
        joinRoom();
    });

    document.getElementById('send-btn').addEventListener('click', sendMessage);

    document.getElementById('message-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    document.getElementById('leave-btn').addEventListener('click', () => {
        socket.emit('leave', {
            name: currentUser,
            room: currentRoom
        });
        showLoginScreen();
    });

    socket.on('message', (data) => {
        const isOwn = data.name === currentUser;
        addMessageToChat(data.name, data.message, data.time, isOwn);
    });

    socket.on('status', (msg) => {
        addStatusMessage(msg);
    });

    socket.on('error', (data) => {
        showError(data.msg);
    });
});

function joinRoom() {
    const name = document.getElementById('name').value.trim();
    const room = document.getElementById('room').value.trim();

    if (!name || !room) {
        showError('Please enter both name and room');
        return;
    }

    currentUser = name;
    currentRoom = room;

    socket.emit('join', { name, room });

    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('chat-screen').classList.add('active');
    document.getElementById('room-name').innerText = `Room: ${room}`;
}

function sendMessage() {
    const input = document.getElementById('message-input');
    const message = input.value.trim();
    if (!message) return;

    socket.emit('message', {
        name: currentUser,
        room: currentRoom,
        message: message
    });

    input.value = '';
}

function addMessageToChat(sender, message, time, isOwn) {
    const messages = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = `message ${isOwn ? 'own' : 'other'}`;

    div.innerHTML = `
        <span class="sender">${escapeHtml(sender)}</span>
        <span class="timestamp">${time}</span>
        <div class="content">${escapeHtml(message)}</div>
    `;

    messages.appendChild(div);
    scrollToBottom();
}

function addStatusMessage(text) {
    const messages = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'status-message';
    div.textContent = text;
    messages.appendChild(div);
    scrollToBottom();
}

function showError(message) {
    const errorDiv = document.getElementById('login-error');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    setTimeout(() => errorDiv.style.display = 'none', 5000);
}

function showLoginScreen() {
    document.getElementById('login-screen').classList.add('active');
    document.getElementById('chat-screen').classList.remove('active');
    document.getElementById('messages').innerHTML = '';
    currentUser = null;
    currentRoom = null;
}

function scrollToBottom() {
    const container = document.getElementById('messages-container');
    container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
