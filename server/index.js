const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const { initDatabase } = require('./db');
const authRoutes = require('./routes/auth');
const fileRoutes = require('./routes/files');
const shareRoutes = require('./routes/share');
const codespaceShareRoutes = require('./routes/codespaceShare');
const projectRoutes = require('./routes/projects');
const githubRoutes = require('./routes/github');
const documentRoutes = require('./routes/documents');
const codeRoutes = require('./routes/code');
const userRoutes = require('./routes/users');

const app = express();
const server = createServer(app);

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Security middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Middleware
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/codespace/share', codespaceShareRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/code', codeRoutes);
app.use('/api/users', userRoutes);

// Socket.IO authentication middleware
const jwt = require('jsonwebtoken');
const fs = require('fs');

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    const publicKey = fs.readFileSync(process.env.PUBLIC_KEY_PATH, 'utf8');
    const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
    
    socket.user = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name
    };
    
    console.log('✅ Socket authenticated for user:', socket.user.email);
    next();
  } catch (error) {
    console.error('❌ Socket authentication failed:', error.message);
    next(new Error('Authentication error'));
  }
});

// Socket.IO connection handling
const activeUsers = new Map(); // documentId -> Set of users
const userSockets = new Map(); // userId -> socket

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.user.email, 'Socket ID:', socket.id);
  
  userSockets.set(socket.user.id, socket);

  socket.on('join-document', (documentId) => {
    console.log('🏠 User joining document:', socket.user.email, 'Document:', documentId);
    
    // Leave previous rooms
    Array.from(socket.rooms).forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
        // Remove from active users of previous document
        if (activeUsers.has(room)) {
          const users = activeUsers.get(room);
          users.delete(socket.user.id);
          if (users.size === 0) {
            activeUsers.delete(room);
          } else {
            // Notify others in the room that user left
            socket.to(room).emit('user-left', { userId: socket.user.id });
            socket.to(room).emit('active-users', Array.from(users.values()));
          }
        }
      }
    });

    // Join new document room
    socket.join(documentId);
    
    // Add to active users
    if (!activeUsers.has(documentId)) {
      activeUsers.set(documentId, new Map());
    }
    
    const documentUsers = activeUsers.get(documentId);
    documentUsers.set(socket.user.id, socket.user);
    
    // Notify all users in the document about the updated user list
    const userList = Array.from(documentUsers.values());
    io.to(documentId).emit('active-users', userList);
    
    // Notify others that a new user joined
    socket.to(documentId).emit('user-joined', { user: socket.user });
    
    console.log('👥 Active users in document', documentId, ':', userList.map(u => u.email));
  });

  socket.on('document-change', (data) => {
    console.log('📝 Document change from:', socket.user.email, 'Data:', data);
    
    // Broadcast to all other users in the same document
    if (data.documentId) {
      socket.to(data.documentId).emit('document-change', {
        ...data,
        userId: socket.user.id,
        userEmail: socket.user.email,
        timestamp: Date.now()
      });
    }
  });

  socket.on('cursor-position', (data) => {
    if (data.documentId) {
      socket.to(data.documentId).emit('cursor-position', {
        ...data,
        userId: socket.user.id,
        userEmail: socket.user.email
      });
    }
  });

  socket.on('selection-change', (data) => {
    if (data.documentId) {
      socket.to(data.documentId).emit('selection-change', {
        ...data,
        userId: socket.user.id,
        userEmail: socket.user.email
      });
    }
  });

  socket.on('leave-document', (data) => {
    console.log('🚪 User leaving document:', socket.user.email, 'Document:', data.documentId);
    
    if (data.documentId && activeUsers.has(data.documentId)) {
      const users = activeUsers.get(data.documentId);
      users.delete(socket.user.id);
      
      if (users.size === 0) {
        activeUsers.delete(data.documentId);
      } else {
        // Notify others in the room
        socket.to(data.documentId).emit('user-left', { userId: socket.user.id });
        socket.to(data.documentId).emit('active-users', Array.from(users.values()));
      }
    }
    
    socket.leave(data.documentId);
  });

  socket.on('disconnect', (reason) => {
    console.log('❌ User disconnected:', socket.user.email, 'Reason:', reason);
    
    userSockets.delete(socket.user.id);
    
    // Remove from all active documents
    activeUsers.forEach((users, documentId) => {
      if (users.has(socket.user.id)) {
        users.delete(socket.user.id);
        
        if (users.size === 0) {
          activeUsers.delete(documentId);
        } else {
          // Notify others in the document
          socket.to(documentId).emit('user-left', { userId: socket.user.id });
          socket.to(documentId).emit('active-users', Array.from(users.values()));
        }
      }
    });
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ 
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message 
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 7001;

// Initialize database and start server
const startServer = async () => {
  try {
    await initDatabase();
    
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});