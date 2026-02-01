"""
Flask-SocketIO Real-Time Chatroom Application

This application implements a real-time chatroom with:
- Multiple rooms with automatic creation/joining
- Read receipts showing which users have seen each message
- Live online presence tracking (global and per-room)
- Session persistence (users stay in room after page reload)
- Graceful disconnect handling with grace period

Author: Replit Agent
"""

import os
from datetime import datetime
from threading import Timer
from flask import Flask, render_template, request, session
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_sqlalchemy import SQLAlchemy

# Initialize Flask app
app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SESSION_SECRET', 'dev-secret-key')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chatroom.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Initialize extensions
db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Grace period in seconds for reconnection (allows page reload without showing as offline)
DISCONNECT_GRACE_PERIOD = 5

# ============================================================================
# DATABASE MODELS
# ============================================================================

class Message(db.Model):
    """
    Stores chat messages with sender info and timestamp.
    Each message belongs to a specific room.
    """
    id = db.Column(db.Integer, primary_key=True)
    room = db.Column(db.String(100), nullable=False, index=True)
    username = db.Column(db.String(50), nullable=False)
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Relationship to read receipts
    read_receipts = db.relationship('ReadReceipt', backref='message', lazy='dynamic',
                                    cascade='all, delete-orphan')
    
    def to_dict(self):
        """Convert message to dictionary for JSON serialization."""
        return {
            'id': self.id,
            'room': self.room,
            'username': self.username,
            'content': self.content,
            'timestamp': self.timestamp.strftime('%Y-%m-%d %H:%M:%S'),
            'read_by': [r.username for r in self.read_receipts.all()]
        }


class ReadReceipt(db.Model):
    """
    Tracks which users have read each message.
    One record per user per message.
    """
    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey('message.id'), nullable=False)
    username = db.Column(db.String(50), nullable=False)
    read_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Ensure unique constraint: one user can only have one read receipt per message
    __table_args__ = (db.UniqueConstraint('message_id', 'username', name='unique_read_receipt'),)


# ============================================================================
# ONLINE PRESENCE TRACKING WITH GRACE PERIOD
# ============================================================================

# Track online users: {sid: {'username': str, 'room': str}}
online_users = {}

# Track users by room: {room: set(usernames)}
room_users = {}

# Track all online usernames globally
global_online = set()

# Track pending disconnects for grace period: {(username, room): {'timer': Timer, 'sid': str}}
pending_disconnects = {}

# Track explicit leaves to distinguish from page reloads
explicit_leaves = set()  # set of sids that clicked "Leave"


def get_room_users(room):
    """Get list of users in a specific room."""
    return list(room_users.get(room, set()))


def get_global_online():
    """Get list of all online users globally."""
    return list(global_online)


def add_user_to_room(sid, username, room):
    """
    Add a user to tracking when they join a room.
    Updates both global and room-specific tracking.
    Cancels any pending disconnect for this user.
    """
    # Cancel any pending disconnect for this user/room combo
    pending_key = (username, room)
    if pending_key in pending_disconnects:
        pending_disconnects[pending_key]['timer'].cancel()
        del pending_disconnects[pending_key]
    
    online_users[sid] = {'username': username, 'room': room}
    
    # Add to room users
    if room not in room_users:
        room_users[room] = set()
    room_users[room].add(username)
    
    # Add to global online
    global_online.add(username)


def remove_user_immediately(username, room):
    """
    Actually remove a user from tracking after grace period expires.
    Called by the timer when grace period ends without reconnection.
    """
    pending_key = (username, room)
    
    # Clean up pending disconnect entry
    if pending_key in pending_disconnects:
        del pending_disconnects[pending_key]
    
    # Remove from room users
    if room in room_users:
        room_users[room].discard(username)
        if not room_users[room]:
            del room_users[room]
    
    # Check if user has other sessions before removing from global
    still_online = any(u['username'] == username for u in online_users.values())
    if not still_online:
        global_online.discard(username)
    
    # Notify room that user left (using socketio.emit since we're in a timer callback)
    socketio.emit('user_left', {
        'username': username,
        'room_users': get_room_users(room),
        'global_online': get_global_online()
    }, room=room)
    
    print(f'User {username} removed from room {room} after grace period')


