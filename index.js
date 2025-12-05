//  server.js
import express from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import http from "http";
import { Server } from "socket.io";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", //  production me specific origin dalna
    methods: ["GET", "POST"],
  },
});

// ================= FILE UPLOAD + LINK SHARE =================
const upload = multer({ dest: "tmp/" });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const linksDB = {};

app.post("/upload", upload.array("files", 50), async (req, res) => {
  try {
    const { title, duration } = req.body;
    const files = req.files;
    if (!files || files.length === 0)
      return res.status(400).json({ error: "No files uploaded" });

    const days = duration === "1 Day" ? 1 : duration === "3 Days" ? 3 : 7;
    const expireAt = Date.now() + days * 24 * 60 * 60 * 1000;

    const folderId = uuidv4();

    linksDB[folderId] = {
      title: title || "My Folder",
      expireAt,
      files: [],
    };

    for (let file of files) {
      let resourceType = "auto";
      if (file.mimetype === "application/pdf") {
        resourceType = "raw";
      }

      const result = await cloudinary.uploader.upload(file.path, {
        resource_type: resourceType,
        folder: "uploads",
      });

      fs.unlinkSync(file.path);

      linksDB[folderId].files.push({
        url: result.secure_url,
        type: file.mimetype,
        title: file.originalname,
      });
    }

    res.json({ link: `http://localhost:5000/file/${folderId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.get("/file/:id", (req, res) => {
  const data = linksDB[req.params.id];
  if (!data) return res.status(404).send("Link not found");
  if (Date.now() > data.expireAt) return res.status(410).send("Link expired");

  let content = "";
  for (let f of data.files) {
    if (f.type.startsWith("image/")) {
      content += `<div style="margin:10px;"><img src="${f.url}" alt="${f.title}" style="max-width:100%; height:auto;"></div>`;
    } else if (f.type.startsWith("video/")) {
      content += `<div style="margin:10px;"><video controls style="max-width:100%; height:auto;">
                    <source src="${f.url}" type="${f.type}">
                  </video></div>`;
    } else if (f.type.startsWith("text/") || f.type.includes("json")) {
      content += `<div style="margin:10px;"><pre style="background:#111;color:#0f0;padding:10px;border-radius:8px;overflow:auto;max-height:400px;">Loading...</pre>
                  <script>
                    fetch("${f.url}")
                      .then(res => res.text())
                      .then(txt => document.querySelectorAll("pre")[document.querySelectorAll("pre").length-1].textContent = txt)
                      .catch(()=>{});
                  </script></div>`;
    } else if (f.type === "application/pdf") {
      content += `<div style="margin:10px;"><embed src="${f.url}" type="application/pdf" width="100%" height="600px" /></div>`;
    } else {
      content += `<div style="margin:10px;"><a href="${f.url}" target="_blank">Download ${f.title}</a></div>`;
    }
  }

  res.send(`
    <html>
      <head><title>${data.title}</title></head>
      <body style="font-family:sans-serif; background:#f9f9f9; text-align:center; padding:20px;">
        <h2>${data.title}</h2>
        ${content}
      </body>
    </html>
  `);
});

// ================= SOCKET.IO CHAT =================
io.on("connection", (socket) => {
  console.log(` User Connected: ${socket.id}`);

  socket.on("join_room", (room) => {
    socket.join(room);
    console.log(`👥 User ${socket.id} joined room ${room}`);
  });

  //  Normal text/image/video message
  socket.on("send_message", (data) => {
    socket.to(data.room).emit("receive_message", data);
  });

  //  Direct file upload from chat
  socket.on("send_file", async (fileData) => {
    try {
      const tmpPath = `tmp/${uuidv4()}-${fileData.name}`;
      fs.writeFileSync(tmpPath, Buffer.from(fileData.buffer, "base64"));

      let resourceType = "auto";
      if (fileData.mimetype === "application/pdf") resourceType = "raw";

      const result = await cloudinary.uploader.upload(tmpPath, {
        resource_type: resourceType,
        folder: "chat_uploads",
      });

      fs.unlinkSync(tmpPath);

      const msg = {
        type: fileData.mimetype.startsWith("image/")
          ? "image"
          : fileData.mimetype.startsWith("video/")
          ? "video"
          : "file",
        message: result.secure_url,
        room: fileData.room,
      };

      //  Send to others
      socket.to(fileData.room).emit("receive_message", msg);
      //  Send back to self (confirmation)
      socket.emit("receive_message", { ...msg, self: true });
    } catch (err) {
      console.error("Upload error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log(" User Disconnected", socket.id);
  });
});

// ================= START SERVER =================
server.listen(5000, () =>
  console.log("🚀 Server + Socket.IO running on http://localhost:5000")
);
