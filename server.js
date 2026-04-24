import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import router from "./mainroute/index.js";
import { createServer } from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import globalErrorHandler from "./middleware/globalErrorHandler.js";
import notFound from "./middleware/notFound.js";
import { User } from "./model/user.model.js";

const app = express();

app.set("trust proxy", true);

const server = createServer(app);
export const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

export const userSocketRoom = (userId) => `user:${userId}`;

app.use(
  cors({
    credentials: true,
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/public", express.static("public"));

// Mount the main router
app.use("/api/v1", router);

// Basic route for testing
app.get("/", (req, res) => {
  res.send("Server is running...!!");
});

app.use(globalErrorHandler);
app.use(notFound);

// Socket.io
io.use(async (socket, next) => {
  try {
    const authToken =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.split(" ")[1];

    if (!authToken) {
      return next(new Error("Socket token missing"));
    }

    const decoded = jwt.verify(authToken, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(decoded._id).select(
      "name email phone role verificationInfo avatar country"
    );

    if (!user || !user.verificationInfo?.verified) {
      return next(new Error("Socket user not authorized"));
    }

    socket.user = user;
    return next();
  } catch (error) {
    return next(new Error("Invalid socket token"));
  }
});

io.on("connection", (socket) => {
  const userId = socket.user._id.toString();

  socket.join(userSocketRoom(userId));
  socket.join(userId);

  if (socket.user.role === "admin") {
    socket.join("admin");
  }

  console.log("User connected:", socket.id, userId);

  socket.on("join", () => {
    socket.join(userSocketRoom(userId));
    socket.join(userId);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  try {
    await mongoose.connect(process.env.MONGO_DB_URL);
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  }
});
