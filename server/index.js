import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import { createServer } from "http"
import { Server } from "socket.io"
import roomRoutes from "./routes/rooms.js"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import helmet from "helmet"
import rateLimit from "express-rate-limit"

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const wordsData = JSON.parse(readFileSync(join(__dirname, "data", "words.json"), "utf8"))
const WORDS = Array.isArray(wordsData.easy) && wordsData.easy.length ? wordsData.easy : ["apple"]

// ---------- Config ----------
const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/+$/, "")
const PORT = process.env.PORT || 4000

const ROUND_SECONDS = 60
const NEXT_ROUND_DELAY_MS = 3000
const MAX_ROOM_USERS = 10
const MAX_ROOM_CODE = 32
const MAX_USERNAME = 30
const MAX_CHAT = 200
const MAX_IMG_CHARS = 4_500_000 // must stay below maxHttpBufferSize

const app = express()
const httpServer = createServer(app)

app.set("trust proxy", 1) // Render sits behind a proxy

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 5e6 // canvas data URLs can exceed 1 MB
})

app.use(helmet())
app.use(cors({ origin: CLIENT_URL, credentials: true }))
app.use(express.json({ limit: "100kb" }))

app.get("/health", (req, res) => res.json({ ok: true }))

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
)

app.use("/api/rooms", roomRoutes)

// Generic error handler: never leak stack traces
app.use((err, req, res, next) => {
  console.error("HTTP error:", err.message)
  if (res.headersSent) return next(err)
  res.status(500).json({ error: "Internal server error" })
})

// ---------- State ----------
const roomCanvasState = new Map()
const roomUsers = new Map()
const roomLocks = new Map()
const gameStates = new Map() // roomCode -> { word, drawer, round, scores, timeLeft, started, timerInterval, nextTimeout }

// ---------- Helpers ----------
const isStr = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max
const isNum = (v) => typeof v === "number" && Number.isFinite(v)
const isImg = (v) =>
  typeof v === "string" &&
  v.length <= MAX_IMG_CHARS &&
  /^data:image\/(png|jpeg|webp);base64,/.test(v)

const getRandomColor = () => {
  const colors = ["#EA580C", "#8B5CF6", "#16A34A", "#2563EB", "#DC2626", "#D946EF", "#0891B2"]
  return colors[Math.floor(Math.random() * colors.length)]
}

const getRandomWord = () => WORDS[Math.floor(Math.random() * WORDS.length)]

// State sent to clients (never includes timers)
const publicState = (game, word) => ({
  word,
  drawer: game.drawer,
  round: game.round,
  scores: game.scores,
  timeLeft: game.timeLeft,
  started: game.started
})

const stopGame = (roomCode) => {
  const game = gameStates.get(roomCode)
  if (game) {
    clearInterval(game.timerInterval)
    clearTimeout(game.nextTimeout)
  }
  gameStates.delete(roomCode)
}

// Starts a new round (also used for auto-next-round). Returns false if not enough players.
const startRound = (roomCode) => {
  const room = roomUsers.get(roomCode)
  if (!room || room.size < 2) return false

  const users = Array.from(room.values())
  const prev = gameStates.get(roomCode)
  if (prev) {
    clearInterval(prev.timerInterval)
    clearTimeout(prev.nextTimeout)
  }

  let nextDrawerIndex = 0
  if (prev) {
    const currentDrawerIndex = users.findIndex((u) => u.id === prev.drawer)
    nextDrawerIndex = (currentDrawerIndex + 1) % users.length
  }

  const drawer = users[nextDrawerIndex].id
  const game = {
    word: getRandomWord(),
    drawer,
    round: (prev?.round || 0) + 1,
    scores: prev?.scores || {},
    timeLeft: ROUND_SECONDS,
    started: true
  }

  users.forEach((u) => {
    if (!game.scores[u.id]) game.scores[u.id] = 0
  })

  gameStates.set(roomCode, game)

  io.to(roomCode).emit("clear-canvas")
  roomCanvasState.delete(roomCode)

  // Word only goes to the drawer
  users.forEach((u) => {
    io.to(u.id).emit("game-state", publicState(game, u.id === drawer ? game.word : null))
  })

  game.timerInterval = setInterval(() => {
    game.timeLeft--

    if (game.timeLeft <= 0) {
      clearInterval(game.timerInterval)
      game.started = false
      io.to(roomCode).emit("round-end", { word: game.word, reason: "time" })
      io.to(roomCode).emit("game-state", publicState(game, game.word))
    } else {
      io.to(roomCode).emit("timer-update", { timeLeft: game.timeLeft })
    }
  }, 1000)

  return true
}

const leaveRoom = (socket) => {
  const roomCode = socket.roomCode
  if (!roomCode) return

  const room = roomUsers.get(roomCode)
  if (room) {
    room.delete(socket.id)
    if (room.size === 0) {
      roomUsers.delete(roomCode)
      roomCanvasState.delete(roomCode)
      roomLocks.delete(roomCode)
      stopGame(roomCode)
    }
  }

  socket.leave(roomCode)
  socket.to(roomCode).emit("user-left", { id: socket.id, userName: socket.userName })
  socket.roomCode = null
}

