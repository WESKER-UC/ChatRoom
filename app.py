from flask import Flask, render_template, request
from flask_socketio import SocketIO, join_room, leave_room, emit
import sqlite3
from datetime import datetime
import re

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-here'
socketio = SocketIO(app, cors_allowed_origins="*")

# ---------- DB SETUP ----------
def init_db():
    conn = sqlite3.connect("chat.db")
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room TEXT,
            name TEXT,
            message TEXT,
            timestamp TEXT
        )
    """)
    conn.commit()
    conn.close()

init_db()

# ---------- ROUTES ----------
@app.route("/")
def index():
    return render_template("index.html")

# ---------- SOCKET EVENTS ----------
@socketio.on("join")
def handle_join(data):
    name = data.get("name", "").strip()
    room = data.get("room", "").strip()

    if not name or not room:
        emit("error", {"msg": "Name and room are required"})
        return

    if len(name) > 20 or len(room) > 20:
        emit("error", {"msg": "Name and room must be under 20 characters"})
        return

    if not re.match("^[a-zA-Z0-9_]*$", name) or not re.match("^[a-zA-Z0-9_]*$", room):
        emit("error", {"msg": "Only letters, numbers and underscores allowed"})
        return

    join_room(room)
    emit("status", f"{name} joined the room.", room=room)

    # Send last 50 messages to this user only
    conn = sqlite3.connect("chat.db")
    c = conn.cursor()
    c.execute("""
        SELECT name, message, timestamp 
        FROM messages 
        WHERE room=? 
        ORDER BY id DESC LIMIT 50
    """, (room,))
    rows = c.fetchall()
    conn.close()

    for row in reversed(rows):
        emit("message", {
            "name": row[0],
            "message": row[1],
            "time": row[2]
        })

@socketio.on("message")
def handle_message(data):
    name = data.get("name", "").strip()
    room = data.get("room", "").strip()
    msg = data.get("message", "").strip()

    if not name or not room or not msg:
        emit("error", {"msg": "All fields are required"})
        return

    if len(msg) > 500:
        emit("error", {"msg": "Message too long (max 500 chars)"})
        return

    time = datetime.now().strftime("%H:%M")

    conn = sqlite3.connect("chat.db")
    c = conn.cursor()
    c.execute("""
        INSERT INTO messages (room, name, message, timestamp)
        VALUES (?, ?, ?, ?)
    """, (room, name, msg, time))
    conn.commit()
    conn.close()

    emit("message", {
        "name": name,
        "message": msg,
        "time": time
    }, room=room)

@socketio.on("leave")
def handle_leave(data):
    name = data.get("name")
    room = data.get("room")
    leave_room(room)
    emit("status", f"{name} left the room.", room=room)

@socketio.on("disconnect")
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")

if __name__ == "__main__":
    socketio.run(app, debug=True)
