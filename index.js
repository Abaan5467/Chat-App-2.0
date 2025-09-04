const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
app.use(cors());

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chat-app";

mongoose.connect(mongoUri).catch(err => {
    console.log('MongoDB connection failed, running in memory mode:', err.message);
    console.log('Chat will work but messages will not persist between restarts');
});

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

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

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

app.post('/api/logout', express.json(), (req, res) => {
    const { username } = req.body;
    loggedInUsers = loggedInUsers.filter(u => u !== username);
    if (mongoose.connection.readyState === 1) {
        user.findOne({ username }).then(foundUser => {
            if (foundUser) {
                displaynames = displaynames.filter(name => name !== foundUser.displayName);
                io.emit('userslist', displaynames);
            }
        });
    } else {
        displaynames = displaynames.filter(name => name !== username);
        io.emit('userslist', displaynames);
    }
    res.status(200).json({ success: true });
});

app.get('/api/logs', (req, res) => {
    if (mongoose.connection.readyState !== 1) {
        return res.json([]);
    }
    log.find().then(logs => res.json(logs)).catch(() => res.status(500).json({ error: 'Failed to fetch logs' }));
});

app.post('/api/signup', express.json(), async (req, res) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(201).json({ message: 'User created (memory mode)' });
    }
    try {
        const { username, displayName, password } = req.body;
        
        const existingUser = await user.findOne({ $or: [{ username }, { displayName }] });
        if (existingUser) {
            return res.status(400).json({ error: 'Username or display name already exists' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = new user({ username, displayName, password: hashedPassword });
        await newUser.save();
        res.status(201).json({ message: 'User created successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create user' });
    }
});

app.post('/api/get-displayname', express.json(), (req, res) => {
    if (mongoose.connection.readyState !== 1) {
        const { username } = req.body;
        return res.status(200).json({ displayName: username, success: true });
    }
    const { username } = req.body;
    user.find({ username }).then(users => {
        if (users.length > 0) res.status(200).json({ displayName: users[0].displayName, success: true });
        else res.status(404).json({ error: 'User not found' });
    }).catch(() => res.status(500).json({ error: 'Failed to fetch display name' }));
});

app.post('/api/login', express.json(), async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const { username, password } = req.body;
    
    if (mongoose.connection.readyState !== 1) {
        if (username && password) {
            res.status(201).json({ success: true });
            if (!loggedInUsers.includes(username)) loggedInUsers.push(username);
            if (!displaynames.includes(username)) displaynames.push(username);
            io.emit('userslist', displaynames);
        } else {
            res.status(401).json({ success: false });
        }
        return;
    }
    
    try {
        const foundUser = await user.findOne({ username });
        
        if (foundUser) {
            const passwordMatch = await bcrypt.compare(password, foundUser.password);
            
            if (passwordMatch) {
                res.status(201).json({ success: true });
                if (!loggedInUsers.includes(username)) loggedInUsers.push(username);
                if (!displaynames.includes(foundUser.displayName)) displaynames.push(foundUser.displayName);
                io.emit('userslist', displaynames);
            } else {
                res.status(401).json({ success: false, error: 'Invalid credentials' });
            }
        } else {
            res.status(401).json({ success: false, error: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Login failed' });
    }
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
        if (mongoose.connection.readyState === 1) {
            message.save().catch(() => { });
        }
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


server.listen(PORT, HOST, () => {
    console.log(`Chat app running on http://${HOST}:${PORT}`);
});