// ---------- Sockets ----------
io.on("connection", (socket) => {
  console.log("User connected:", socket.id)

  // Wrap every handler so a bad payload can never crash the server
  const on = (event, handler) => {
    socket.on(event, (...args) => {
      try {
        handler(...args)
      } catch (err) {
        console.error(`Socket handler "${event}" failed:`, err.message)
      }
    })
  }

  let chatTimes = []
  const chatAllowed = () => {
    const now = Date.now()
    chatTimes = chatTimes.filter((t) => now - t < 5000)
    if (chatTimes.length >= 8) return false
    chatTimes.push(now)
    return true
  }

  on("join-room", (payload) => {
    let roomCode = payload?.roomCode
    let userName = payload?.userName
    if (!isStr(roomCode, MAX_ROOM_CODE) || !isStr(userName, MAX_USERNAME)) return
    roomCode = roomCode.trim()
    userName = userName.trim()

    // Switching rooms on the same socket: leave the old one first
    if (socket.roomCode && socket.roomCode !== roomCode) leaveRoom(socket)

    const existing = roomUsers.get(roomCode)
    if (existing && !existing.has(socket.id) && existing.size >= MAX_ROOM_USERS) {
      socket.emit("join-error", { message: "Room is full" })
      return
    }

    socket.join(roomCode)
    socket.roomCode = roomCode
    socket.userName = userName
    socket.userColor = socket.userColor || getRandomColor()

    if (!roomUsers.has(roomCode)) {
      roomUsers.set(roomCode, new Map())
    }
    roomUsers.get(roomCode).set(socket.id, {
      id: socket.id,
      userName,
      color: socket.userColor
    })

    console.log(`${userName} joined room ${roomCode}`)

    const canvasState = roomCanvasState.get(roomCode)
    if (canvasState) {
      socket.emit("canvas-state", canvasState)
    }

    socket.emit("users-in-room", Array.from(roomUsers.get(roomCode).values()))
    socket.emit("lock-changed", { locked: roomLocks.get(roomCode) || false })

    // Send game state if a game exists (word only if this user is the drawer)
    const game = gameStates.get(roomCode)
    if (game) {
      socket.emit("game-state", publicState(game, game.drawer === socket.id ? game.word : null))
    }

    socket.to(roomCode).emit("user-joined", {
      id: socket.id,
      userName,
      color: socket.userColor
    })
  })

  on("cursor-move", (payload) => {
    const x = payload?.x
    const y = payload?.y
    if (!socket.roomCode || !isNum(x) || !isNum(y)) return
    socket.to(socket.roomCode).emit("cursor-move", {
      id: socket.id,
      userName: socket.userName,
      color: socket.userColor,
      x,
      y
    })
  })

  on("cursor-leave", () => {
    if (!socket.roomCode) return
    socket.to(socket.roomCode).emit("cursor-leave", { id: socket.id })
  })

  on("draw", (data) => {
    if (!socket.roomCode || typeof data !== "object" || data === null) return
    socket.to(socket.roomCode).emit("draw", data)
  })

  on("canvas-state-update", (dataUrl) => {
    if (!socket.roomCode || !isImg(dataUrl)) return
    roomCanvasState.set(socket.roomCode, dataUrl)
  })

  on("clear-canvas", () => {
    if (!socket.roomCode) return
    roomCanvasState.delete(socket.roomCode)
    socket.to(socket.roomCode).emit("clear-canvas")
  })

  on("undo", (dataUrl) => {
    if (!socket.roomCode || !isImg(dataUrl)) return
    roomCanvasState.set(socket.roomCode, dataUrl)
    socket.to(socket.roomCode).emit("canvas-state", dataUrl)
  })

  on("set-lock", (payload) => {
    const locked = payload?.locked
    if (!socket.roomCode || typeof locked !== "boolean") return
    roomLocks.set(socket.roomCode, locked)
    io.to(socket.roomCode).emit("lock-changed", { locked })
  })

  on("chat-message", (payload) => {
    const raw = payload?.message
    if (!socket.roomCode || !isStr(raw, MAX_CHAT)) return
    if (!chatAllowed()) return

    const roomCode = socket.roomCode
    const message = raw.trim()
    const game = gameStates.get(roomCode)

    // Correct guess in game mode
    if (game && game.started && socket.id !== game.drawer) {
      if (message.toLowerCase() === String(game.word).toLowerCase()) {
        const points = Math.max(10, Math.floor(game.timeLeft / 2))
        game.scores[socket.id] = (game.scores[socket.id] || 0) + points

        // End the round
        clearInterval(game.timerInterval)
        game.started = false

        io.to(roomCode).emit("correct-guess", {
          userName: socket.userName,
          word: game.word,
          points
        })
        io.to(roomCode).emit("game-state", publicState(game, game.word))

        // Auto-start next round after a short delay
        game.nextTimeout = setTimeout(() => {
          const current = gameStates.get(roomCode)
          if (current !== game || current.started) return // game ended or replaced meanwhile
          startRound(roomCode)
        }, NEXT_ROUND_DELAY_MS)

        return
      }
    }

    io.to(roomCode).emit("chat-message", {
      id: Date.now(),
      userName: socket.userName,
      message,
      timestamp: new Date().toISOString(),
      type: "user"
    })
  })

  on("start-game", () => {
    const roomCode = socket.roomCode
    if (!roomCode) return

    const current = gameStates.get(roomCode)
    if (current?.started) return // a round is already running

    if (!startRound(roomCode)) {
      socket.emit("game-error", { message: "Need at least 2 players" })
    }
  })

  on("end-game", () => {
    if (!socket.roomCode) return
    stopGame(socket.roomCode)
    io.to(socket.roomCode).emit("game-ended")
  })

  socket.on("disconnect", () => {
    try {
      leaveRoom(socket)
    } catch (err) {
      console.error("Disconnect cleanup failed:", err.message)
    }
    console.log("User disconnected:", socket.id)
  })
})

// ---------- Process safety ----------
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err))
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err))

const shutdown = () => {
  console.log("Shutting down...")
  io.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})