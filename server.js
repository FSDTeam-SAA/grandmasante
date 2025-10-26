import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import router from "./mainroute/index.js";
import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios";
import globalErrorHandler from "./middleware/globalErrorHandler.js";
import notFound from "./middleware/notFound.js";
import { fetchAndBroadcastRates } from "./utils/currencyService.js";

const app = express();

app.set("trust proxy", true);

const server = createServer(app);
export const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

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
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join", (userId) => {
    socket.join(userId);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// const EXCHANGE_API_BASE = "https://api.frankfurter.dev/v1";

// const fetchAndBroadcastRates = async () => {
//   try {
//     const response = await axios.get(`${EXCHANGE_API_BASE}/latest`, {
//       params: {
//         base: "USD",
//         symbols: "EUR,GBP,JPY,AUD,DKK,NOK",
//       },
//     });
//     const rates = response.data.rates;
//     io.emit("currencyUpdate", {
//       base: response.data.base,
//       date: new Date(response.data.date),
//       rates,
//     });
//   } catch (error) {
//     console.error(
//       "Currency fetch error:",
//       error.response?.data || error.message
//     );
//   }
// };

// Initial fetch and interval
// Initialize rates when server starts
await fetchAndBroadcastRates(io);
// Update rates every 5 minutes
setInterval(async () => {
  await fetchAndBroadcastRates(io);
}, 2 * 60 * 1000);

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
