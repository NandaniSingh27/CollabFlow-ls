import express from "express"
import rateLimit from "express-rate-limit"

const router = express.Router()

const MAX_CODE = 32
const MAX_NAME = 30
const MAX_PARTICIPANTS = 50
const MAX_ROOMS = 5000
const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // rooms expire after 24h of inactivity

// code -> { code, type, hostName, participants: Set<string>, lastSeen }
const rooms = new Map()

const isStr = (v, max) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max

// Remove inactive rooms every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS
  for (const [code, room] of rooms) {
    if (room.lastSeen < cutoff) rooms.delete(code)
  }
}, 10 * 60 * 1000).unref()

// Extra limit on top of the global /api limiter (stops room-code guessing)
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false
  })
)

// POST /api/rooms/create - create room
router.post("/create", (req, res) => {
  const { code, type, name } = req.body ?? {}
  if (!isStr(code, MAX_CODE) || !isStr(name, MAX_NAME)) {
    return res.status(400).json({ error: "valid code and name required" })
  }

  const cleanCode = code.trim()
  const cleanName = name.trim()

  if (rooms.has(cleanCode)) {
    return res.status(409).json({ error: "Room code already exists" })
  }
  if (rooms.size >= MAX_ROOMS) {
    return res.status(503).json({ error: "Server busy, try again later" })
  }

  const room = {
    code: cleanCode,
    type: type === "fun" ? "fun" : "professional",
    hostName: cleanName,
    participants: new Set([cleanName]),
    lastSeen: Date.now()
  }
  rooms.set(cleanCode, room)

  res.status(201).json({ code: room.code, roomType: room.type })
})

// POST /api/rooms/join - join existing
router.post("/join", (req, res) => {
  const { code, name } = req.body ?? {}
  if (!isStr(code, MAX_CODE) || !isStr(name, MAX_NAME)) {
    return res.status(400).json({ error: "valid code and name required" })
  }

  const room = rooms.get(code.trim())
  if (!room) return res.status(404).json({ error: "Room not found" })

  const cleanName = name.trim()
  if (!room.participants.has(cleanName)) {
    if (room.participants.size >= MAX_PARTICIPANTS) {
      return res.status(409).json({ error: "Room is full" })
    }
    room.participants.add(cleanName)
  }
  room.lastSeen = Date.now()

  res.json({ code: room.code, roomType: room.type })
})

export default router