def schedule_user_removal(sid, username, room):
    """
    Schedule user removal after grace period.
    This allows time for the user to reconnect (e.g., after page reload).
    """
    pending_key = (username, room)
    
    # Cancel any existing timer for this user/room
    if pending_key in pending_disconnects:
        pending_disconnects[pending_key]['timer'].cancel()
    
    # Schedule removal after grace period
    timer = Timer(DISCONNECT_GRACE_PERIOD, remove_user_immediately, args=[username, room])
    timer.daemon = True
    timer.start()
    
    pending_disconnects[pending_key] = {'timer': timer, 'sid': sid}
    print(f'Scheduled removal for {username} in {room} after {DISCONNECT_GRACE_PERIOD}s grace period')


def remove_user_from_tracking(sid, immediate=False):
    """
    Remove a user from socket tracking.
    If immediate=True (explicit leave), remove immediately.
    If immediate=False (disconnect), schedule removal with grace period.
    Returns the user info if found, None otherwise.
    """
    if sid not in online_users:
        return None
    
    user_info = online_users.pop(sid)
    username = user_info['username']
    room = user_info['room']
    
    if immediate:
        # Explicit leave - remove immediately
        # Remove from room users
        if room in room_users:
            room_users[room].discard(username)
            if not room_users[room]:
                del room_users[room]
        
        # Check if user has other sessions before removing from global
        still_online = any(u['username'] == username for u in online_users.values())
        if not still_online:
            global_online.discard(username)
        
        # Cancel any pending disconnect timer
        pending_key = (username, room)
        if pending_key in pending_disconnects:
            pending_disconnects[pending_key]['timer'].cancel()
            del pending_disconnects[pending_key]
    else:
        # Check if user still has another active session in the same room
        still_in_room = any(
            u['username'] == username and u['room'] == room 
            for u in online_users.values()
        )
        
        if not still_in_room:
            # Schedule removal with grace period (allows reconnect)
            schedule_user_removal(sid, username, room)
    
    return user_info


# ============================================================================
# FLASK ROUTES
# ============================================================================

@app.route('/')
def index():
    """Serve the main chat application page."""
    return render_template('index.html')


# ============================================================================
# SOCKET.IO EVENT HANDLERS
# ============================================================================

@socketio.on('connect')
def handle_connect():
    """
    Handle new socket connection.
    Client will send 'join' event separately with username and room.
    """
    print(f'Client connected: {request.sid}')


@socketio.on('disconnect')
def handle_disconnect():
    """
    Handle socket disconnection.
    
    Uses grace period approach:
    - If user clicked "Leave", they are removed immediately
    - Otherwise (page reload/network issue), we wait for grace period
      before announcing them as left, allowing time to reconnect
    """
    sid = request.sid
    
    # Check if this was an explicit leave
    if sid in explicit_leaves:
        explicit_leaves.discard(sid)
        # Already handled in handle_leave
        return
    
    # Get user info before removal
    user_info = online_users.get(sid)
    if user_info:
        username = user_info['username']
        room = user_info['room']
        
        # Remove from socket tracking but schedule grace period before announcing
        remove_user_from_tracking(sid, immediate=False)
        
        print(f'User {username} disconnected from room {room} (grace period started)')


@socketio.on('join')
def handle_join(data):
    """
    Handle user joining a room.
    
    Args:
        data: {username: str, room: str}
    
    Creates room if it doesn't exist.
    Loads message history and notifies other users.
    Cancels any pending disconnect timer for reconnecting users.
    """
    username = data.get('username', '').strip()
    room = data.get('room', '').strip()
    
    if not username or not room:
        emit('error', {'message': 'Username and room are required'})
        return
    
    # Check if this user is reconnecting (has a pending disconnect)
    pending_key = (username, room)
    is_reconnecting = pending_key in pending_disconnects
    
    # Check for duplicate username in room (different user, not reconnecting self)
    if room in room_users and username in room_users[room] and not is_reconnecting:
        # Check if it's actually a different active session
        for sid, info in online_users.items():
            if info['username'] == username and info['room'] == room and sid != request.sid:
                emit('error', {'message': f'Username "{username}" is already taken in this room'})
                return
    
    # Determine if we should notify others about join
    # (Don't notify if user is reconnecting within grace period)
    should_notify_join = not is_reconnecting
    
    # Join the Socket.IO room
    join_room(room)
    
    # Add user to tracking (this also cancels pending disconnect if any)
    add_user_to_room(request.sid, username, room)
    
    # Load message history for this room
    messages = Message.query.filter_by(room=room).order_by(Message.timestamp.asc()).all()
    message_history = [msg.to_dict() for msg in messages]
    
    # Send room state to the joining user
    emit('room_joined', {
        'room': room,
        'username': username,
        'messages': message_history,
        'room_users': get_room_users(room),
        'global_online': get_global_online()
    })
    
    # Notify other users in the room (only if not a reconnect)
    if should_notify_join:
        emit('user_joined', {
            'username': username,
            'room_users': get_room_users(room),
            'global_online': get_global_online()
        }, room=room, include_self=False)
    
    print(f'User {username} {"reconnected to" if is_reconnecting else "joined"} room {room}')


