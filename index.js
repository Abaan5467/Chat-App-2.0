const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
app.use(cors());

mongoose.connect("mongodb://localhost:27017/chat-app", { useNewUrlParser: true, useUnifiedTopology: true });

const schema = new mongoose.Schema({
    senderName: { type: String, required: true },
    senderID: { type: String, required: true },
    timestamp: { type: String, required: true },
    room: { type: String, required: true },
    message: { type: String, required: true },
    displayName: { type: String }
});

const schema2 = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    displayName: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});

const log = mongoose.model('log', schema, 'logs');
const user = mongoose.model('user', schema2, 'users');

const PORT = process.env.PORT || 3000;

let displaynames = [];
let loggedInUsers = [];
let socketToUser = {};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/app/:username', (req, res) => {
    if (!loggedInUsers.includes(req.params.username)) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));

app.get('/api/logs', (req, res) => log.find().then(logs => res.json(logs)).catch(() => res.status(500).json({ error: 'Failed to fetch logs' })));

app.post('/api/signup', express.json(), (req, res) => {
    const { username, displayName, password } = req.body;
    const newUser = new user({ username, displayName, password });
    newUser.save().then(() => res.status(201).json({ message: 'User created' })).catch(() => res.status(500).json({ error: 'Failed to create user' }));
});

app.post('/api/get-displayname', express.json(), (req, res) => {
    const { username } = req.body;
    user.find({ username }).then(users => {
        if (users.length > 0) res.status(200).json({ displayName: users[0].displayName, success: true });
        else res.status(404).json({ error: 'User not found' });
    }).catch(() => res.status(500).json({ error: 'Failed to fetch display name' }));
});

app.post('/api/login', express.json(), (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const { username, password } = req.body;
    user.find({ username, password }).then(users => {
        if (users.length > 0 && !loggedInUsers.includes(username)) {
            res.status(201).json({ success: true });
            if (!loggedInUsers.includes(username)) loggedInUsers.push(username);
            if (!displaynames.includes(users[0].displayName)) displaynames.push(users[0].displayName);
            io.emit('userslist', displaynames);
        } else res.status(401).json({ success: false });
    }).catch(() => res.status(500).json({ error: 'Login failed' }));
});

io.on("connection", (socket) => {
    let currentRoom = "general";
    socket.join(currentRoom);

    socket.on("register", ({ username, displayName }) => {
        socketToUser[socket.id] = { username, displayName };
        if (!displaynames.includes(displayName)) displaynames.push(displayName);
        if (!loggedInUsers.includes(username)) loggedInUsers.push(username);
        io.emit("userslist", displaynames);
    });


    socket.on("joinRoom", (room) => {
        socket.leave(currentRoom);
        currentRoom = room;
        socket.join(currentRoom);
    });

    socket.on("typing", (data) => {
        io.emit("typing", data);
    });

    socket.on("stopTyping", (data) => {
        io.emit("stopTyping", data);
    });


    socket.on("message", (msg) => {
        io.to(currentRoom).emit("message", msg);
        const { room, text, timestamp, sender, name, displayName } = msg;
        const message = new log({
            senderName: name,
            senderID: sender,
            timestamp,
            room,
            message: text,
            displayName
        });
        message.save().catch(() => { });
    });

    socket.on("disconnect", () => {
        const userData = socketToUser[socket.id];
        if (userData) {
            const { username, displayName } = userData;
            displaynames = displaynames.filter(name => name !== displayName);
            loggedInUsers = loggedInUsers.filter(u => u !== username);
            delete socketToUser[socket.id];
            io.emit("userslist", displaynames);
        }
    });

    io.emit("userslist", displaynames);
});


server.listen(PORT);