@socketio.on('leave')
def handle_leave(data):
    """
    Handle explicit user leave (clicking Leave button).
    This is different from disconnect - it's intentional and immediate.
    No grace period for explicit leaves.
    """
    sid = request.sid
    
    # Mark this as an explicit leave so disconnect handler doesn't double-process
    explicit_leaves.add(sid)
    
    user_info = remove_user_from_tracking(sid, immediate=True)
    
    if user_info:
        room = user_info['room']
        username = user_info['username']
        
        # Leave the Socket.IO room
        leave_room(room)
        
        # Notify room that user left
        emit('user_left', {
            'username': username,
            'room_users': get_room_users(room),
            'global_online': get_global_online()
        }, room=room)
        
        # Confirm leave to the user
        emit('left_room', {'room': room})
        
        print(f'User {username} explicitly left room {room}')


@socketio.on('send_message')
def handle_message(data):
    """
    Handle incoming chat message.
    
    Args:
        data: {content: str}
    
    Saves message to database and broadcasts to room.
    The sender automatically gets a read receipt.
    """
    content = data.get('content', '').strip()
    
    if not content:
        return
    
    # Get user info
    user_info = online_users.get(request.sid)
    if not user_info:
        emit('error', {'message': 'You are not in a room'})
        return
    
    username = user_info['username']
    room = user_info['room']
    
    # Save message to database
    message = Message(room=room, username=username, content=content)
    db.session.add(message)
    db.session.commit()
    
    # Auto-add read receipt for sender
    read_receipt = ReadReceipt(message_id=message.id, username=username)
    db.session.add(read_receipt)
    db.session.commit()
    
    # Broadcast message to room
    emit('new_message', message.to_dict(), room=room)
    
    print(f'Message from {username} in {room}: {content[:50]}...')


@socketio.on('mark_read')
def handle_mark_read(data):
    """
    Handle read receipt - mark messages as read by user.
    
    Args:
        data: {message_ids: list[int]}
    
    Creates read receipts and broadcasts updates to room.
    """
    message_ids = data.get('message_ids', [])
    
    if not message_ids:
        return
    
    user_info = online_users.get(request.sid)
    if not user_info:
        return
    
    username = user_info['username']
    room = user_info['room']
    
    updated_messages = []
    
    for msg_id in message_ids:
        # Check if message exists and is in the user's room
        message = Message.query.filter_by(id=msg_id, room=room).first()
        if not message:
            continue
        
        # Check if already read by this user
        existing = ReadReceipt.query.filter_by(
            message_id=msg_id, 
            username=username
        ).first()
        
        if not existing:
            # Create read receipt
            read_receipt = ReadReceipt(message_id=msg_id, username=username)
            db.session.add(read_receipt)
            updated_messages.append(msg_id)
    
    if updated_messages:
        db.session.commit()
        
        # Broadcast read receipt updates to room
        # Get updated read_by lists for affected messages
        updates = []
        for msg_id in updated_messages:
            message = Message.query.get(msg_id)
            if message:
                updates.append({
                    'message_id': msg_id,
                    'read_by': [r.username for r in message.read_receipts.all()]
                })
        
        emit('read_receipts_updated', {
            'updates': updates,
            'reader': username
        }, room=room)


@socketio.on('get_online_users')
def handle_get_online_users():
    """
    Handle request for current online users.
    Used when client needs to refresh the online list.
    """
    user_info = online_users.get(request.sid)
    if user_info:
        emit('online_users_update', {
            'room_users': get_room_users(user_info['room']),
            'global_online': get_global_online()
        })


# ============================================================================
# APPLICATION STARTUP
# ============================================================================

# Create database tables
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    # Run with eventlet for WebSocket support
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
